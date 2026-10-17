import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { workerReviewCases } from "./fixtures/worker-review/cases.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback = "") => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const engine = option("--engine", "browser");
const host = option("--host", engine === "browser" ? "node" : "native");
const artifact = resolve(option("--wasm", `dist/${engine === "quickjs" ? "bun" : `bun-${engine}`}.wasm`));
const root = resolve(import.meta.dirname, "..");
const launcher = process.env.BUN_WASM_LAUNCHER || resolve(process.env.CARGO_TARGET_DIR || "/work/tmp/bun-wasm-target", "release/bun-wasm");
const selected = workerReviewCases.filter(test => !option("--case") || test.name.includes(option("--case")));
const results = [];
let active: ReturnType<typeof spawn> | undefined;
let scratch: string | undefined;
process.on("exit", () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
process.on("SIGTERM", () => { active?.kill("SIGKILL"); process.exit(143); });
process.on("SIGINT", () => { active?.kill("SIGKILL"); process.exit(130); });
if (host === "node-control") scratch = mkdtempSync("/work/tmp/bun-wasm-worker-review-");

for (const test of selected) {
  const control = scratch ? `${scratch}/${test.name}.cjs` : "";
  if (control) writeFileSync(control, test.code);
  const command = host === "node-control" ? [process.execPath, control]
    : host === "node" ? [process.execPath, "--no-warnings", `${root}/web/scripts/node-host.mjs`, "--wasm", artifact, "--net", "--", "-e", test.code]
    : [launcher, "--wasm", artifact, "--", "-e", test.code];
  const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timeout: boolean }>(resolve => {
    let stdout = ""; let stderr = ""; let timeout = false;
    active = spawn(command[0], command.slice(1), { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timeout = true; active?.kill("SIGKILL"); }, test.timeout ?? 90_000);
    active.stdout?.on("data", chunk => { stdout += chunk; });
    active.stderr?.on("data", chunk => { stderr += chunk; });
    active.on("close", (code, signal) => { clearTimeout(timer); active = undefined; resolve({ code, signal, stdout, stderr, timeout }); });
  });
  const pass = result.code === test.exit && !result.timeout && test.output.every(line => result.stdout.split("\n").includes(line)) && (!test.error || result.stderr.includes(test.error));
  results.push({ name: test.name, engine, host, pass, ...result });
  console.log(`${pass ? "PASS" : "FAIL"} ${engine}/${host} ${test.name} exit=${result.code}${result.timeout ? " timeout" : ""}`);
  if (!pass) console.log(JSON.stringify(result));
}
if (option("--output")) writeFileSync(option("--output"), JSON.stringify(results, null, 2) + "\n");
console.log(`${results.filter(result => result.pass).length}/${results.length} worker regressions passed`);
process.exitCode = results.every(result => result.pass) ? 0 : 1;
