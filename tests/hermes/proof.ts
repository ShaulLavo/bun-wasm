import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureCases, fixturesDir } from "../../scripts/esm-loader-harness";
import { selectChecks } from "../../scripts/test-checks";

type Output = { status: number | null; signal: string | null; stdout: string; stderr: string };
type Proof = { name: string; pass: boolean; actual: Output; expected: Output };
const root = resolve(import.meta.dir, "../..");
function argument(index: number): string {
  const value = process.argv[index];
  if (!value) throw new Error("Usage: bun tests/hermes/proof.ts LAUNCHER CORE REPORT.json [--node-only]");
  return value;
}
const launcher = argument(2), core = argument(3), report = argument(4);
const nodeOnly = process.argv.includes("--node-only");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-hermes-j4-proof-"));
const env = { ...process.env, BUN_WASM_CACHE_DIR: process.env.BUN_WASM_CACHE_DIR ?? join(scratch, "compiled") };
const proofs: Proof[] = [];
const sourceTraces: { name: string; actual: Output; expected: Output }[] = [];
function cleanup(): void { rmSync(scratch, { recursive: true, force: true }); }
process.once("SIGINT", () => { cleanup(); process.exit(130); });
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
function run(command: string, args: string[], cwd = root): Output {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: (result.stderr ?? "") + (result.error?.message ?? "") };
}
function record(name: string, actual: Output, expected: Output): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  proofs.push({ name, pass, actual, expected });
  console.log(`${pass ? "pass" : "FAIL"} ${name}`);
  if (!pass) console.log(JSON.stringify({ actual, expected }, null, 2));
}
function node(args: string[], cwd = root): Output {
  return run("node", ["--disable-warning=ExperimentalWarning"].concat(args), cwd);
}
function guest(args: string[], extra: string[] = [], cwd = root): Output {
  return run(launcher, ["--wasm", resolve(core), "--engine", `hermes=${resolve(core)}`].concat(extra, ["--"], args), cwd);
}
function againstNode(name: string, file: string, status = 0): void {
  const expected = node([file]);
  if (expected.status !== status || expected.stderr !== "") throw new Error(`Invalid Node control ${name}: ${JSON.stringify(expected)}`);
  record(name, nodeOnly ? expected : guest(["run", file]), expected);
}
function modules(): void {
  for (const name of fixtureCases()) {
    const directory = join(fixturesDir, name);
    const expected = { status: 0, signal: null, stdout: readFileSync(join(directory, "expected.txt"), "utf8"), stderr: "" };
    const source = `import(${JSON.stringify(join(directory, "main.mjs"))}).catch(error => console.log("<rejected>", error && error.message));`;
    record(`node/${name}`, node(["--input-type=module", "-e", source]), expected);
    if (!nodeOnly) record(`pair/${name}`, guest(["-e", source]), expected);
  }
}
function sourceLines(file: string): void {
  const path = join(root, "tests/hermes", file);
  const expected = node([path]);
  const actual = nodeOnly ? expected : guest(["run", path]);
  sourceTraces.push({ name: file, actual, expected });
  function location(output: Output): Output {
    const line = /source-lines\.(?:mts|cts):(\d+):\d+/.exec(output.stderr)?.[1];
    return { ...output, stderr: line === undefined ? output.stderr : `source line ${line}` };
  }
  if (expected.status !== 1 || !expected.stderr.includes("mapped")) throw new Error(`Invalid Node source-line control: ${file}`);
  record(file, location(actual), location(expected));
}
function virtualEval(): void {
  const file = join(root, "tests/hermes/tla/awaited.mts");
  const source = `const ns = await import(${JSON.stringify(file)}); console.log("virtual eval", ns.answer, import.meta.url.endsWith("/[eval]"));`;
  const expected = { status: 0, signal: null, stdout: "virtual eval 42 true\n", stderr: "" };
  const nodeControl = node(["--input-type=module", "-e", source]);
  // Node names eval sources [eval1], while the core uses the registered virtual [eval].
  record("node/virtual-eval", nodeControl, { ...expected, stdout: "virtual eval 42 false\n" });
  if (!nodeOnly) record("pair/virtual-eval", guest(["-e", source]), expected);
}
function nativeFixtures(): void {
  const names = ["cjs-interop", "commonjs-builtin-resolution", "esm-async-dependency-reimport", "package-resolution", "timer-promises", "timer-promises-pending-close", "timer-promises-unref", "wasm-memory-growth"];
  const discovered = new Set(selectChecks("native"));
  for (const name of names) {
    const path = `tests/fixtures/${name}`;
    if (!discovered.has(path)) throw new Error(`Not a discovered native check: ${path}`);
    const directory = join(scratch, name);
    cpSync(join(root, path), directory, { recursive: true });
    const entry = ["index.ts", "index.js", "index.mjs"].find(file => existsSync(join(directory, file)));
    if (!entry) throw new Error(`Missing fixture entry: ${path}`);
    const expected = { status: 0, signal: null, stdout: readFileSync(join(directory, "expected.txt"), "utf8"), stderr: "" };
    record(`discovered/${name}`, guest(["run", `/${entry}`], ["--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/"], directory), expected);
  }
}
function interruption(): void {
  const file = join(root, "tests/hermes/interrupt.ts");
  const expected = { status: 0, signal: null, stdout: "child ready\ninterrupt 143 SIGTERM false true\n", stderr: "" };
  const quickjsIndex = process.argv.indexOf("--quickjs");
  const quickjs = quickjsIndex < 0 ? undefined : process.argv[quickjsIndex + 1];
  if (quickjs) record("G5/quickjs-interrupt", run(launcher, ["--wasm", resolve(quickjs), "--engine", `quickjs=${resolve(quickjs)}`, "--", "run", file]), expected);
  record("G5/hermes-interrupt", guest(["run", file]), expected);
}
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
try {
  modules();
  for (const file of ["tla/main.mts", "dynamic-import.cts", "require-esm.cts", "async-context.ts"]) {
    againstNode(file, join(root, "tests/hermes", file));
  }
  sourceLines("tla/source-lines.mts");
  sourceLines("source-lines.cts");
  virtualEval();
  againstNode("G5/semantics", join(root, "tests/hermes/semantics.cts"), 7);
  if (!nodeOnly) { nativeFixtures(); interruption(); }
} finally {
  cleanup();
  const identity = nodeOnly ? null : { core: { path: resolve(core), sha256: digest(core) }, side: { path: join(resolve(core, ".."), "hermes-engine.wasm"), sha256: digest(join(resolve(core, ".."), "hermes-engine.wasm")) } };
  writeFileSync(report, JSON.stringify({ identity, proofs, sourceTraces, cleanup: { scratch, removed: !existsSync(scratch) } }, null, 2) + "\n");
}
const failed = proofs.filter(proof => !proof.pass);
console.log(`${proofs.length - failed.length}/${proofs.length} passed`);
process.exitCode = Number(failed.length > 0);
