import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureProgramInputs, parseProgramInputs, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt.ts";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, verifyGuestCompanions, writeGuestBuildReceipt } from "./guest-build-receipt.ts";
import { hash, sourceOptions } from "./guest-source-manifest.ts";
import { programProfile, tagProgramCore, type PairedEngine } from "../src/engine-kind.ts";
import { pinnedBashWeb, verifiedGuests } from "./bash-web-guests.ts";
import { parseProgramProfile, sharedGroupEnvironment } from "./src/program-profile.ts";
import { launcherReceipt, producerArtifactPaths, producerEngines, producerScopes, producerSelection, requireClosureFiles, rejectWithdrawnPublicationPath, verifyPublicationBuilds, verifyLauncher, verifyWorkerProof, type ProducerSource } from "./producer-closure.ts";

const repository = resolve(import.meta.dir, "..");
const [command, selectedProfile, ...extra] = process.argv.slice(2);
const profile = parseProgramProfile(selectedProfile);
if (extra.length) throw new Error("Usage: engine-producer.ts build|verify [split|shared-group]");
if (!process.env.BUN_WASM_ENGINE_ROOT) throw new Error("Set an explicit BUN_WASM_ENGINE_ROOT; never select a frozen closure implicitly");
const output = resolve(process.env.BUN_WASM_ENGINE_ROOT);
const sysroot = process.env.BUN_WASM_SYSROOT;
if (!sysroot) throw new Error("Source env.sh before running the producer");
if (process.env.BUN_WASM_PROGRAM_PROFILE && parseProgramProfile(process.env.BUN_WASM_PROGRAM_PROFILE) !== profile) throw new Error("Producer profile differs from build environment");
if (profile === "shared-group") {
  if (process.env.BUN_WASM_SHARED_SYSROOT !== sysroot) throw new Error("Shared producer requires the explicit J2 shared sysroot");
  Object.assign(process.env, sharedGroupEnvironment(sysroot, "quickjs"));
}
const engines = producerEngines(profile);
const scopes = producerScopes(profile);
const selection = producerSelection(profile);
const manifestPath = join(output, "manifest.json");
const recorded: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
function recordedPath(key: string): string | undefined {
  if (!recorded || typeof recorded !== "object" || !(key in recorded)) return;
  const value: unknown = Reflect.get(recorded, key);
  return typeof value === "string" ? value : undefined;
}
const prebuild = resolve(process.env.JSC_BUILD_DIR ?? recordedPath("nativePrebuild") ?? join(output, "native-jsc"));
const environment = { ...process.env, JSC_BUILD_DIR: prebuild, BUN_CORE_BUILD_DIR: join(output, "core"),
  QUICKJS_BUILD_DIR: join(output, "quickjs"), JSC_ENGINE_BUILD_DIR: join(output, "jsc"),
  QUICKJS_PROFILE: profile, CARGO_BUILD_JOBS: "2", JOBS: "2" };
process.env.JSC_BUILD_DIR = prebuild;
const launcher = join(output, "launcher/bun-wasm");
const launcherProof = `${launcher}.launcher.json`;
function recipe(script: string, args: string[] = []): void {
  execFileSync("bash", [join(repository, script)].concat(args), { cwd: repository, env: environment, stdio: "inherit" });
}
function state(phase: string, detail?: string): void {
  writeFileSync(join(output, "state.json"), JSON.stringify({ phase, detail, time: new Date().toISOString() }, null, 2) + "\n");
}
function sourceIdentity(): ProducerSource {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Producer source must be committed and clean");
  return { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}
async function inputs(): Promise<ProgramInputSnapshot[]> {
  const captured: ProgramInputSnapshot[] = [];
  for (const scope of scopes) captured.push(await captureProgramInputs(sourceOptions(repository, sysroot!, scope === "core" ? "browser" : scope), scope, scope === "core" ? selection : undefined, profile));
  return captured;
}
function lockedInputs(current: readonly ProgramInputSnapshot[]): void {
  const path = join(output, "inputs/programs.json");
  if (!existsSync(path)) { writeFileSync(path, JSON.stringify(current, null, 2) + "\n"); return; }
  const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(previous) || previous.length !== current.length) throw new Error("Invalid canonical input snapshot");
  const origins = previous.map(value => parseProgramInputs(value));
  if (origins.some((origin, index) => origin.scope !== current[index]?.scope || origin.contentSha256 !== current[index]?.contentSha256)) throw new Error("Canonical producer inputs changed. Existing outputs are not reusable; do not relabel them.");
}
async function verifyPrograms(current: readonly ProgramInputSnapshot[]): Promise<void> {
  for (const [index, scope] of scopes.entries()) {
    const path = join(output, scope, scope === "core" ? "bun-core.wasm" : "engine.wasm");
    verifyProgramReceipt(await Bun.file(path).bytes(), await Bun.file(`${path}.${scope === "core" ? "core" : "engine"}.json`).json(), current[index]!);
  }
  for (const engine of engines) {
    const path = join(output, "dist", programProfile(engine).core);
    const receipt: unknown = await Bun.file(`${path}.build.json`).json();
    verifyGuestBuildReceipt(await Bun.file(path).bytes(), receipt);
    if ((receipt.profile ?? "split") !== profile) throw new Error("Composed guest profile differs from producer profile");
    await verifyGuestCompanions(receipt, join(output, "dist"));
  }
}
async function compose(engine: PairedEngine): Promise<void> {
  const names = programProfile(engine);
  const options = sourceOptions(repository, sysroot!, engine);
  const captured = await prepareGuestBuildInputs(options, profile);
  const path = join(output, "dist", names.core);
  await Bun.write(path, tagProgramCore(await Bun.file(join(output, "core/bun-core.wasm")).bytes(), engine));
  copyFileSync(join(output, engine, "engine.wasm"), join(output, "dist", names.side));
  copyFileSync(join(output, engine, "engine.wasm.engine.json"), join(output, "dist", `${names.side}.engine.json`));
  await writeGuestBuildReceipt(options, path, captured);
  if (engine !== "jsc") return;
  const snapshot = execFileSync(process.execPath, [join(repository, "scripts/jsc-embedding.ts"), "inputs"], { cwd: repository, env: environment, encoding: "utf8" }).trim();
  execFileSync(process.execPath, [join(repository, "scripts/jsc-embedding.ts"), "write", path, snapshot], { cwd: repository, env: environment, stdio: "inherit" });
}
function prepareLauncher(): void {
  mkdirSync(join(output, "launcher"), { recursive: true });
  const source = sourceIdentity();
  if (existsSync(launcher) || existsSync(launcherProof)) {
    verifyLauncher(launcher, JSON.parse(readFileSync(launcherProof, "utf8")), source);
    return;
  }
  const supplied = process.env.BUN_WASM_LAUNCHER;
  if (supplied) {
    const receipt = process.env.BUN_WASM_LAUNCHER_RECEIPT;
    if (!receipt) throw new Error("An admitted launcher needs its original BUN_WASM_LAUNCHER_RECEIPT");
    verifyLauncher(supplied, JSON.parse(readFileSync(receipt, "utf8")), source);
    copyFileSync(supplied, launcher); copyFileSync(receipt, launcherProof);
    return;
  }
  const tools = sourceOptions(repository, sysroot!, "browser").tools;
  if (!tools.cargo || !tools.rustc) throw new Error("Missing pinned launcher toolchain");
  const target = join(output, "launcher/target");
  const args = ["build", "--locked", "--offline", "--release", "-j", "2", "-p", "bunwasm-host"];
  execFileSync(tools.cargo, args, { cwd: repository, env: { ...environment, CARGO_TARGET_DIR: target, RUSTC: tools.rustc }, stdio: "inherit" });
  if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error("Launcher source changed during production");
  copyFileSync(join(target, "release/bun-wasm"), launcher);
  writeFileSync(launcherProof, JSON.stringify({ ...launcherReceipt(launcher, source), build: { command: args, cargo: tools.cargo, rustc: tools.rustc } }, null, 2) + "\n");
}
function programSmoke(): void {
  const text = 'console.log("paired-smoke",40+2); const before=process.memoryUsage(); globalThis.bytes=new Uint8Array(1048576); const after=process.memoryUsage(); console.log(JSON.stringify({before,after}));';
  for (const engine of engines) {
    const core = join(output, "dist", programProfile(engine).core);
    smoke(engine, launcher, ["--wasm", core, "--", "-e", text], "launcher");
    if (profile === "split") smoke(engine, "node", ["--no-warnings", join(repository, "web/scripts/node-host.ts"), "--wasm", core, "--", "-e", text], "node");
  }
}
function smoke(engine: PairedEngine, executable: string, args: string[], host: string): void {
  const result = spawnSync(executable, args, { cwd: repository, env: { ...environment, BUN_WASM_SCRATCH_ROOT: join(output, "smoke-tmp") }, encoding: "utf8", timeout: 120000 });
  writeFileSync(join(output, host === "launcher" ? `${engine}-smoke.log` : `${engine}-${host}-smoke.log`), result.stdout + result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes("paired-smoke 42")) throw new Error(`${engine} ${host} smoke failed`);
}
function workerProof(): void {
  const scratch = join(output, "smoke-tmp");
  copyFileSync(join(repository, "tests/shared-group/worker-alias.ts"), join(scratch, "worker-alias.ts"));
  const core = join(output, "dist/bun.wasm");
  const result = spawnSync(launcher, ["--wasm", core, "--engine", `quickjs=${core}`, "--env", "PATH=/opt/bun/quickjs/bin:/bin:/usr/bin", "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "bun", "worker-alias.ts"], { cwd: scratch, env: environment, encoding: "utf8", timeout: 300000 });
  writeFileSync(join(output, "worker-proof.log"), result.stdout + result.stderr);
  if (result.error) throw result.error;
  verifyWorkerProof(result.stdout, result.status);
  if (readFileSync(join(output, "core/cxx-runtime-members.json"), "utf8").trim() !== "[]") throw new Error("Shared-group selected a stock C++ runtime member");
}
function stageShell(): void {
  const source = process.env.BASH_WEB_GUESTS_DIR;
  if (!source) throw new Error("Set BASH_WEB_GUESTS_DIR to qualified pinned shell guests for the consumer web root");
  if (!verifiedGuests(resolve(source), pinnedBashWeb(join(repository, "web")))) throw new Error("Qualified shell guests are missing");
  for (const file of ["bash-web-shell.wasm", "bash-web-env.wasm", "bash-web-guests.json"]) copyFileSync(join(source, file), join(output, "dist", file));
}
function webBuild(): void {
  execFileSync(process.execPath, [join(repository, "web/build.ts")], { cwd: repository, stdio: "inherit", env: { ...environment,
    BUN_WASM: join(output, "dist/bun.wasm"), JSC_WASM: join(output, "dist/bun-jsc.wasm"),
    BASH_WEB_GUESTS_DIR: join(output, "dist"), BASH_WEB_GUESTS: "required" } });
}
function webFiles(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? webFiles(join(directory, entry.name), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`]);
}
async function identities(paths: readonly string[]) {
  return Promise.all(paths.map(async path => { const bytes = await Bun.file(join(output, path)).bytes(); return { path, bytes: bytes.byteLength, sha256: hash(bytes) }; }));
}
async function splitAssets(): Promise<void> {
  stageShell(); state("web-build"); webBuild();
  rmSync(join(output, "web"), { recursive: true, force: true });
  cpSync(join(repository, "web/dist"), join(output, "web"), { recursive: true });
  const builds: unknown = JSON.parse(readFileSync(join(output, "web/engine-builds.json"), "utf8"));
  verifyPublicationBuilds(builds);
  const names = engines.flatMap(engine => [programProfile(engine).core, programProfile(engine).side]);
  for (const name of names) if (builds[name] !== hash(await Bun.file(join(output, "dist", name)).bytes())) throw new Error(`Missing or stale browser asset: ${name}`);
  state("hook-controls");
  writeFileSync(join(output, "hook-controls.log"), execFileSync(process.execPath, ["test", "./scripts/engine-memory-hook.test.ts", "./web/tests/bun-executor.test.ts"], { cwd: repository, env: environment, encoding: "utf8" }));
  state("hook-smoke");
  execFileSync(process.execPath, [join(repository, "scripts/verify-engine-memory-browser.ts"), output], { cwd: repository, env: environment, stdio: "inherit" });
}
function verifyOutputScope(): void {
  if (!existsSync(output)) return;
  for (const entry of readdirSync(output)) rejectWithdrawnPublicationPath(entry);
  for (const directory of ["dist", "web", "inputs"]) {
    const root = join(output, directory);
    if (!existsSync(root)) continue;
    for (const path of webFiles(root, directory)) rejectWithdrawnPublicationPath(path);
  }
}
async function build(): Promise<void> {
  verifyOutputScope();
  if (existsSync(join(output, "manifest.json"))) { await verify(); return; }
  mkdirSync(join(output, "inputs"), { recursive: true }); mkdirSync(join(output, "dist"), { recursive: true }); mkdirSync(join(output, "smoke-tmp"), { recursive: true });
  const source = sourceIdentity();
  state("checking-inputs"); const current = await inputs(); lockedInputs(current);
  state("building-core"); recipe("scripts/build-bun-core.sh", profile === "split" ? [] : ["--shared-group"]);
  for (const engine of engines) { state(`building-${engine}`); recipe(`scripts/build-engine-${engine}.sh`); }
  state("composing"); for (const engine of engines) await compose(engine);
  await verifyPrograms(current);
  if (JSON.stringify(await inputs()) !== JSON.stringify(current)) throw new Error("Producer inputs changed during production");
  state("launcher"); prepareLauncher(); state("program-smoke"); programSmoke();
  if (profile === "split") await splitAssets();
  else workerProof();
  if (JSON.stringify(await inputs()) !== JSON.stringify(current)) throw new Error("Producer inputs changed during validation");
  if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error("Producer source changed during validation");
  const required = producerArtifactPaths(profile);
  const requiredPaths = new Set(required);
  const paths = required.concat(profile === "split" ? webFiles(join(output, "web"), "web").filter(path => !requiredPaths.has(path)) : []);
  const files = await identities(paths); requireClosureFiles(profile, files);
  writeFileSync(join(output, "manifest.json"), JSON.stringify({ schema: 1, status: "reusable", profile, engines, source, nativePrebuild: profile === "split" ? prebuild : null,
    inputs: current.map(input => ({ scope: input.scope, contentSha256: input.contentSha256 })), inputOrigins: JSON.parse(readFileSync(join(output, "inputs/programs.json"), "utf8")), files,
    launcher: { path: launcher, receipt: launcherProof, ...verifyLauncher(launcher, JSON.parse(readFileSync(launcherProof, "utf8")), source) },
    webRoot: profile === "split" ? join(output, "web") : null, hook: join(repository, "scripts/app-matrix/engine-memory-hook.ts"),
    engineBuilds: profile === "split" ? JSON.parse(readFileSync(join(output, "web/engine-builds.json"), "utf8")) : null }, null, 2) + "\n");
  rmSync(join(output, "smoke-tmp"), { recursive: true, force: true }); state("reusable");
}
async function verify(): Promise<void> {
  verifyOutputScope();
  const value: unknown = await Bun.file(join(output, "manifest.json")).json();
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 || !("status" in value) || value.status !== "reusable" || !("files" in value) || !Array.isArray(value.files)) throw new Error("Producer is not reusable");
  if (!("source" in value) || JSON.stringify(value.source) !== JSON.stringify(sourceIdentity())) throw new Error("Producer source identity differs from its manifest");
  if (!("profile" in value) || value.profile !== profile || !("engines" in value) || JSON.stringify(value.engines) !== JSON.stringify(engines)) throw new Error("Producer profile/engine registry differs from manifest");
  if ("hermesBuild" in value) throw new Error("Withdrawn engine native reference in producer manifest");
  if (profile === "split") {
    if (!("engineBuilds" in value)) throw new Error("Missing publication asset registry");
    verifyPublicationBuilds(value.engineBuilds);
    const staged: unknown = JSON.parse(readFileSync(join(output, "web/engine-builds.json"), "utf8"));
    if (JSON.stringify(staged) !== JSON.stringify(value.engineBuilds)) throw new Error("Manifest publication assets differ from staged registry");
  }
  for (const file of value.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").includes("..") || typeof file.sha256 !== "string" || typeof file.bytes !== "number") throw new Error("Invalid manifest artifact");
    const bytes = await Bun.file(join(output, file.path)).bytes();
    if (hash(bytes) !== file.sha256 || bytes.byteLength !== file.bytes) throw new Error(`Changed artifact ${file.path}`);
  }
  requireClosureFiles(profile, value.files);
  const recordedLauncher = { path: launcher, receipt: launcherProof, ...verifyLauncher(launcher, JSON.parse(readFileSync(launcherProof, "utf8")), sourceIdentity()) };
  if (!("launcher" in value) || JSON.stringify(value.launcher) !== JSON.stringify(recordedLauncher)) throw new Error("Manifest launcher identity differs from its original receipt");
  const current = await inputs(); lockedInputs(current); await verifyPrograms(current);
  if (!("inputs" in value) || JSON.stringify(value.inputs) !== JSON.stringify(current.map(input => ({ scope: input.scope, contentSha256: input.contentSha256 })))) throw new Error("Manifest input registry differs from current inputs");
  if (!("inputOrigins" in value) || JSON.stringify(value.inputOrigins) !== JSON.stringify(JSON.parse(readFileSync(join(output, "inputs/programs.json"), "utf8")))) throw new Error("Manifest original input snapshots differ");
  console.log(`Verified reusable ${profile} producer ${output}`);
}
if (import.meta.main) {
  if (command !== "build" && command !== "verify") throw new Error("Usage: engine-producer.ts build|verify [split|shared-group]");
  if (command === "build" && profile === "shared-group" && !existsSync(join(repository, "tests/shared-group/worker-alias.ts"))) {
    throw new Error("Shared-group production is unavailable in this source checkout; its native implementation and worker proof must land together");
  }
  const lock = join(output, ".producer-lock");
  if (command === "verify" || existsSync(manifestPath)) {
    if (existsSync(lock)) throw new Error("Producer is active; cannot verify a changing closure");
    await verify();
  } else {
    mkdirSync(output, { recursive: true }); mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, repository, command, profile }));
    try { await build(); }
    catch (error) { state("failed", String(error)); throw error; }
    finally { rmSync(lock, { recursive: true }); rmSync(join(output, "smoke-tmp"), { recursive: true, force: true }); }
  }
}
