import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { programKind, programProfile, sharedGroupPair, verifyProgramSide } from "../src/engine-kind";
import { oxcConsumers } from "../tests/real-oxc-consumer/api";

const root = resolve(import.meta.dir, "..");
export const oxcFixture = join(root, "tests/real-oxc-consumer");
export const oxcOutputs = {
  "index.ts": oxcConsumers.map(({ name }) => `${name} package evaluated\n${name} package API passed\n`).join(""),
  "direct.ts": oxcConsumers.map(({ name }) => `${name} official Wasm binding evaluated\n${name} official Wasm API passed\n`).join("") + "shared memory created\n",
  "async.ts": "parser package async API passed\ntransform package async API passed\n",
};
export const oxcTreeVariable = "SHARED_WASM_OXC_TREE";
export const oxcFixtureFiles = ["package.json", "bun.lock", "api.ts", "index.ts", "direct.ts", "async.ts"];

export function requireOxcEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of ["NAPI_RS_FORCE_WASI", "SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", oxcTreeVariable]) {
    if (Object.hasOwn(env, key)) throw new Error(`Real Oxc check refuses override: ${key}`);
  }
}

export function requireOxcTree(tree: string): void {
  for (const file of oxcFixtureFiles) assert.deepEqual(readFileSync(join(tree, file)), readFileSync(join(oxcFixture, file)), `Oxc fixture changed: ${file}`);
  for (const name of oxcConsumers.flatMap(consumer => [consumer.package, consumer.binding])) {
    const manifest: unknown = JSON.parse(readFileSync(join(tree, "node_modules", name, "package.json"), "utf8"));
    assert.ok(manifest && typeof manifest === "object" && "name" in manifest && manifest.name === name && "version" in manifest && manifest.version === "0.94.0", `Expected published ${name}@0.94.0`);
  }
  for (const consumer of oxcConsumers) {
    const binding = join(tree, "node_modules", consumer.binding, consumer.name);
    assert.ok(statSync(`${binding}.wasm32-wasi.wasm`).isFile());
    assert.ok(statSync(`${binding}.wasi.cjs`).isFile());
  }
}

export function requireOxcInputs(program: string, launcher: string, browser: string) {
  const core = new WebAssembly.Module(readFileSync(program));
  const kind = programKind(core);
  if (kind === "single") throw new Error("The real Oxc check requires a JSC, QuickJS or SpiderMonkey group core");
  const side = readFileSync(join(dirname(program), programProfile(kind).side));
  assert.equal(sharedGroupPair(core, side), true, "The selected core and side must be a shared-group pair");
  verifyProgramSide(kind, new WebAssembly.Module(side));
  assert.ok(statSync(launcher).isFile(), "Missing matching native launcher");
  assert.equal(programKind(new WebAssembly.Module(readFileSync(browser))), "single", "Expected the Browser-engine control guest");
  return kind;
}

type Row = { name: string; status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; elapsedMs: number; stdout: string; stderr: string };

export async function command(rows: Row[], name: string, executable: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeout = 90_000): Promise<Row> {
  signal.throwIfAborted();
  const started = performance.now();
  const row: Row = { name, status: null, signal: null, timedOut: false, elapsedMs: 0, stdout: "", stderr: "" };
  rows.push(row);
  let failure: Error | undefined;
  await new Promise<void>(finished => {
    const child = spawn(executable, args, { cwd: root, env, signal, stdio: ["ignore", "pipe", "pipe"] });
    const deadline = setTimeout(() => { row.timedOut = true; child.kill("SIGTERM"); }, timeout);
    child.stdout.setEncoding("utf8").on("data", (text: string) => { row.stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { row.stderr += text; });
    child.once("error", error => { failure = error; });
    child.once("close", (status, stopped) => {
      clearTimeout(deadline);
      row.status = status; row.signal = stopped; row.elapsedMs = performance.now() - started;
      console.log(JSON.stringify(row));
      finished();
    });
  });
  if (failure) throw failure;
  signal.throwIfAborted();
  assert.equal(row.timedOut, false, `${name} exceeded its bound`);
  assert.equal(row.signal, null, `${name} exceeded its bound`);
  assert.equal(row.status, 0, `${name}: ${row.stderr}`);
  return row;
}

async function runOxcConsumer(program: string, launcher: string, browser: string, output: string): Promise<void> {
  requireOxcEnvironment(process.env);
  const kind = requireOxcInputs(program, launcher, browser);
  const tier = process.env.BUN_WASM_SPIDERMONKEY_TIER;
  if (kind === "spidermonkey") assert.ok(tier === "interp" || tier === "pbl", "Select an explicit SpiderMonkey tier: interp or pbl");
  const rows: Row[] = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "bun-wasm-real-oxc-"));
    console.log(JSON.stringify({ resources: { scratch, downloads: "frozen guest dependencies only", program, launcher, browser } }));
    cpSync(oxcFixture, scratch, { recursive: true });
    const args = ["--wasm", program, "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "HOME=/"].concat(kind === "spidermonkey" ? ["--env", `BUN_WASM_SPIDERMONKEY_TIER=${tier}`] : [], ["--"]);
    await command(rows, `${kind}-group-install`, launcher, args.concat(["install", "--frozen-lockfile"]), process.env, controller.signal);
    requireOxcTree(scratch);
    const failures: unknown[] = [];
    await runEntries({ rows, failures, kind, launcher, args, browser, scratch, signal: controller.signal });
    const env = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, [oxcTreeVariable]: scratch };
    await observe(failures, () => command(rows, `browser-host-${kind}-group`, process.execPath, ["web/tests/shared-wasm-memory-browser.ts", "chromium"], env, controller.signal, 300_000));
    requireOxcTree(scratch);
    if (failures.length) throw new AggregateError(failures, "Real Oxc consumer checks failed");
  } finally {
    saveAndClean(output, rows, scratch, signals, stop);
  }
}

async function runEntries({ rows, failures, kind, launcher, args, browser, scratch, signal }: {
  rows: Row[]; failures: unknown[]; kind: string; launcher: string; args: string[]; browser: string; scratch: string; signal: AbortSignal;
}): Promise<void> {
  for (const [entry, expected] of Object.entries(oxcOutputs)) {
    await observe(failures, async () => assert.equal((await command(rows, `${kind}-group-${entry}`, launcher, args.concat(["run", `/${entry}`]), process.env, signal)).stdout, expected));
    const controlArgs = ["--disable-warning=ExperimentalWarning", "web/scripts/node-host.mjs", "--wasm", browser, "--dir", `${scratch}::/`, "--env", "PWD=/", "--", "run", `/${entry}`];
    await observe(failures, async () => assert.equal((await command(rows, `browser-engine-${entry}`, "node", controlArgs, process.env, signal)).stdout, expected));
  }
}

export async function observe(failures: unknown[], check: () => Promise<unknown>): Promise<void> {
  try { await check(); }
  catch (error) { failures.push(error); }
}

function saveAndClean(output: string, rows: Row[], scratch: string | undefined, signals: readonly NodeJS.Signals[], stop: () => void): void {
  try { writeFileSync(output, JSON.stringify(rows, null, 2) + "\n"); }
  finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    for (const signal of signals) process.removeListener(signal, stop);
  }
}

if (import.meta.main) {
  const [program, launcher, browser, output] = process.argv.slice(2);
  if (!program || !launcher || !browser || !output || process.argv.length !== 6) throw new Error("Usage: bun scripts/real-oxc-consumer.ts GROUP_CORE LAUNCHER BROWSER_GUEST OUTPUT_JSON");
  await runOxcConsumer(resolve(program), resolve(launcher), resolve(browser), resolve(output));
}
