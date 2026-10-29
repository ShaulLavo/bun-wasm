// Stdout written during a busy event loop must reach the pipe before the loop goes idle.
// The guest spins until /ack exists; this host creates it only after reading "ready".
// source env.sh && node tests/test-stdout-busy-loop.ts [--engine quickjs|jsc|browser] [--wasm PATH]
import { spawn } from "node:child_process";
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
const work = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-stdout-busy-loop-"));
cpSync(fixture, work, { recursive: true });
const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target", "release/bun-wasm");
const command = engine === "browser"
  ? [process.execPath, join(root, "web/scripts/node-host.mjs"), "--wasm", wasm, "--dir", `${work}::/`, "--", "run", "/index.ts"]
  : [launcher, "--wasm", wasm, "--engine", `${engine}=${wasm}`, "--env", `PATH=/opt/bun/${engine}/bin:/bin:/usr/bin`, "--dir", `${work}::/`, "--env", "PWD=/", "--", "run", "/index.ts"];

const child = spawn(command[0]!, command.slice(1), { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
  stdout += chunk;
  if (stdout.startsWith("ready\n")) writeFileSync(join(work, "ack"), "");
});
child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), Number(values.timeout));
const code = await new Promise<number | null>(done => child.on("close", done));
clearTimeout(timer);
rmSync(work, { recursive: true, force: true });
const expected = readFileSync(join(fixture, "expected.txt"), "utf8");
if (code !== 0 || stdout !== expected) {
  process.stderr.write(`FAIL ${engine}: exit=${code}\nstdout=${JSON.stringify(stdout)}\nstderr=${stderr}\n`);
  process.exit(1);
}
process.stdout.write(`PASS ${engine}: stdout reached the pipe while the event loop stayed busy\n`);
