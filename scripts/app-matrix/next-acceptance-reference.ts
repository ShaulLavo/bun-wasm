// A native control validates the fixture and public-URL assertions; it never supplies an engine acceptance result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureSources, stageFixture } from "./next-acceptance-fixture";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { stopProcessGroup } from "../../web/tests/next-framework-process";
import { observeNativeProductTraffic } from "./product-browser";
import { editCycle, compileErrorRecovery } from "./next-acceptance-edits";
import { routeCases, runRouteCase, overlappingRequests } from "./next-acceptance-cases";

const reports = resolve(process.argv[2] ?? "/work/reports/wave-20261029/bun/next01/native-reference");
const port = Number(process.env.NEXT_REFERENCE_PORT ?? "43702");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-nref-"));
process.env.TMPDIR = join(scratch, "t");
mkdirSync(process.env.TMPDIR);
const fixture = resolve(import.meta.dir, "../../examples/next-acceptance");
const children: ReturnType<typeof spawn>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cleaned: Promise<void> | undefined;
const cleanup = () => cleaned ??= release();
async function release() {
  await browser?.close();
  for (const child of children) await stopProcessGroup(child);
  rmSync(scratch, { recursive: true, force: true });
}
async function nativeCommand(args: string[], name: string) {
  const child = spawn("bun", args, { cwd: scratch, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  children.push(child);
  child.stdout?.on("data", data => appendFileSync(join(reports, name), data));
  child.stderr?.on("data", data => appendFileSync(join(reports, name), data));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
      timer = setTimeout(() => reject(new Error(`Native command timed out: bun ${args.join(" ")}`)), 120000);
    });
    assert.equal(result, 0, `bun ${args.join(" ")}; see ${name}`);
  } finally { clearTimeout(timer); await stopProcessGroup(child); }
}

async function waitServer(base: string, child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch(base, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return;
    if (child.exitCode !== null) throw new Error(`Native server exited ${child.exitCode}`);
    await Bun.sleep(100);
  }
  throw new Error("Native reference readiness timed out");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
mkdirSync(reports, { recursive: true });
const results: { phase: string; status: string; detail: string }[] = [];
try {
  const staged = stageFixture(fixtureSources(fixture));
  for (const [path, contents] of Object.entries(staged.files)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), contents);
  }
  writeFileSync(join(reports, "config.json"), JSON.stringify(staged.config, null, 2));
  const lock = readFileSync(join(scratch, "bun.lock"), "utf8");
  await nativeCommand(["install", "--frozen-lockfile", "--ignore-scripts"], "install.log");
  assert.equal(readFileSync(join(scratch, "bun.lock"), "utf8"), lock);
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  const child = spawn("bun", ["run", "launch.ts", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: scratch, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  children.push(child);
  child.stdout?.on("data", data => appendFileSync(join(reports, "dev.log"), data));
  child.stderr?.on("data", data => appendFileSync(join(reports, "dev.log"), data));
  const base = `http://127.0.0.1:${port}/`;
  await waitServer(base, child);
  page.on("websocket", socket => socket.on("framereceived", frame => appendFileSync(join(reports, "websocket.jsonl"), JSON.stringify({ url: socket.url(), payload: frame.payload.toString() }) + "\n")));
  const traffic = await observeNativeProductTraffic(page);
  for (const name of routeCases) {
    await runRouteCase(name, page, base);
    results.push({ phase: name, status: "pass", detail: "Native control only" });
    process.stdout.write(`reference ${name}: pass\n`);
  }
  const source = { read: async (path: string) => readFileSync(join(scratch, path), "utf8"), write: async (path: string, text: string) => { writeFileSync(join(scratch, path), text); } };
  for (let index = 0; index < 3; index++) await editCycle(page, base, source, traffic, index, 60000, async () => {});
  await compileErrorRecovery(page, base, source);
  await overlappingRequests(page, base, "reference-after-errors");
  results.push({ phase: "edits-and-recovery", status: "pass", detail: "Three edit/revert cycles; compile error/fix; overlap after errors" });
  await traffic.close();
  await stopProcessGroup(child);
  await nativeCommand(["run", "launch.ts", "build", "--webpack"], "build.log");
  assert.ok(readFileSync(join(scratch, ".next/BUILD_ID"), "utf8"));
  const production = spawn("bun", ["run", "launch.ts", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: scratch, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  children.push(production);
  production.stdout?.on("data", data => appendFileSync(join(reports, "start.log"), data));
  production.stderr?.on("data", data => appendFileSync(join(reports, "start.log"), data));
  await waitServer(base, production);
  for (const name of routeCases) {
    await runRouteCase(name, page, base);
    results.push({ phase: `production:${name}`, status: "pass", detail: "Native production control only" });
  }
} catch (error) {
  results.push({ phase: "reference", status: "fail", detail: String(error) });
  process.exitCode = 1;
} finally {
  await cleanup();
  writeFileSync(join(reports, "results.json"), JSON.stringify({ control: "native Bun", version: Bun.version, results, cleanup: "pass" }, null, 2));
}
