// Artifact-free actual Worker ABI gate. No downloads, guest compiler or Bun WASM rebuild.
// source env.sh && bun web/tests/browser-runtime-proc.ts chromium
// Defaults to cached Chromium; pass firefox/webkit explicitly to extend the matrix.
// Bounded stress: RUNTIME_PROC_ITERATIONS=300 RUNTIME_PROC_SCENARIO=job-wait RUNTIME_PROC_MODE=automatic
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { processBundle } from "../scripts/ci-process-bundles";
import { runtimeProcChecks, runtimeProcJobWaitChecks } from "./runtime-proc-fixtures";
import { runtimeProcFailure } from "./runtime-proc-browser-diagnostics";

type RuntimeProcResult = Record<string, unknown> & {
  ok: boolean;
  checks: string[];
  stopCodes: number[];
  admissionReports: number;
  cleanup: { activeWorkers: number };
  teardown: { forcedWorkers: number; activeWorkers: number };
};

const iterations = Number(process.env.RUNTIME_PROC_ITERATIONS ?? "1");
assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 1000, "bounded positive repeat count required");
const modes = process.env.RUNTIME_PROC_MODE ? [process.env.RUNTIME_PROC_MODE] : ["automatic", "explicit"];
const scenarios = process.env.RUNTIME_PROC_SCENARIO ? [process.env.RUNTIME_PROC_SCENARIO] : ["pipes", "job-wait"];
assert.ok(modes.every(mode => mode === "automatic" || mode === "explicit"), "known runtime_proc mode required");
assert.ok(scenarios.every(scenario => scenario === "pipes" || scenario === "job-wait"), "known runtime_proc scenario required");
const names = process.argv.slice(2);
if (!names.length) names.push("chromium");
const types = { chromium, firefox, webkit };
for (const name of names) {
  if (!(name in types)) throw new Error(`unknown browser ${name}`);
  assert.ok(existsSync(types[name as keyof typeof types].executablePath()), `cached ${name} browser required; this gate never downloads dependencies`);
}
const originalTmpdir = process.env.TMPDIR;
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
// Install teardown before setup. Only the ephemeral listener, this run's browser and its scratch
// (bundles, browser profile, downloads and traces) belong to this run; shared browser caches do not.
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      try { const directory = scratch ?? await scratchCreation?.catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("runtime_proc browser gate timed out"); void cleanup().finally(() => process.exit(1)); }, Math.max(120_000, names.length * iterations * modes.length * scenarios.length * 40_000));
try {
  const checkRuntimeProcCase = async () => {
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? originalTmpdir ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  scratch = await (scratchCreation = mkdtemp(join(base, "bun-wasm-runtime-proc-browser-")));
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { scratch, listener: "ephemeral loopback port", browsers: names, downloads: "none", wasm: "original byte-encoded guest" } }));
  // A captured pre-wiring bundle can run after implementation changes without checking out or
  // modifying shared source. External bundles are caller-owned and are never removed by this gate.
  const captured = process.env.BUN_WASM_RUNTIME_PROC_BUNDLE;
  const out = captured ? resolve(captured) : join(scratch, "dist");
  if (captured) assert.ok(await Bun.file(join(out, "index.html")).exists(), "captured bundle needs index.html");
  else await processBundle("runtime-proc", out);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
      const path = resolve(out, `.${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`);
      if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
      return new Response(Bun.file(path), { headers });
    },
  });
  let failed = false;
  for (const name of names) {
    launch = types[name as keyof typeof types].launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launch;
    const cases: { iteration: number; scenario: string; mode: string }[] = Array.from({ length: iterations }, (_, index) => index + 1).flatMap(iteration =>
      scenarios.flatMap(scenario => modes.map(mode => ({ iteration, scenario, mode }))));
    for (const { iteration, scenario, mode } of cases) {
      const page: Page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      let result: RuntimeProcResult | undefined;
      try {
        // slots=off also lets the pre-wiring baseline fail on missing ABI imports, rather than
        // on unrelated Bun slot setup; the production preview1 adapter independently skips slots.
        await page.goto(`http://127.0.0.1:${server.port}/?slots=off${mode === "explicit" ? "&explicit=1" : ""}${scenario === "job-wait" ? "&job-wait=1" : ""}`);
        await page.waitForFunction(() => (globalThis as any).runtimeProcResult, undefined, { timeout: 40_000 });
        const completed: RuntimeProcResult = await page.evaluate(() => (globalThis as any).runtimeProcResult);
        result = completed;
        assert.equal(completed.ok, true, JSON.stringify(completed));
        assert.deepEqual(completed.checks, Array.from<string>(scenario === "job-wait" ? runtimeProcJobWaitChecks : runtimeProcChecks));
        assert.deepEqual(completed.stopCodes, scenario === "pipes" ? [130, 137] : []);
        assert.equal(completed.cleanup.activeWorkers, 0);
        assert.equal(completed.teardown.forcedWorkers, 0);
        assert.equal(completed.teardown.activeWorkers, 0);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ browser: name, version: browser.version(), iteration, mode, scenario, ok: true,
          checks: completed.checks, stopCodes: completed.stopCodes, admissionReports: completed.admissionReports, cleanup: completed.cleanup, teardown: completed.teardown, pageErrors: errors }));
      } catch (error) {
        failed = true;
        console.error(await runtimeProcFailure({ browser: name, version: browser.version(), iteration, mode, scenario, pageErrors: errors }, error, result,
          () => page.evaluate(() => (globalThis as any).runtimeProcDiagnostics?.())));
        console.error(error);

      } finally { await page.close(); }
      if (failed && iterations > 1) break;
    }
    await browser.close(); browser = undefined; launch = undefined;
    if (failed && iterations > 1) break;
  }
  assert.equal(failed, false, "real worker runtime_proc regression gate failed (see mode results above)");

  };
  await checkRuntimeProcCase();
} finally { clearTimeout(deadline); await cleanup(); console.log("cleanup: owned browsers closed, ephemeral listener stopped, scratch removed"); }
