// Real-worker step 7a gate. Never builds WASM. Run after the matching fresh builds:
// BUN_WASM_INTERRUPTION_DIST=/absolute/dist bun tests/browser-engine-interruption.ts chromium firefox webkit
// BUN_WASM_INTERRUPTION_DIST=/absolute/dist bun tests/browser-engine-interruption.ts --benchmark safari
// Safari is actual desktop Safari via its existing WebDriver permission, not Playwright WebKit.
// The same page/worker harness runs on the Mac fleet host; do not enable automation settings here.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir, availableParallelism, loadavg } from "node:os";
import { buildBrowserEntries } from "../../scripts/browser-build";
import type { Browser } from "playwright";
import { allocateSafariDriverPort, assertSafariDriverOwnership } from "./engine-interruption-safari";

const args = process.argv.slice(2);
const benchmark = args.includes("--benchmark");
const names = args.filter(name => name !== "--benchmark");
if (!names.length) names.push("chromium", "firefox", "webkit");
for (const name of names) assert.ok(["chromium", "firefox", "webkit", "safari"].includes(name), `unknown browser ${name}`);
if (names.includes("safari")) assert.equal(process.platform, "darwin", "actual Safari runs on the Mac fleet host");
const root = resolve(import.meta.dir, "../..");
const dist = resolve(process.env.BUN_WASM_INTERRUPTION_DIST ?? join(root, "dist"));
const baselineDist = process.env.BUN_WASM_INTERRUPTION_BASELINE_DIST;
assert.ok(!baselineDist || benchmark, "baseline artifacts are used only with --benchmark");
const inputs = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"].map(name => ({ name, path: join(dist, name), route: `/${name}` }))
  .concat(baselineDist ? ["bun.wasm", "bun-jsc.wasm"].map(name => ({ name, path: resolve(baselineDist, name), route: `/baseline/${name}` })) : []);
const artifacts = await Promise.all(inputs.map(async input => {
  const info = await stat(input.path);
  assert.ok(info.isFile() && info.size > 0, `missing artifact ${input.path}`);
  return { ...input, bytes: info.size, modified: info.mtime.toISOString() };
}));
const originalTmpdir = process.env.TMPDIR;
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined, launching: Promise<Browser> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let session: string | undefined;
let stopping = false;
let cleanupPromise: Promise<void> | undefined;
const requestedDriverPort = process.env.ENGINE_INTERRUPTION_SAFARI_PORT === undefined ? 0 : Number(process.env.ENGINE_INTERRUPTION_SAFARI_PORT);
assert.ok(Number.isInteger(requestedDriverPort) && (requestedDriverPort === 0 || requestedDriverPort > 1023 && requestedDriverPort < 65536), "invalid Safari driver port");
let driverPort = 0;
async function webdriver(path: string, method = "GET", body?: unknown): Promise<any> {
  assert.ok(driver, "Safari driver not started");
  await assertSafariDriverOwnership(driver, driverPort);
  const response = await fetch(`http://127.0.0.1:${driverPort}` + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(stopping ? 3_000 : benchmark ? 540_000 : 200_000) });
  const result: any = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`Safari WebDriver ${path}: ${result.value?.message ?? response.status}`);
  return result.value;
}
async function safariScript(script: string): Promise<any> {
  const result = await webdriver(`/session/${session}/execute/async`, "POST", {
    script: `const done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error.stack||error)}));`, args: [],
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
// Install teardown before scratch, servers, browser profiles, Safari driver or workers exist.
// Closing the page/session kills even a broken bootstrap whose guest cannot acknowledge exit.
function cleanup(): Promise<void> {
  stopping = true;
  return cleanupPromise ??= (async () => {
    try {
      const ownedBrowser = browser ?? await launching?.catch(() => undefined);
      if (ownedBrowser) {
        await Promise.all(ownedBrowser.contexts().flatMap(context => context.pages().map(page =>
          page.evaluate(() => (globalThis as any).engineInterruptionHarness?.destroy()).catch(() => undefined))));
        await ownedBrowser.close();
      }
      if (session) {
        await safariScript("globalThis.engineInterruptionHarness?.destroy(); return true;").catch(() => undefined);
        await webdriver(`/session/${session}`, "DELETE").catch(() => undefined); session = undefined;
      }
    } finally {
      if (driver) { driver.kill("SIGTERM"); await driver.exited; driver = undefined; }
      server?.stop(true);
      const directory = scratch ?? await scratchCreation?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
      if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => {
  console.error("engine interruption gate exceeded its bounded deadline"); void cleanup().finally(() => process.exit(1));
}, names.length * (benchmark ? 550_000 : 210_000) + 30_000);
const reports: unknown[] = [];
try {
  const scratchRoot = process.env.TMPDIR ?? (process.platform === "linux" ? "/work/tmp" : tmpdir());
  scratch = await (scratchCreation = mkdtemp(join(scratchRoot, "bun-wasm-engine-interruption-")));
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { scratch, artifacts, browsers: names, safariDriverPort: names.includes("safari") ? driverPort : null },
    host: { platform: process.platform, arch: process.arch, logicalCpus: availableParallelism(), loadAverage: loadavg(), bun: Bun.version }, benchmark }));
  // A Mac may receive this exact browser bundle rather than copied source/dependencies.
  // The caller owns that input directory; only this run's profile/build scratch is removed.
  const out = process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE ? resolve(process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE) : join(scratch, "browser");
  if (!process.env.ENGINE_INTERRUPTION_BROWSER_BUNDLE) {
    await buildBrowserEntries([join(import.meta.dir, "engine-interruption-main.ts"), join(import.meta.dir, "engine-interruption-worker.ts"),
      join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out);
    await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./engine-interruption-main.js"></script>');
  }
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, async fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    const artifact = artifacts.find(entry => path === entry.route);
    if (artifact) return new Response(Bun.file(artifact.path), { headers: { ...headers, "Content-Type": "application/wasm" } });
    const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(file), { headers });
  } });
  const url = `http://127.0.0.1:${server.port}/${benchmark ? `?benchmark=1${baselineDist ? "&baseline=1" : ""}` : ""}`;
  for (const name of names) {
    let result: any, version: string;
    if (name === "safari") {
      driverPort = await allocateSafariDriverPort(requestedDriverPort);
      driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(driverPort)], { stdout: "ignore", stderr: "inherit" });
      console.log(JSON.stringify({ resources: { safariDriverPort: driverPort, safariDriverPid: driver.pid } }));
      for (let attempt = 0; ; attempt++) {
        try { await webdriver("/status"); break; }
        catch (error) {
          if (driver.exitCode !== null || driver.signalCode !== null || attempt >= 40) throw error;
          await Bun.sleep(100);
        }
      }
      const opened = await webdriver("/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } });
      session = opened.sessionId; version = opened.capabilities.browserVersion;
      await webdriver(`/session/${session}/timeouts`, "POST", { script: benchmark ? 530_000 : 190_000, pageLoad: 30_000, implicit: 0 });
      await webdriver(`/session/${session}/url`, "POST", { url });
      result = await safariScript(`const end=Date.now()+${benchmark ? 525_000 : 185_000}; while(!globalThis.engineInterruptionResult){if(Date.now()>end)throw Error('engine interruption page timed out');await new Promise(r=>setTimeout(r,25));} return globalThis.engineInterruptionResult;`);
      await webdriver(`/session/${session}`, "DELETE"); session = undefined;
      driver.kill("SIGTERM"); await driver.exited; driver = undefined;
    } else {
      const types = await import("playwright");
      launching = types[name as "chromium" | "firefox" | "webkit"].launch({ headless: true,
        downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
      browser = await launching;
      version = browser.version();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => (globalThis as any).engineInterruptionResult, undefined, { timeout: benchmark ? 530_000 : 190_000 });
      result = await page.evaluate(() => (globalThis as any).engineInterruptionResult);
      result.pageErrors = pageErrors;
      await browser.close(); browser = undefined; launching = undefined;
      assert.deepEqual(pageErrors, [], "page errors");
    }
    reports.push({ browser: name, version, ...result });
    console.log(JSON.stringify({ browser: name, version, ...result }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.length, 14, "twelve WASM hook/native/idle cases and two Bun light terminate cases");
    assert.equal(result.cleanup.activeWorkers, 0, "worker cleanup");
    if (benchmark) assert.equal(result.benchmarks.length, 2, "per-engine overhead measurements");
  }
} finally {
  clearTimeout(deadline); await cleanup();
  if (process.env.ENGINE_INTERRUPTION_OUTPUT) await Bun.write(process.env.ENGINE_INTERRUPTION_OUTPUT, JSON.stringify({ artifacts, reports, cleanup: { scratchRemoved: true, listenerClosed: true, browsersClosed: true, driverStopped: true } }, null, 2) + "\n");
  console.log("cleanup: owned worker contexts/browsers closed, Safari driver stopped, listener closed, build/profile scratch removed");
}
