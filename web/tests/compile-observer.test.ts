import { expect, test } from "bun:test";
import { installCompileObserver, observeCompile, withoutCompileSpans } from "../src/compile-observer";

const request = (kind: string) => ({ runId: `fixture-${kind}`, program: { kind }, schemaVersion: 1 });

test("browser observer emits a direct single-module compiler span", async () => {
  installCompileObserver();
  const input = request("single");
  globalThis.__bunwasmCompileObserver?.begin(input);
  await observeCompile("core", () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  const observation = globalThis.__bunwasmCompileObserver?.end(input);
  expect(observation?.spans).toHaveLength(1);
  expect(observation?.spans.map(span => span.part)).toEqual(["core"]);
});

test("browser observer leaves incomplete direct spans unavailable", async () => {
  installCompileObserver();
  const input = request("spidermonkey");
  globalThis.__bunwasmCompileObserver?.begin(input);
  await observeCompile("core", async () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  expect(globalThis.__bunwasmCompileObserver?.end(input)).toBeNull();
});

test("extra linker calls and failed compilers cannot produce a complete observation", async () => {
  installCompileObserver();
  const input = request("spidermonkey");
  const core = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const original = WebAssembly.compile;
  globalThis.__bunwasmCompileObserver?.begin(input);
  await withoutCompileSpans(async () => {
    await WebAssembly.compile(core);
    await WebAssembly.compile(core);
    await WebAssembly.compile(core);
  });
  expect(WebAssembly.compile).toBe(original);
  expect(globalThis.__bunwasmCompileObserver?.end(input)).toBeNull();
  globalThis.__bunwasmCompileObserver?.begin(request("single"));
  await expect(observeCompile("core", () => WebAssembly.compile(new Uint8Array()))).rejects.toThrow();
  expect(globalThis.__bunwasmCompileObserver?.end(request("single"))).toBeNull();
});

test("measurement shell tier is selected before workers, without inventing an engine kind", async () => {
  const { measurementEnvironment } = await import("../src/compile-observer.ts");
  expect(measurementEnvironment(new URLSearchParams())).toEqual({});
  for (const tier of ["interp", "pbl"]) {
    expect(measurementEnvironment(new URLSearchParams({ engine: "spidermonkey", "measurement-arm": `spidermonkey-${tier}`, "measurement-tier": tier })))
      .toEqual({ BUN_WASM_SPIDERMONKEY_TIER: tier });
  }
  expect(() => measurementEnvironment(new URLSearchParams({ engine: "jsc", "measurement-tier": "pbl" }))).toThrow();
});

test.skipIf(process.env.BUN_WASM_MEASUREMENT_BROWSER_FIXTURE !== "1")("Chromium real loader emits cached direct compile spans and leaves streaming time null", async () => {
  const { chromium } = await import("playwright");
  const { closeOwnedBrowser } = await import("../../scripts/app-matrix/cleanup.ts");
  const { playgroundCompileObserver } = await import("../../scripts/engine-playground-driver.ts");
  const { compileRequest, compileDuration } = await import("../../scripts/engine-compile-observation.ts");
  const { sha256 } = await import("../../scripts/engine-arm-registry.ts");
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const identity = { path: "/synthetic/bun-browser.wasm", bytes: bytes.length, sha256: sha256(bytes) };
  const arm = { label: "browser", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), program: { kind: "single", core: identity } } as const;
  const built = await Bun.build({ entrypoints: [new URL("./compile-observer-control.ts", import.meta.url).pathname], target: "browser" });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text();
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  const controls: Record<string, unknown> = { syntheticOnly: true, guestExecuted: false };
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/control.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
    if (path.endsWith(".gz")) return new Response(null, { status: 404 });
    if (path.endsWith(".wasm")) return new Response(bytes, { headers: { "content-type": "application/wasm" } });
    return new Response("<!doctype html><title>Compiler control</title>", { headers: { "content-type": "text/html" } });
  } });
  try {
    server = await chromium.launchServer({ headless: true, timeout: 5_000 });
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const direct = compileRequest(arm, "chromium", "tiny-cached-single");
      await playgroundCompileObserver.begin(page, direct);
      await page.goto(fixture.url.href);
      await page.evaluate(async digest => {
        const path = "/control.js"; const control = await import(path);
        await control.cachedSingleControl(digest);
      }, identity.sha256);
      const observation = await playgroundCompileObserver.end(page, direct);
      controls.direct = observation;
      controls.page = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin }));
      controls.chromium = browser.version();
      const duration = compileDuration(observation, direct);
      expect(duration).not.toBeNull();
      expect(duration).toBeGreaterThanOrEqual(0);
      const streaming = compileRequest(arm, "chromium", "tiny-streaming-single");
      await playgroundCompileObserver.begin(page, streaming);
      await page.evaluate(async () => { const path = "/control.js"; const control = await import(path); await control.streamingSingleControl(); });
      controls.streaming = await playgroundCompileObserver.end(page, streaming);
      expect(compileDuration(controls.streaming, streaming)).toBeNull();
    } finally { await context.close(); }
    expect(browser.contexts()).toHaveLength(0);
  } finally {
    try { if (server) await closeOwnedBrowser(server, 5_000); }
    finally { await fixture.stop(true); }
  }
  const child = server?.process();
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  expect(fixture.pendingRequests).toBe(0);
  let alive = false;
  try { if (child?.pid) { process.kill(child.pid, 0); alive = true; } }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
  expect(alive).toBe(false);
  if (process.env.BUN_WASM_MEASUREMENT_CLEANUP_RECEIPT) await Bun.write(`${process.env.BUN_WASM_MEASUREMENT_CLEANUP_RECEIPT}.compiler.json`,
    JSON.stringify({ ...controls, cleanup: { pid: child?.pid, alive, fixtureStopped: true, pendingRequests: fixture.pendingRequests } }, null, 2) + "\n");
}, 30_000);
