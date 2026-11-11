// Test driver only. Uses the guest installer, the native launcher and the existing Browser host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { programKind, programProfile, sharedGroupPair, verifyProgramSide } from "../src/engine-kind";

const root = resolve(import.meta.dir, "..");
export const oxcFixture = join(root, "tests/real-oxc-consumer");
export const oxcOutputs = {
  "index.ts": "ExportNamedDeclaration 0\n",
  "direct.ts": "official Wasm binding loaded function\nshared memory created\n",
};
export const oxcTreeVariable = "SHARED_WASM_OXC_TREE";
const frozenFiles = ["package.json", "bun.lock", "index.ts", "direct.ts"];

export function requireOxcEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of ["NAPI_RS_FORCE_WASI", "SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", oxcTreeVariable]) {
    if (Object.hasOwn(env, key)) throw new Error(`Real Oxc check refuses override: ${key}`);
  }
}

export function requireOxcTree(tree: string): void {
  for (const file of frozenFiles) assert.deepEqual(readFileSync(join(tree, file)), readFileSync(join(oxcFixture, file)), `Oxc fixture changed: ${file}`);
  for (const name of ["oxc-parser", "@oxc-parser/binding-wasm32-wasi"]) {
    const manifest: unknown = JSON.parse(readFileSync(join(tree, "node_modules", name, "package.json"), "utf8"));
    assert.ok(manifest && typeof manifest === "object" && "name" in manifest && manifest.name === name && "version" in manifest && manifest.version === "0.94.0", `Expected published ${name}@0.94.0`);
  }
  assert.ok(statSync(join(tree, "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm32-wasi.wasm")).isFile());
  assert.ok(statSync(join(tree, "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasi.cjs")).isFile());
}

export function requireOxcInputs(program: string, launcher: string, browser: string): void {
  const core = new WebAssembly.Module(readFileSync(program));
  const kind = programKind(core);
  assert.equal(kind, "quickjs", "The real Oxc check requires the selected QuickJS group core");
  const side = readFileSync(join(dirname(program), programProfile("quickjs").side));
  assert.equal(sharedGroupPair(core, side), true, "The selected core and side must be a shared-group pair");
  verifyProgramSide("quickjs", new WebAssembly.Module(side));
  assert.ok(statSync(launcher).isFile(), "Missing matching native launcher");
  assert.equal(programKind(new WebAssembly.Module(readFileSync(browser))), "single", "Expected the Browser-engine control guest");
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
  requireOxcInputs(program, launcher, browser);
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
    const args = ["--wasm", program, "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "HOME=/", "--"];
    await command(rows, "quickjs-group-install", launcher, args.concat(["install", "--frozen-lockfile"]), process.env, controller.signal);
    requireOxcTree(scratch);
    for (const [entry, expected] of Object.entries(oxcOutputs)) {
      assert.equal((await command(rows, `quickjs-group-${entry}`, launcher, args.concat(["run", `/${entry}`]), process.env, controller.signal)).stdout, expected);
      const controlArgs: string[] = ["--disable-warning=ExperimentalWarning", "web/scripts/node-host.mjs", "--wasm", browser, "--dir", `${scratch}::/`, "--env", "PWD=/", "--", "run", `/${entry}`];
      assert.equal((await command(rows, `browser-engine-${entry}`, "node", controlArgs, process.env, controller.signal)).stdout, expected);
    }
    // The same installed bytes enter the production Browser-host executor, not a new executor.
    const env = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, [oxcTreeVariable]: scratch };
    await command(rows, "browser-host-quickjs-group", process.execPath, ["web/tests/shared-wasm-memory-browser.ts", "chromium"], env, controller.signal, 300_000);
    requireOxcTree(scratch);
  } finally {
    saveAndClean(output, rows, scratch, signals, stop);
  }
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
