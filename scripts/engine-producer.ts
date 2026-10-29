import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureProgramInputs, parseProgramInputs, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt.ts";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, verifyGuestCompanions, writeGuestBuildReceipt } from "./guest-build-receipt.ts";
import { hash, sourceOptions } from "./guest-source-manifest.ts";
import { programProfile, tagProgramCore, type PairedEngine } from "../src/engine-kind.ts";
import { pinnedBashWeb, verifiedGuests } from "./bash-web-guests.ts";

const repository = resolve(import.meta.dir, "..");
const output = resolve(process.env.BUN_WASM_ENGINE_ROOT ?? "/work/tmp/bun-wasm-wave1029-engines-current");
const sysroot = process.env.BUN_WASM_SYSROOT;
if (!sysroot) throw new Error("Source env.sh before running the producer");
const prebuild = resolve(process.env.JSC_BUILD_DIR ?? join(output, "native-jsc"));
const environment = { ...process.env, JSC_BUILD_DIR: prebuild, BUN_CORE_BUILD_DIR: join(output, "core"),
  QUICKJS_BUILD_DIR: join(output, "quickjs"), JSC_ENGINE_BUILD_DIR: join(output, "jsc"), CARGO_BUILD_JOBS: "2" };
process.env.JSC_BUILD_DIR = prebuild;
const scopes = ["core", "quickjs", "jsc"] as const;
const selection = { features: ["engine-split", "bun-transpiler", "bun-build"] };
const [command] = process.argv.slice(2);

function recipe(script: string): void {
  execFileSync("bash", [join(repository, script)], { cwd: repository, env: environment, stdio: "inherit" });
}
function state(phase: string, detail?: string): void {
  writeFileSync(join(output, "state.json"), JSON.stringify({ phase, detail, time: new Date().toISOString() }, null, 2) + "\n");
}
function sourceIdentity() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Producer source must be committed and clean");
  return { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}
async function inputs(): Promise<ProgramInputSnapshot[]> {
  const captured: ProgramInputSnapshot[] = [];
  for (const scope of scopes) captured.push(await captureProgramInputs(sourceOptions(repository, sysroot!, scope === "core" ? "browser" : scope), scope, scope === "core" ? selection : undefined));
  return captured;
}
function lockedInputs(current: readonly ProgramInputSnapshot[]): void {
  const path = join(output, "inputs/programs.json");
  const json = JSON.stringify(current, null, 2) + "\n";
  if (!existsSync(path)) { writeFileSync(path, json); return; }
  const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(previous) || previous.length !== current.length) throw new Error("Invalid canonical input snapshot");
  const origins = previous.map(value => parseProgramInputs(value));
  if (origins.some((origin, index) => origin.scope !== current[index]?.scope || origin.contentSha256 !== current[index]?.contentSha256)) {
    throw new Error("Canonical producer inputs changed. Existing outputs are not reusable; do not relabel them.");
  }
}
async function verifyPrograms(current: readonly ProgramInputSnapshot[]): Promise<void> {
  for (const [index, scope] of scopes.entries()) {
    const path = join(output, scope, scope === "core" ? "bun-core.wasm" : "engine.wasm");
    verifyProgramReceipt(await Bun.file(path).bytes(), await Bun.file(`${path}.${scope === "core" ? "core" : "engine"}.json`).json(), current[index]!);
  }
  for (const engine of ["quickjs", "jsc"] as const) {
    const path = join(output, "dist", programProfile(engine).core);
    const receipt: unknown = await Bun.file(`${path}.build.json`).json();
    verifyGuestBuildReceipt(await Bun.file(path).bytes(), receipt);
    await verifyGuestCompanions(receipt, join(output, "dist"));
  }
}
async function compose(engine: PairedEngine): Promise<void> {
  const profile = programProfile(engine);
  const options = sourceOptions(repository, sysroot!, engine);
  const captured = await prepareGuestBuildInputs(options);
  const core = await Bun.file(join(output, "core/bun-core.wasm")).bytes();
  const path = join(output, "dist", profile.core);
  await Bun.write(path, tagProgramCore(core, engine));
  copyFileSync(join(output, engine, "engine.wasm"), join(output, "dist", profile.side));
  copyFileSync(join(output, engine, "engine.wasm.engine.json"), join(output, "dist", `${profile.side}.engine.json`));
  await writeGuestBuildReceipt(options, path, captured);
  if (engine === "jsc") {
    const snapshot = execFileSync(process.execPath, [join(repository, "scripts/jsc-embedding.ts"), "inputs"], { cwd: repository, env: environment, encoding: "utf8" }).trim();
    execFileSync(process.execPath, [join(repository, "scripts/jsc-embedding.ts"), "write", path, snapshot], { cwd: repository, env: environment, stdio: "inherit" });
  }
}
function programSmoke(): void {
  const text = 'console.log("paired-smoke",40+2); const before=process.memoryUsage(); globalThis.bytes=new Uint8Array(1048576); const after=process.memoryUsage(); console.log(JSON.stringify({before,after}));';
  for (const engine of ["quickjs", "jsc"] as const) {
    const run = spawnSync("node", ["--no-warnings", join(repository, "web/scripts/node-host.mjs"), "--wasm", join(output, "dist", programProfile(engine).core), "--", "-e", text], {
      cwd: repository, env: { ...environment, BUN_WASM_SCRATCH_ROOT: join(output, "smoke-tmp") }, encoding: "utf8", timeout: 120000,
    });
    writeFileSync(join(output, `${engine}-smoke.log`), run.stdout + run.stderr);
    if (run.error) throw run.error;
    if (run.status !== 0 || !run.stdout.includes("paired-smoke 42")) throw new Error(`${engine} paired program smoke failed; see ${engine}-smoke.log`);
  }
}
function stageShell(): void {
  const source = process.env.BASH_WEB_GUESTS_DIR;
  if (!source) throw new Error("Set BASH_WEB_GUESTS_DIR to qualified pinned shell guests for the consumer web root");
  const guests = verifiedGuests(resolve(source), pinnedBashWeb(join(repository, "web")));
  if (!guests) throw new Error("Qualified shell guests are missing");
  for (const file of ["bash-web-shell.wasm", "bash-web-env.wasm", "bash-web-guests.json"]) copyFileSync(join(source, file), join(output, "dist", file));
}
function webBuild(): void {
  execFileSync(process.execPath, [join(repository, "web/build.ts")], { cwd: repository, stdio: "inherit", env: {
    ...environment, BUN_WASM: join(output, "dist/bun.wasm"), JSC_WASM: join(output, "dist/bun-jsc.wasm"),
    BASH_WEB_GUESTS_DIR: join(output, "dist"), BASH_WEB_GUESTS: "required",
  } });
}
function webFiles(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? webFiles(join(directory, entry.name), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`]);
}
async function identities(paths: readonly string[]) {
  return Promise.all(paths.map(async path => {
    const bytes = await Bun.file(join(output, path)).bytes();
    return { path, bytes: bytes.byteLength, sha256: hash(bytes) };
  }));
}
async function build(): Promise<void> {
  mkdirSync(join(output, "inputs"), { recursive: true });
  mkdirSync(join(output, "dist"), { recursive: true });
  mkdirSync(join(output, "smoke-tmp"), { recursive: true });
  if (existsSync(join(output, "manifest.json"))) { await verify(); return; }
  const source = sourceIdentity();
  state("checking-inputs");
  const current = await inputs();
  lockedInputs(current);
  state("building-core"); recipe("scripts/build-bun-core.sh");
  state("building-quickjs"); recipe("scripts/build-engine-quickjs.sh");
  state("building-jsc"); recipe("scripts/build-engine-jsc.sh");
  state("composing"); await compose("quickjs"); await compose("jsc");
  await verifyPrograms(current);
  if (JSON.stringify(await inputs()) !== JSON.stringify(current)) throw new Error("Producer inputs changed during production");
  state("program-smoke"); programSmoke();
  stageShell();
  state("web-build"); webBuild();
  rmSync(join(output, "web"), { recursive: true, force: true });
  cpSync(join(repository, "web/dist"), join(output, "web"), { recursive: true });
  state("hook-controls");
  const controls = execFileSync(process.execPath, ["test", "./scripts/engine-memory-hook.test.ts", "./web/tests/bun-executor.test.ts"], { cwd: repository, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(output, "hook-controls.log"), controls);
  state("hook-smoke");
  execFileSync(process.execPath, [join(repository, "scripts/verify-engine-memory-browser.ts"), output], { cwd: repository, env: environment, stdio: "inherit" });
  if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error("Producer source changed during validation");
  const files = await identities(["core/bun-core.wasm", "core/bun-core.wasm.core.json", "quickjs/engine.wasm", "quickjs/engine.wasm.engine.json", "jsc/engine.wasm", "jsc/engine.wasm.engine.json", "dist/bun.wasm", "dist/bun.wasm.build.json", "dist/quickjs.wasm", "dist/quickjs.wasm.engine.json", "dist/bun-jsc.wasm", "dist/bun-jsc.wasm.build.json", "dist/bun-jsc.wasm.embedding.json", "dist/jsc-engine.wasm", "dist/jsc-engine.wasm.engine.json", "dist/bash-web-shell.wasm", "dist/bash-web-env.wasm", "dist/bash-web-guests.json", "hook-smoke.json", "hook-controls.log"].concat(webFiles(join(output, "web"), "web")));
  writeFileSync(join(output, "manifest.json"), JSON.stringify({ schema: 1, status: "reusable", source, nativePrebuild: prebuild,
    inputs: current.map(input => ({ scope: input.scope, contentSha256: input.contentSha256 })),
    inputOrigins: JSON.parse(readFileSync(join(output, "inputs/programs.json"), "utf8")), files,
    webRoot: join(output, "web"), hook: join(repository, "scripts/app-matrix/engine-memory-hook.ts"),
    engineBuilds: JSON.parse(readFileSync(join(output, "web/engine-builds.json"), "utf8")),
  }, null, 2) + "\n");
  state("reusable");
}
async function verify(): Promise<void> {
  const value: unknown = await Bun.file(join(output, "manifest.json")).json();
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== "reusable" || !("files" in value) || !Array.isArray(value.files)) throw new Error("Producer is not reusable");
  if (!("source" in value) || JSON.stringify(value.source) !== JSON.stringify(sourceIdentity())) throw new Error("Producer source identity differs from its manifest");
  for (const file of value.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").includes("..") || typeof file.sha256 !== "string" || typeof file.bytes !== "number") throw new Error("Invalid manifest artifact");
    const bytes = await Bun.file(join(output, file.path)).bytes();
    if (hash(bytes) !== file.sha256 || bytes.byteLength !== file.bytes) throw new Error(`Changed artifact ${file.path}`);
  }
  const current = await inputs();
  lockedInputs(current);
  await verifyPrograms(current);
  console.log(`Verified reusable producer ${output}`);
}
if (import.meta.main) {
  if (command !== "build" && command !== "verify") throw new Error("Usage: engine-producer.ts build|verify");
  mkdirSync(output, { recursive: true });
  const lock = join(output, ".producer-lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, repository, command }));
  try { if (command === "build") await build(); else await verify(); }
  catch (error) { state("failed", String(error)); throw error; }
  finally { rmSync(lock, { recursive: true }); }
}
