import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { quickjsPair, sharedQuickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { ENGINE_SECTION } from "../src/engine-kind.ts";
import { hash } from "./guest-source-manifest.ts";
import { hermesConsumerReceipt, workerProofLabels } from "./producer-closure.ts";

const repository = join(import.meta.dir, "..");
const source = `import {execFileSync} from "node:child_process";
export const hash=(bytes)=>new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const identity=()=>({head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),tree:execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim()});
export const sourceOptions=(repository,sysroot,build)=>({repository,sysroot,build,tools:{cargo:repository+"/scripts/native-cargo.sh",rustc:"/synthetic/rustc"}});`;
const coreReceipt = `import {hash,identity} from "./guest-source-manifest.ts";
export const captureProgramInputs=async(o,scope,selection,profile="split")=>{const content={selection:selection??{kind:scope,...(profile==="shared-group"?{profile}:{})}};return {schema:1,scope,source:identity(),content,contentSha256:hash(JSON.stringify(content))};};
export const parseProgramInputs=value=>value;
export const verifyProgramReceipt=(bytes,value,expected)=>{if(value.inputs.contentSha256!==expected.contentSha256||value.artifact.artifactSha256!==hash(bytes))throw Error("synthetic original receipt mismatch");return value;};`;
const guestReceipt = `import {readFileSync,writeFileSync} from "node:fs";import {dirname,join} from "node:path";import {hash,identity} from "./guest-source-manifest.ts";import {programProfile,programKind} from "../src/engine-kind.ts";
export const prepareGuestBuildInputs=async(o,profile)=>({sourceManifest:{build:o.build,source:identity()},...(profile==="shared-group"?{profile}:{})});
export const writeGuestBuildReceipt=async(o,path,inputs)=>{const side=programProfile(o.build).side;const receipt={...inputs,program:{kind:o.build,core:{sha:hash(readFileSync(path))},side:{sha:hash(readFileSync(join(dirname(path),side)))}},engineOrigin:JSON.parse(readFileSync(join(dirname(path),side+".engine.json"),"utf8"))};writeFileSync(path+".build.json",JSON.stringify(receipt));return receipt;};
export const verifyGuestBuildReceipt=(bytes,value)=>{if(value.program.core.sha!==hash(bytes)||programKind(new WebAssembly.Module(bytes))!==value.program.kind)throw Error("synthetic guest mismatch");};
export const verifyGuestCompanions=async(value,dir)=>{if(hash(readFileSync(join(dir,programProfile(value.program.kind).side)))!==value.program.side.sha)throw Error("synthetic companion mismatch");};`;
const recipe = `import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from "node:fs";import {join} from "node:path";import {captureProgramInputs} from "./guest-core-receipt.ts";import {sourceOptions,hash} from "./guest-source-manifest.ts";
const kind=process.argv[2], root=process.cwd(), data=JSON.parse(readFileSync("assets.json","utf8")), profile=process.env.QUICKJS_PROFILE;
appendFileSync(process.env.FIXTURE_LOG,kind+":"+profile+"\\n");
const out=kind==="core"?process.env.BUN_CORE_BUILD_DIR:process.env[kind==="quickjs"?"QUICKJS_BUILD_DIR":kind==="jsc"?"JSC_ENGINE_BUILD_DIR":"HERMES_ENGINE_BUILD_DIR"];
mkdirSync(out,{recursive:true});const path=join(out,kind==="core"?"bun-core.wasm":"engine.wasm");const bytes=Buffer.from(kind==="core"?data[profile].core:data[profile][kind],"base64");writeFileSync(path,bytes);
const inputs=await captureProgramInputs(sourceOptions(root,"/fixture",kind),kind,kind==="core"?{features:["engine-split","bun-transpiler","bun-build"],...(profile==="shared-group"?{profile}:{})}:undefined,profile);
writeFileSync(path+(kind==="core"?".core.json":".engine.json"),JSON.stringify({schema:1,inputs,artifact:{artifactSha256:hash(bytes),artifactBytes:bytes.length}}));
if(kind==="core"){writeFileSync(join(out,"core-dependencies.txt"),"synthetic VM-free core");writeFileSync(join(out,"cxx-runtime-members.json"),"[]");}`;

function fixture(run: (root: string, output: string, invoke: (command: string, profile?: string, overrides?: Record<string, string>) => ReturnType<typeof Bun.spawnSync>) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "producer-registry-"));
  const root = join(scratch, "source"); const output = join(scratch, "out");
  const put = (path: string, text: string, mode = 0o600) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text, { mode }); };
  try {
    for (const path of ["scripts/engine-producer.ts", "scripts/producer-closure.ts", "scripts/src/program-profile.ts", "src/engine-kind.ts"]) { mkdirSync(join(root, path, ".."), { recursive: true }); copyFileSync(join(repository, path), join(root, path)); }
    put("scripts/guest-source-manifest.ts", source); put("scripts/guest-core-receipt.ts", coreReceipt); put("scripts/guest-build-receipt.ts", guestReceipt); put("scripts/stub-recipe.ts", recipe);
    const strip = (core: Uint8Array) => Buffer.from(core.subarray(0, core.length - 3 - ENGINE_SECTION.length - "quickjs".length)).toString("base64");
    const group = sharedQuickjsPair();
    put("assets.json", JSON.stringify({ split: { core: strip(quickjsPair().core), ...Object.fromEntries(["quickjs", "jsc", "hermes"].map(kind => [kind, Buffer.from(quickjsPair(kind === "jsc" ? "jsc" : kind === "hermes" ? "hermes" : "quickjs").side).toString("base64")])) }, "shared-group": { core: strip(group.core), quickjs: Buffer.from(group.side).toString("base64") } }));
    for (const kind of ["core", "quickjs", "jsc", "hermes"]) put(`scripts/build-${kind === "core" ? "bun-core" : `engine-${kind}`}.sh`, `#!/bin/sh\nexec "$BUN_EXE" "${root}/scripts/stub-recipe.ts" ${kind}\n`, 0o700);
    put("scripts/jsc-embedding.ts", 'import {writeFileSync} from "node:fs";if(process.argv[2]==="inputs")console.log("fixture");else writeFileSync(process.argv[3]+".embedding.json","synthetic");');
    put("scripts/bash-web-guests.ts", 'export const pinnedBashWeb=()=>({});export const verifiedGuests=()=>true;');
    put("scripts/engine-memory-hook.test.ts", 'import {test} from "bun:test";test("synthetic boundary",()=>{});'); put("web/tests/bun-executor.test.ts", 'import {test} from "bun:test";test("synthetic boundary",()=>{});');
    put("web/scripts/node-host.ts", 'console.log("paired-smoke 42");');
    put("scripts/verify-engine-memory-browser.ts", 'import {writeFileSync} from "node:fs";if(process.env.FAIL_GATE)throw Error("synthetic downstream gate failed");writeFileSync(process.argv[2]+"/hook-smoke.json","synthetic, no browser");');
    put("web/build.ts", 'import {readFileSync,writeFileSync,mkdirSync} from "node:fs";import {dirname} from "node:path";const dir=dirname(process.env.BUN_WASM);const names=["bun.wasm","quickjs.wasm","bun-jsc.wasm","jsc-engine.wasm","bun-hermes.wasm","hermes-engine.wasm"];mkdirSync("web/dist",{recursive:true});writeFileSync("web/dist/index.html","synthetic");writeFileSync("web/dist/engine-builds.json",JSON.stringify(Object.fromEntries(names.map(name=>[name,new Bun.CryptoHasher("sha256").update(readFileSync(dir+"/"+name)).digest("hex")]))));');
    const pass = workerProofLabels.map(label => `PASS ${label}`).join("\n");
    put("scripts/native-cargo.sh", `#!/bin/sh\nprintf 'launcher\\n' >> "$FIXTURE_LOG"\nmkdir -p "$CARGO_TARGET_DIR/release"\ncp "${root}/scripts/launcher-fixture.sh" "$CARGO_TARGET_DIR/release/bun-wasm"\n`, 0o700);
    put("scripts/launcher-fixture.sh", `#!/bin/sh\ncase "$*" in *worker-alias.ts*) cat <<'PROOF'\n${pass}\nPROOF\n;; *) echo 'paired-smoke 42';; esac\n`, 0o700);
    put("tests/shared-group/worker-alias.ts", "// Synthetic fixture: never executed by these routing tests.\n"); put("crates/bunwasm-hermes/cpp/shim.cpp", '#include "memory-telemetry.h"\n'); put("crates/bunwasm-hermes/cpp/memory-telemetry.h", "header fixture");
    put(".gitignore", "dist/\nweb/dist/\n");
    execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic source"], { cwd: root });
    const native = join(scratch, "native"); mkdirSync(join(native, "wasi/lib"), { recursive: true }); writeFileSync(join(native, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    const dependencies = ["shim.cpp", "memory-telemetry.h"].map(name => join(root, "crates/bunwasm-hermes/cpp", name));
    writeFileSync(join(native, "wasi/shim-dependencies.txt"), `shim.cpp.o: #deps 2, deps mtime 1 (VALID)\n${dependencies.map(path => `    ${path}`).join("\n")}\n\n`);
    const nativeReceipt = join(scratch, "vm.json"); writeFileSync(nativeReceipt, JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, ...hermesConsumerReceipt(root, native) }));
    const shell = join(scratch, "shell"); mkdirSync(shell); for (const name of ["bash-web-shell.wasm", "bash-web-env.wasm", "bash-web-guests.json"]) writeFileSync(join(shell, name), "synthetic");
    const log = join(scratch, "commands.log");
    const invoke = (command: string, profile = "split", overrides: Record<string, string> = {}) => Bun.spawnSync([process.execPath, join(root, "scripts/engine-producer.ts"), command, profile], { cwd: root, env: { ...process.env, BUN_EXE: process.execPath, BUN_WASM_ENGINE_ROOT: output, BUN_WASM_SYSROOT: "/fixture", BUN_WASM_SHARED_SYSROOT: "/fixture", HERMES_BUILD_DIR: native, HERMES_VM_RECEIPT: nativeReceipt, BASH_WEB_GUESTS_DIR: shell, FIXTURE_LOG: log, ...overrides } });
    run(root, output, invoke);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("canonical split producer routes one core then three sides and records tested launcher, originals and complete closure", () => {
  fixture((_root, output, invoke) => {
    const built = invoke("build"); expect(built.exitCode, built.stderr?.toString()).toBe(0);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(manifest.engines).toEqual(["quickjs", "jsc", "hermes"]);
    expect(manifest.inputOrigins.map((input: {scope: string}) => input.scope)).toEqual(["core", "quickjs", "jsc", "hermes"]);
    const original = readFileSync(join(output, "hermes/engine.wasm.engine.json"), "utf8");
    expect(readFileSync(join(output, "dist/hermes-engine.wasm.engine.json"), "utf8")).toBe(original);
    expect(manifest.launcher.artifact.sha256).toBe(hash(readFileSync(join(output, "launcher/bun-wasm"))));
    expect(invoke("verify").exitCode).toBe(0);
    expect(invoke("build").exitCode).toBe(0);
    const commands = readFileSync(join(output, "../commands.log"), "utf8");
    expect(commands.split("\n").filter(line => line.startsWith("core:"))).toEqual(["core:split"]);
    expect(commands.match(/launcher/g)?.length).toBe(1);
    const state = readFileSync(join(output, "state.json"), "utf8");
    const path = join(output, "manifest.json");
    const originalManifest = readFileSync(path, "utf8");
    manifest.files = manifest.files.filter((file: {path: string}) => file.path !== "dist/hermes-engine.wasm.engine.json");
    writeFileSync(path, JSON.stringify(manifest));
    expect(invoke("verify").exitCode).not.toBe(0);
    writeFileSync(path, originalManifest);
    writeFileSync(join(output, "dist/hermes-engine.wasm"), "corrupt");
    expect(invoke("verify").exitCode).not.toBe(0);
    expect(readFileSync(join(output, "state.json"), "utf8")).toBe(state);
  });
});

test.each(["shim.cpp", "memory-telemetry.h"])("a changed native %s refuses the prior VM generation before any recipe", name => {
  fixture((root, output, invoke) => {
    writeFileSync(join(root, "crates/bunwasm-hermes/cpp", name), "future changed heap input");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "changed shim"], { cwd: root });
    const result = invoke("build");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("new matching native generation");
    expect(existsSync(join(output, "../commands.log"))).toBe(false);
    expect(existsSync(join(output, "manifest.json"))).toBe(false);
    expect(existsSync(join(output, ".producer-lock"))).toBe(false);
  });
});

test("canonical shared producer uses explicit profile and only QuickJS, keeps split artifacts out", () => {
  fixture((_root, output, invoke) => {
    const result = invoke("build", "shared-group"); expect(result.exitCode, result.stderr?.toString()).toBe(0);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(manifest.profile).toBe("shared-group"); expect(manifest.engines).toEqual(["quickjs"]);
    expect(manifest.files.some((file: {path: string}) => /hermes|jsc|web\//.test(file.path))).toBe(false);
    expect(invoke("verify", "shared-group").exitCode).toBe(0);
    expect(invoke("verify", "split").exitCode).not.toBe(0);
  });
});

test("a downstream qualification failure leaves no reusable manifest and releases its producer lock", () => {
  fixture((_root, output, invoke) => {
    const result = invoke("build", "split", { FAIL_GATE: "1" }); expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(output, "manifest.json"))).toBe(false);
    expect(existsSync(join(output, ".producer-lock"))).toBe(false);
    expect(readFileSync(join(output, "state.json"), "utf8")).toContain("failed");
  });
});
