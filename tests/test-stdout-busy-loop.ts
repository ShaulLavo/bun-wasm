// Stdout written during a busy event loop must reach the pipe before the loop goes idle.
// The guest spins until /ack exists; this host creates it only after reading "ready".
// source env.sh && node tests/test-stdout-busy-loop.ts [--engine quickjs|jsc|browser] [--wasm PATH]
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { engine: { type: "string", default: "quickjs" }, wasm: { type: "string" }, timeout: { type: "string", default: "30000" } } });
const binaries: Record<string, string> = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm" };
const engine = values.engine ?? "quickjs";
if (!binaries[engine]) throw new Error(`unknown engine ${engine}`);
const root = resolve(import.meta.dirname, "..");
const wasm = resolve(values.wasm ?? join(root, "dist", binaries[engine]));
const fixture = join(root, "tests/fixtures/stdout-busy-loop");
const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target", "release/bun-wasm");

// The cleanup owner exists before the scratch directory and the child do.
let work: string | undefined;
let child: ChildProcess | undefined;
function teardown() {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { teardown(); process.exit(128 + (signal === "SIGINT" ? 2 : 15)); });

function command(directory: string): string[] {
  if (engine === "browser") return [process.execPath, join(root, "web/scripts/node-host.mjs"), "--wasm", wasm, "--dir", `${directory}::/`, "--", "run", "/index.ts"];
  return [launcher, "--wasm", wasm, "--engine", `${engine}=${wasm}`, "--env", `PATH=/opt/bun/${engine}/bin:/bin:/usr/bin`, "--dir", `${directory}::/`, "--env", "PWD=/", "--", "run", "/index.ts"];
}

async function run(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  work = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-stdout-busy-loop-"));
  cpSync(fixture, work, { recursive: true });
  const directory = work;
  const [executable, ...args] = command(directory);
  let stdout = "";
  let stderr = "";
  const spawned = spawn(executable!, args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  child = spawned;
  spawned.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.startsWith("ready\n")) writeFileSync(join(directory, "ack"), "");
  });
  spawned.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => spawned.kill("SIGKILL"), Number(values.timeout));
  try {
    const code = await new Promise<number | null>((done, fail) => { spawned.once("error", fail); spawned.once("close", done); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

try {
  const result = await run();
  const expected = readFileSync(join(fixture, "expected.txt"), "utf8");
  if (result.code !== 0 || result.stdout !== expected) {
    process.stderr.write(`FAIL ${engine}: exit=${result.code}\nstdout=${JSON.stringify(result.stdout)}\nstderr=${result.stderr}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS ${engine}: stdout reached the pipe while the event loop stayed busy\n`);
  }
} catch (error) {
  process.stderr.write(`FAIL ${engine}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally { teardown(); }
