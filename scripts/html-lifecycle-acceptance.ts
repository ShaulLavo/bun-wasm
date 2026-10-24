import { createHash } from "node:crypto";
import { closeSync, openSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { verifyGuestBuildReceipt } from "./guest-build-receipt";

export type Engine = "quickjs" | "jsc" | "browser";
type FileIdentity = { path: string; sha256: string; bytes: number };
type SourceIdentity = { head: string; tree: string };
type NativeInput = FileIdentity & { role: string };
export type Qualification = {
  schema: 1;
  source: SourceIdentity;
  engine: Engine;
  features: string[];
  upstream: SourceIdentity & { root: string; pin: string; leakTestSha256: string };
  html: { source: FileIdentity; emitted: FileIdentity; polyfills: FileIdentity };
  nativeInputs: FileIdentity;
  buildEvidence: FileIdentity;
  rawGuest: FileIdentity;
  executedGuest: FileIdentity;
  launcher: FileIdentity;
};
export const trackedNativeInputs = {
  "html-parser": "crates/bunwasm-runtime/src/html_rewriter.rs",
  "native-bindings": "crates/bunwasm-runtime/src/natives.rs",
  "testing-export": "crates/bunwasm-runtime/src/js/builtins.js",
  "runtime-build": "crates/bunwasm-runtime/build.rs",
  "polyfill-emitter": "crates/bunwasm-runtime/build/polyfills.rs",
  "cargo-lock": "Cargo.lock",
  "cargo-config": ".cargo/config.toml",
  "rust-toolchain": "rust-toolchain.toml",
};
const htmlSource = "crates/bunwasm-runtime/src/js/html_rewriter.ts";
export const upstreamTest = "js/workerd/html-rewriter-leak.test.ts";
export const lifecycleFixtures = ["html-handler-lifetime", "html-handler-contracts", "html-intrinsic-storage", "html-rewriter", "html-rewriter-review"];
export const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Expected qualification object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected nonempty string");
  return value;
}
function digest(value: unknown, length = 64): string {
  const result = text(value);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(result)) throw new Error("Invalid identity digest");
  return result;
}
function path(value: unknown): string {
  const result = text(value);
  if (!isAbsolute(result)) throw new Error("Qualification paths must be absolute");
  return result;
}
function file(value: unknown): FileIdentity {
  const item = fields(value);
  if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error("Invalid file size");
  return { path: path(item.path), sha256: digest(item.sha256), bytes: item.bytes };
}
function source(value: unknown): SourceIdentity {
  const item = fields(value);
  return { head: digest(item.head, 40), tree: digest(item.tree, 40) };
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Expected nonempty string array");
  return value.map(text);
}
function engine(value: unknown): Engine {
  if (value !== "quickjs" && value !== "jsc" && value !== "browser") throw new Error("Invalid engine");
  return value;
}
export function parseQualification(value: unknown): Qualification {
  const item = fields(value), upstream = fields(item.upstream), html = fields(item.html);
  if (item.schema !== 1) throw new Error("Unsupported qualification schema");
  return {
    schema: 1, source: source(item.source), engine: engine(item.engine), features: strings(item.features),
    upstream: { ...source(upstream), root: path(upstream.root), pin: digest(upstream.pin, 40), leakTestSha256: digest(upstream.leakTestSha256) },
    html: { source: file(html.source), emitted: file(html.emitted), polyfills: file(html.polyfills) },
    nativeInputs: file(item.nativeInputs), buildEvidence: file(item.buildEvidence),
    rawGuest: file(item.rawGuest), executedGuest: file(item.executedGuest), launcher: file(item.launcher),
  };
}
function checkedFile(identity: FileIdentity): Buffer {
  if (!statSync(identity.path).isFile()) throw new Error(`Not a regular file: ${identity.path}`);
  const bytes = readFileSync(identity.path);
  if (bytes.length !== identity.bytes || hash(bytes) !== identity.sha256) throw new Error(`File identity mismatch: ${identity.path}`);
  return bytes;
}
function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root].concat(args), { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`Source identity check failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function checkSource(root: string, identity: SourceIdentity) {
  if (git(root, ["rev-parse", "HEAD"]) !== identity.head || git(root, ["rev-parse", "HEAD^{tree}"]) !== identity.tree) throw new Error(`Source head/tree mismatch: ${root}`);
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error(`Source is not clean: ${root}`);
}
function nativeInputs(bytes: Buffer): NativeInput[] {
  const values: unknown = JSON.parse(bytes.toString());
  if (!Array.isArray(values) || values.length === 0) throw new Error("Missing native-input manifest");
  return values.map(value => ({ ...file(value), role: text(fields(value).role) }));
}
function checkNativeInputs(root: string, qualification: Qualification, bytes: Buffer) {
  const inputs = nativeInputs(bytes);
  const roles = new Set(inputs.map(input => input.role));
  const required = ["toolchain", "sysroot", "crypto-native", "crypto-wasi", "engine", "cargo-selection", "linkage", "guest-build-receipt"];
  if (qualification.engine === "jsc") required.push("jsc-stamp", "jsc-authoritative-check");
  if (qualification.engine === "browser") required.push("browser-host", "waffle");
  for (const role of required) if (!roles.has(role)) throw new Error(`Missing native-input role: ${role}`);
  for (const input of inputs) checkedFile(input);
  for (const [role, relative] of Object.entries(trackedNativeInputs)) {
    const input = inputs.find(item => item.role === role);
    if (!input || input.sha256 !== hash(readFileSync(join(root, relative)))) throw new Error(`Tracked native input mismatch: ${role}`);
  }
  if (qualification.engine !== "jsc") return inputs;
  const stamp = inputs.find(input => input.role === "jsc-stamp");
  const check = inputs.find(input => input.role === "jsc-authoritative-check");
  if (!stamp || !check) throw new Error("Missing JSC stamp check");
  const evidence = fields(JSON.parse(checkedFile(check).toString()));
  const recorded = source(evidence.source);
  if (stamp.path !== join(path(evidence.directory), "build/jsc/.bunwasm-inputs")) throw new Error("JSC stamp path mismatch");
  if (evidence.helper !== "jsc/common.sh:check_jsc_inputs_stamp" || evidence.exit !== 0 || evidence.stampSha256 !== stamp.sha256 || recorded.head !== qualification.source.head || recorded.tree !== qualification.source.tree) throw new Error("JSC authoritative stamp evidence mismatch");
  return inputs;
}

function checkBuildEvidence(qualification: Qualification, bytes: Buffer) {
  const evidence = fields(JSON.parse(bytes.toString()));
  const recorded = source(evidence.source);
  if (recorded.head !== qualification.source.head || recorded.tree !== qualification.source.tree || evidence.engine !== qualification.engine) throw new Error("Build evidence source/engine mismatch");
  if (JSON.stringify(strings(evidence.features)) !== JSON.stringify(qualification.features)) throw new Error("Build evidence feature mismatch");
  const identities = { rawGuest: qualification.rawGuest, executedGuest: qualification.executedGuest, launcher: qualification.launcher,
    htmlSource: qualification.html.source, htmlEmitted: qualification.html.emitted, polyfills: qualification.html.polyfills, nativeInputs: qualification.nativeInputs };
  for (const [key, identity] of Object.entries(identities)) if (evidence[`${key}Sha256`] !== identity.sha256) throw new Error(`Build evidence ${key} mismatch`);
  strings(evidence.command);
  const outDir = path(evidence.cargoOutDir);
  if (resolve(outDir, "polyfills.rs") !== resolve(qualification.html.polyfills.path) || resolve(outDir, "runtime-js/html_rewriter.js") !== resolve(qualification.html.emitted.path)) throw new Error("Cargo OUT_DIR mismatch");
  if (evidence.jsOverrideDir !== null) path(evidence.jsOverrideDir);
}

export function admit(root: string, receiptPath: string, receiptSha256: string, selectedEngine: Engine): Qualification {
  const bytes = readFileSync(receiptPath);
  if (hash(bytes) !== digest(receiptSha256)) throw new Error("Qualification digest mismatch");
  const qualification = parseQualification(JSON.parse(bytes.toString()));
  if (qualification.engine !== selectedEngine) throw new Error("Engine mismatch");
  const feature = selectedEngine === "browser" ? "engine-host" : `engine-${selectedEngine}`;
  if (!qualification.features.includes(feature)) throw new Error("Engine feature mismatch");
  checkSource(root, qualification.source);
  checkSource(qualification.upstream.root, qualification.upstream);
  git(qualification.upstream.root, ["merge-base", "--is-ancestor", qualification.upstream.pin, qualification.upstream.head]);
  const sync = readFileSync(join(root, "scripts/sync-bun.sh"), "utf8");
  if (!sync.includes(qualification.upstream.pin)) throw new Error("Upstream pin mismatch");
  const leak = join(qualification.upstream.root, "test", upstreamTest);
  if (hash(readFileSync(leak)) !== qualification.upstream.leakTestSha256) throw new Error("Upstream test identity mismatch");
  if (hash(readFileSync(join(root, htmlSource))) !== qualification.html.source.sha256) throw new Error("Selected HTML source differs from frozen source");
  checkedFile(qualification.html.source);
  const emitted = checkedFile(qualification.html.emitted);
  const polyfills = checkedFile(qualification.html.polyfills).toString();
  const selection = `("html_rewriter", include_str!(${JSON.stringify(qualification.html.emitted.path)}))`;
  if (!polyfills.includes(selection)) throw new Error("Cargo polyfill selection mismatch");
  const inputs = checkNativeInputs(root, qualification, checkedFile(qualification.nativeInputs));
  checkBuildEvidence(qualification, checkedFile(qualification.buildEvidence));
  checkedFile(qualification.launcher);
  const raw = checkedFile(qualification.rawGuest), executed = checkedFile(qualification.executedGuest);
  const sidecar = inputs.find(input => input.role === "guest-build-receipt");
  const sysroot = inputs.find(input => input.role === "sysroot");
  if (!sidecar || !sysroot) throw new Error("Missing guest/sysroot receipt");
  const buildReceipt: unknown = JSON.parse(checkedFile(sidecar).toString());
  verifyGuestBuildReceipt(executed, buildReceipt);
  if (buildReceipt.bunHead !== qualification.upstream.head || buildReceipt.bunTree !== qualification.upstream.tree || buildReceipt.sysrootReceiptSha256 !== sysroot.sha256) throw new Error("Guest build sidecar input mismatch");
  if (!raw.includes(emitted) || !executed.includes(emitted)) throw new Error("Selected HTML payload absent from guest");
  return qualification;
}

export function acceptanceCommands(root: string, qualification: Qualification, output: string) {
  const fixtures = ["bash", join(root, "scripts/test.sh"), "--no-build", "--engine", qualification.engine, "--wasm", qualification.executedGuest.path].concat(lifecycleFixtures);
  const upstream = ["bash", join(root, "scripts/bun-suite.sh"), "--engine", qualification.engine, "--wasm", qualification.executedGuest.path,
    "--launcher", qualification.launcher.path, "--node", qualification.launcher.path, "--suite", qualification.upstream.root,
    "--jobs", "1", "--timeout", "15", "--network", "loopback", "--output", join(output, "upstream.json"), "--log-dir", join(output, "upstream-cases"), upstreamTest];
  return { fixtures, upstream };
}

export function upstreamPassed(value: unknown): boolean {
  const report = fields(value);
  if (report.selected_files !== 1 || !Array.isArray(report.results) || report.results.length !== 1) return false;
  const result = fields(report.results[0]), counts = fields(result.counts);
  return result.file === upstreamTest && result.exit === 0 && result.complete === true && result.fully_passing === true && result.timed_out === false
    && counts.fail === 0 && counts.errors === 0 && counts.skip === 0 && counts.todo === 0 && typeof counts.pass === "number" && counts.pass > 0;
}

function spawnLogged(root: string, command: string[], env: NodeJS.ProcessEnv, logPath: string) {
  const supervised = ["node", join(root, "scripts/run-with-timeout.mts"), "none"].concat(command);
  const log = openSync(logPath, "w");
  try { return Bun.spawn(supervised, { cwd: root, env, stdin: "ignore", stdout: log, stderr: log }); }
  finally { closeSync(log); }
}

export async function runAcceptance(root: string, receiptPath: string, receiptSha256: string, selectedEngine: Engine, output: string, scratchRoot: string) {
  const qualification = admit(root, receiptPath, receiptSha256, selectedEngine);
  // Fresh output refuses stale evidence. Artifacts and qualification remain read-only.
  mkdirSync(output);
  writeFileSync(join(output, "admitted.json"), JSON.stringify({ receiptPath, receiptSha256, qualification }, null, 2) + "\n");
  let scratch: string | undefined;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  let interrupted = false;
  const stop = () => { interrupted = true; for (const child of children) child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    scratch = mkdtempSync(join(scratchRoot, "bun-wasm-html-acceptance-"));
    const env = { ...process.env, TMPDIR: scratch, RUNNER_TEMP: scratch, TMP: scratch, TEMP: scratch,
      XDG_CACHE_HOME: join(scratch, "xdg"), BUN_WASM_CACHE_DIR: join(scratch, "wasmtime"),
      BUN_WASM_LAUNCHER: qualification.launcher.path, BUN_WASM_NODE: qualification.launcher.path, BUN_WASM_FIXTURE_LOG_DIR: join(output, "fixtures"),
      CARGO_TARGET_DIR: join(scratch, "unused-target"), PYTHONDONTWRITEBYTECODE: "1" };
    writeFileSync(join(output, "ownership.json"), JSON.stringify({ scratch, caches: [env.BUN_WASM_CACHE_DIR, env.XDG_CACHE_HOME], owner: "invoking acceptance run", removal: "after supervised descendants exit on every path" }, null, 2) + "\n");
    const commands = acceptanceCommands(root, qualification, output);
    const results: { name: string; exit: number; accepted: boolean }[] = [];
    for (const [name, command] of Object.entries(commands)) {
      admit(root, receiptPath, receiptSha256, selectedEngine);
      const child = spawnLogged(root, command, env, join(output, `${name}.log`));
      children.add(child);
      const exit = await child.exited;
      children.delete(child);
      const upstream = name === "upstream" && exit === 0 ? JSON.parse(readFileSync(join(output, "upstream.json"), "utf8")) : null;
      const accepted = exit === 0 && (name !== "upstream" || upstreamPassed(upstream));
      results.push({ name, exit, accepted });
      writeFileSync(join(output, "results.json"), JSON.stringify({ status: "diagnostic, inspect case results; not whole-lane acceptance", results }, null, 2) + "\n");
      if (interrupted) break;
    }
    admit(root, receiptPath, receiptSha256, selectedEngine);
    return results;
  } finally {
    stop();
    await Promise.all(Array.from(children, child => child.exited));
    if (scratch) rmSync(scratch, { recursive: true });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const [mode, selectedEngine, receiptPath, receiptSha256, output, scratchRoot] = process.argv.slice(2);
  const root = resolve(import.meta.dir, "..");
  if (!receiptPath || !receiptSha256 || !output || !scratchRoot || !isAbsolute(output) || !isAbsolute(scratchRoot)) throw new Error("Usage: bun scripts/html-lifecycle-acceptance.ts admit|run ENGINE QUALIFICATION.json SHA256 /absolute/output /owned/scratch-root");
  const selected = engine(selectedEngine);
  if (mode === "admit") console.log(JSON.stringify(admit(root, receiptPath, receiptSha256, selected), null, 2));
  else if (mode === "run") {
    const results = await runAcceptance(root, receiptPath, receiptSha256, selected, output, scratchRoot);
    process.exitCode = results.some(result => !result.accepted) ? 1 : 0;
  } else throw new Error("Expected admit or run");
}
