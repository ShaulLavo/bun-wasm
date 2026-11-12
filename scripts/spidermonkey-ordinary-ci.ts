import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nativeInputs, pin } from "../spidermonkey/native-profile.ts";
import { prepareFreshEngineInputs, verifyEngineInputs } from "../spidermonkey/prepare-engine-inputs.ts";
import { verifySplitSysroot } from "./src/program-profile.ts";

const repository = resolve(import.meta.dir, "..");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileIdentity = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const execute = (command: string, args: string[], env = process.env) => execFileSync(command, args, { cwd: repository, env, stdio: "inherit" });

function required(env: NodeJS.ProcessEnv, key: string): string {
  const path = env[key];
  assert(path && resolve(path) === path, `Set absolute ${key}`);
  return path;
}

export function directoryIdentity(root: string) {
  const paths = directoryFiles(root).sort();
  return paths.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }));
}

function directoryFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const path = join(prefix, name);
    return statSync(join(root, path)).isDirectory() ? directoryFiles(root, path) : [path];
  });
}

export function ordinaryToolVersions(version = output) {
  // Git fetches the pinned revision; its version cannot change the compiled inputs.
  return ["/usr/bin/clang", "/usr/bin/clang++", "rustc", "cargo", "llvm-readobj", "python3", "autoconf2.13", "make"]
    .map(tool => ({ tool, version: version(tool, tool === "rustc" ? ["-vV"] : ["--version"]) }));
}

export function ordinaryNativeIdentity(env = process.env) {
  const sdk = required(env, "WASI_SDK_PATH");
  const sysroot = required(env, "BUN_WASM_SYSROOT");
  const cargo = required(env, "CARGO_HOME");
  verifySplitSysroot(sysroot);
  assert.equal(output(join(cargo, "bin/cbindgen"), ["--version"]), "cbindgen 0.29.4");
  const noeh = ["libc++.a", "libc++abi.a"].map(name => fileIdentity(join(sysroot, "lib/wasm32-wasip1/noeh", name)));
  const recipes = ["env.sh", "rust-toolchain.toml", "spidermonkey/unresolved-symbols.json", "scripts/spidermonkey-ordinary-ci.ts"];
  const tools = ["clang", "clang++", "clang++.cfg", "llvm-ar", "llvm-nm", "wasm-ld"].map(name => fileIdentity(join(sdk, "bin", name)))
    .concat([fileIdentity(join(cargo, "bin/cbindgen"))]);
  const versions = ordinaryToolVersions();
  return { schema: 1, profile: "split", mozillaRevision: pin, native: nativeInputs(), recipes: recipes.map(path => fileIdentity(join(repository, path))),
    sdk: tools, sysroot: { path: sysroot, files: directoryIdentity(sysroot) }, noeh, versions };
}

export function nativeGeneration(identity: unknown): string {
  return hash(JSON.stringify(identity));
}

export function assertNativeGeneration(build: string, identity: unknown): void {
  assert.deepEqual(JSON.parse(readFileSync(join(build, "ordinary-generation.json"), "utf8")), identity, "Ordinary native generation changed");
}

export function produceOrdinaryNative(build: string, identity: ReturnType<typeof ordinaryNativeIdentity>): void {
  const receipt = join(build, "receipt/vm-library.json");
  if (existsSync(receipt)) {
    assertNativeGeneration(build, identity);
    execute("node", ["spidermonkey/check-build.ts", build, "--verify"]);
    process.stdout.write(`ordinary SpiderMonkey verified native cache hit ${nativeGeneration(identity)}\n`);
    return;
  }
  assert(!existsSync(join(build, "obj/config.status")), "Incomplete cached native configuration; use a fresh generation");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "ordinary-generation.json"), JSON.stringify(identity, null, 2) + "\n", { flag: "wx" });
  const firefox = join(build, "firefox");
  if (!existsSync(join(firefox, ".git"))) {
    execute("git", ["init", "-q", firefox]);
    execute("git", ["-C", firefox, "remote", "add", "origin", "https://github.com/mozilla-firefox/firefox.git"]);
  }
  execute("git", ["-C", firefox, "config", "remote.origin.promisor", "true"]);
  execute("git", ["-C", firefox, "config", "remote.origin.partialclonefilter", "blob:none"]);
  const python = join(dirname(build), "ordinary-python");
  try {
    execute("python3", ["-m", "venv", "--clear", "--without-pip", python]);
    execute("bash", ["spidermonkey/build.sh"], { ...process.env, SPIDERMONKEY_BUILD_DIR: build, PATH: `${python}/bin:${process.env.PATH}`, JOBS: "2", CAGE: "" });
  } finally {
    rmSync(python, { recursive: true, force: true });
  }
  execute("node", ["spidermonkey/check-build.ts", build, "--verify"]);
  process.stdout.write(`ordinary SpiderMonkey cold native build ${nativeGeneration(identity)}\n`);
}

export function sideCargoGeneration(native: string, identity: unknown): string {
  verifyEngineInputs(native);
  return hash(JSON.stringify({ identity, inputs: fileIdentity(join(native, "native-inputs.json")) }));
}

export function exportOrdinaryProgram(pair: string, native: string, build: string, target: string): void {
  verifyEngineInputs(native);
  execute("bun", ["scripts/spidermonkey-side-core-receipt.ts", "verify-pair", join(pair, "bun-spidermonkey.wasm"), join(pair, "spidermonkey-engine.wasm"), join(pair, "bun-spidermonkey.wasm.spidermonkey.json"), join(pair, "inputs.json")]);
  assert(!existsSync(target), "Ordinary export directory already exists");
  mkdirSync(target, { recursive: true });
  for (const name of ["bun-spidermonkey.wasm", "spidermonkey-engine.wasm", "bun-spidermonkey.wasm.spidermonkey.json", "inputs.json", "bun-core.wasm.core.json"]) copyFileSync(join(pair, name), join(target, name));
  mkdirSync(join(target, "native-identity"));
  for (const name of ["native-inputs.json", "fresh-library.json", "native-profile.json", "headers.json"]) copyFileSync(join(native, name), join(target, "native-identity", name));
  copyFileSync(join(build, "ordinary-generation.json"), join(target, "native-identity/ordinary-generation.json"));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "identity") process.stdout.write(nativeGeneration(ordinaryNativeIdentity()) + "\n");
  else if (command === "native") {
    const build = required(process.env, "SPIDERMONKEY_BUILD_DIR");
    const native = required(process.env, "SPIDERMONKEY_NATIVE_DIR");
    const identity = ordinaryNativeIdentity();
    produceOrdinaryNative(build, identity);
    prepareFreshEngineInputs(build, native);
    const generation = sideCargoGeneration(native, identity);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `generation=${generation}\n`);
    process.stdout.write(`ordinary SpiderMonkey side generation ${generation}\n`);
  }
  else if (command === "export") {
    assert(args[0], "Set the ordinary artifact destination");
    exportOrdinaryProgram(required(process.env, "SPIDERMONKEY_PAIR_DIR"), required(process.env, "SPIDERMONKEY_NATIVE_DIR"), required(process.env, "SPIDERMONKEY_BUILD_DIR"), resolve(args[0]));
  } else throw new Error("Usage: spidermonkey-ordinary-ci.ts identity|native|export [DESTINATION]");
}
