// source env.sh && BUN_WASM_RUNTIME_PROC_ARTIFACT=/absolute/path/bun-browser.wasm \
//   bun /work/platform-production/heavy/current/run.js --class browser bun-runtime-proc -- \
//   bun web/tests/bun-runtime-proc-browser.ts chromium
// No artifact fallback, build, installation or download is hidden inside this acceptance gate.
// BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT=1 explicitly enables public immutable guest downloads.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Browser, Page } from "playwright";
import { bunRuntimeProcScenarios } from "./bun-runtime-proc-fixtures";
import { bunRuntimeProcSmoke } from "./bun-runtime-proc-smoke";
import { BUN_WASM_ASSET } from "../../src/guest-asset.generated.js";

const engine = process.env.BUN_WASM_RUNTIME_PROC_ENGINE ?? "browser";
assert.ok(["browser", "quickjs", "jsc"].includes(engine), "explicit matching guest engine required");
const publishedDefault = process.env.BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT === "1";
if (publishedDefault) {
  assert.equal(engine, "browser", "only the browser engine has a published default");
  assert.ok(BUN_WASM_ASSET, "published-default acceptance requires a generated descriptor");
}
const requestedArtifact = process.env.BUN_WASM_RUNTIME_PROC_ARTIFACT;
assert.ok(requestedArtifact && isAbsolute(requestedArtifact), "BUN_WASM_RUNTIME_PROC_ARTIFACT must name the explicit absolute matching rebuilt Bun artifact for the selected engine; acceptance is pending without it");
assert.ok(await Bun.file(requestedArtifact).exists(), `explicit Bun artifact does not exist: ${requestedArtifact}; rebuild belongs to the guest lane`);
const artifact = await realpath(requestedArtifact);
const bytes = new Uint8Array(await Bun.file(artifact).arrayBuffer());
assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0], "explicit artifact must be Wasm version 1");
const artifactModule = new WebAssembly.Module(bytes);
const procImports = WebAssembly.Module.imports(artifactModule).filter(entry => entry.module === "runtime_proc").map(entry => entry.name);
for (const name of ["spawn", "pipe", "read", "write", "wait", "wait_job", "kill", "kill_job", "poll", "job_of", "signal", "start_status", "access_start", "access_take", "access_cancel", "fd_kind"]) {
  assert.ok(procImports.includes(name), `matching rebuilt guest must directly import runtime_proc.${name}; an older slot-backed artifact does not prove step7b`);
}
const artifactReceipt = { engine, path: artifact, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), procImports };
if (publishedDefault) {
  assert.equal(BUN_WASM_ASSET!.bytes, artifactReceipt.bytes, "published descriptor matches exact-merge build size");
  assert.equal(BUN_WASM_ASSET!.sha256, artifactReceipt.sha256, "published descriptor matches exact-merge build hash");
}
if (process.argv.includes("--check-artifact")) {
  console.log(JSON.stringify({ ready: true, artifact: artifactReceipt, acceptance: "pending browser execution" }));
  process.exit(0);
}
const names = process.argv.slice(2);
if (!names.length) names.push("chromium");
assert.ok(names.every(name => ["chromium", "firefox", "webkit"].includes(name)), "known cached browser required");
const requestedSite = process.env.BUN_WASM_RUNTIME_PROC_SITE_DIR;
if (requestedSite) assert.ok(isAbsolute(requestedSite), "optional production site build must be an explicit absolute directory");
const site = requestedSite ? await realpath(requestedSite) : undefined;
if (site) for (const path of ["index.html", "playground/index.html"]) assert.ok(await Bun.file(join(site, path)).exists(), `production site build is missing ${path}`);
const selected = process.env.BUN_WASM_RUNTIME_PROC_SCENARIO;
const scenarios = selected ? [selected] : ["generic-control"].concat(bunRuntimeProcScenarios.map(scenario => scenario.name));
assert.ok(scenarios.every(name => name === "generic-control" || bunRuntimeProcScenarios.some(scenario => scenario.name === name)), "known Bun runtime_proc scenario required");
const originalTmpdir = process.env.TMPDIR;
let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
// Existing resources are caller-owned artifact, installed packages, and shared browser cache.
// Created resources are precisely this ephemeral listener, browser/profile and scratch bundle.
// Install teardown before setup; signals, assertion failures and the overall deadline all use it.
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      const directory = scratch ?? await scratchCreation?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
      if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("Bun runtime_proc gate deadline exceeded"); void cleanup().finally(() => process.exit(1)); }, Math.max(120_000, names.length * scenarios.length * 100_000));
let ownedPort: number | undefined;
async function runScenario(browser: Browser, name: string, scenario: string) {
  let failed = false;
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  const guestRequests: string[] = [];
  page.on("request", request => {
    if (request.url() === BUN_WASM_ASSET?.url || new URL(request.url()).pathname === "/bun-guest.wasm") guestRequests.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(`http://127.0.0.1:${ownedPort}/?engine=${engine}&scenario=${encodeURIComponent(scenario)}${publishedDefault ? "&published-default" : ""}`);
    await page.waitForFunction(() => Reflect.get(globalThis, "bunRuntimeProcResult"), undefined, { timeout: 90_000 });
    const result = await page.evaluate(() => Reflect.get(globalThis, "bunRuntimeProcResult"));
    console.log(JSON.stringify({ browser: name, version: browser.version(), scenario, artifact: artifactReceipt, publishedDefault, guestRequests, result, pageErrors: errors }));
    if (publishedDefault) {
      // The generic byte fixture and throwing module provider never enter a Bun guest.
      const expectedRequests = scenario === "generic-control" || scenario === "start-failed" ? [] : [BUN_WASM_ASSET!.url];
      assert.deepEqual(guestRequests, expectedRequests, "public default loads only for guest entry, exactly once without a local artifact fallback");
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.cleanup.activeWorkers, 0, "normal path must stop all workers, not rely on forced teardown");
    assert.deepEqual(result.teardown, { forcedWorkers: 0, activeWorkers: 0 });
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    const diagnostics = await page.evaluate(() => Reflect.get(globalThis, "bunRuntimeProcDiagnostics")?.()).catch(error => ({ diagnosticsError: String(error) }));
    console.error(JSON.stringify({ browser: name, scenario, artifact: artifactReceipt, error: String(error), diagnostics, pageErrors: errors }));
  } finally { await page.close(); }
  return failed;
}

async function runSiteSmoke(browser: Browser, name: string) {
  if (!site) return false;
  try { console.log(JSON.stringify({ browser: name, siteSmoke: await bunRuntimeProcSmoke(browser, `http://127.0.0.1:${ownedPort}`) })); }
  catch (error) { console.error(JSON.stringify({ browser: name, siteSmoke: { ok: false, error: String(error) } })); return true; }
  return false;
}

try {
  const { chromium, firefox, webkit } = await import("playwright");
  const { buildBrowserEntries } = await import("../../scripts/browser-build");
  const types = { chromium, firefox, webkit };
  for (const name of names) assert.ok(existsSync(types[name as keyof typeof types].executablePath()), `cached ${name} required; this gate never downloads browsers`);
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? originalTmpdir ?? tmpdir();
  scratch = await (scratchCreation = mkdtemp(join(base, "bun-wasm-bun-runtime-proc-")));
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { existing: { artifact: artifactReceipt, installedPackages: "read only", browserCaches: "read only" },
    created: { scratch, listener: "ephemeral loopback", browsers: names, downloads: publishedDefault ? { immutableGuest: BUN_WASM_ASSET!.url, storage: "browser memory only" } : "none" } }, siteSmoke: site ? { build: site } : "pending: provide BUN_WASM_RUNTIME_PROC_SITE_DIR for production site/sandbox smoke" }));
  const root = resolve(import.meta.dir, "../.."), out = join(scratch, "dist");
  await buildBrowserEntries([join(import.meta.dir, "bun-runtime-proc-main.ts"), join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./bun-runtime-proc-main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (url.pathname === "/bun-guest.wasm") return new Response(Bun.file(artifact), { headers: { ...headers, "Content-Type": "application/wasm" } });
    if (url.pathname === "/bun-browser.wasm.gz" && site) return new Response(Bun.gzipSync(bytes), { headers });
    if (url.pathname.startsWith("/site/") && site) {
      const suffix = url.pathname.slice("/site".length);
      const path = resolve(site, `.${suffix.endsWith("/") ? `${suffix}index.html` : suffix}`);
      if (!path.startsWith(site + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
      return new Response(Bun.file(path), { headers });
    }
    const path = resolve(out, `.${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  ownedPort = server.port;
  console.log(JSON.stringify({ listener: `127.0.0.1:${ownedPort}`, artifact: artifactReceipt }));
  let failed = false;
  for (const name of names) {
    launching = types[name as keyof typeof types].launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
    browser = await launching;
    for (const scenario of scenarios) {
      failed = await runScenario(browser, name, scenario) || failed;
    }
    console.log(JSON.stringify({ browser: name, executedScenarios: scenarios.length, retries: 0 }));
    failed = await runSiteSmoke(browser, name) || failed;
    await browser.close(); browser = undefined; launching = undefined;
  }
  assert.equal(failed, false, "external Runtime + real Bun acceptance failed (see scenario evidence)");
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false, "task scratch removed on actual host");
  if (ownedPort) {
    const probe = Bun.connect({ hostname: "127.0.0.1", port: ownedPort, socket: { data() {}, open(socket) { socket.end(); } } });
    assert.equal(await probe.then(() => true, () => false), false, "task listener released on actual host");
  }
  console.log(JSON.stringify({ cleanup: { scratchRemoved: true, listenerStopped: true, browsersClosed: true, callerArtifactPreserved: await Bun.file(artifact).exists() } }));
}
