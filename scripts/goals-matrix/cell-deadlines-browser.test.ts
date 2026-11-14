import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { campaignDeadlines, cellDeadlines } from "./deadlines";
import { createPlaywrightTransport } from "./transport";
import { execute } from "./execute";
import { frameworks } from "./catalog";
import type { PhaseResult } from "./model";

test("the real Firefox transport enforces the calibrated Browser cell navigation timeout", async () => {
  const limits = cellDeadlines(campaignDeadlines(), { framework: "next", browser: "firefox", engine: "browser" });
  const stalled = Promise.withResolvers<Response>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => stalled.promise });
  let transport: Awaited<ReturnType<typeof createPlaywrightTransport>> | undefined;
  try {
    transport = await createPlaywrightTransport("firefox", limits.timeoutMs);
    await expect(withScoped(transport, page => page.navigate(server.url.href), limits.timeoutMs)).rejects.toThrow(/(?:Phase timed out after|Timeout)/);
  } finally {
    stalled.resolve(new Response("owned fixture stopped"));
    await transport?.close();
    await server.stop(true);
  }
}, 15_000);

test.each(["navigation", "cache storage", "service worker"])("Firefox counts pending %s inside product startup", async stage => {
  const pending = Promise.withResolvers<Response>();
  const cache = "goals-startup-" + crypto.randomUUID();
  let serviceWorkerRequested = false;
  let serviceWorkerRequestedAt: number | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/sw.js") { serviceWorkerRequested = true; serviceWorkerRequestedAt = Date.now(); return pending.promise; }
    if (stage === "navigation") return pending.promise;
    const initialization = stage === "cache storage"
      ? `const held = new Promise(resolve => { globalThis.releaseInitialization = resolve; });
         const initializing = Promise.all([caches.open(${JSON.stringify(cache)}), held]);`
      : "const initializing = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);";
    return new Response(`<div id="status">Starting</div><select id="engine"><option>browser</option></select><script type="module">
      globalThis.initializationError = null;
      ${initialization}
      globalThis.initializationStartedAt = Date.now();
      try { await initializing; }
      catch (error) { globalThis.initializationError = String(error); throw error; }
      document.querySelector('#status').textContent = 'Browser (native) ready';
      globalThis.playground = { profile: 'split' };
    </script>`, { headers: { "content-type": "text/html" } });
  } });
  let transport: Awaited<ReturnType<typeof createPlaywrightTransport>> | undefined;
  let initializationState: unknown;
  const framework = frameworks[0]!;
  const startupTimeoutMs = stage === "navigation" ? 1000 : 5000;
  try {
    const result = await execute({ box: { framework: framework.id, browser: "firefox", engine: "browser" }, framework,
      url: `${server.url}?engine=browser`, timeoutMs: 100, startupTimeoutMs,
      async createTransport() {
        const owned = await createPlaywrightTransport("firefox", 100);
        transport = owned;
        return { ...owned, async close() {
          try {
            initializationState = await withScoped(owned, page => page.evaluate(`(() => {
              const state = { startedAt: globalThis.initializationStartedAt, error: globalThis.initializationError };
              globalThis.releaseInitialization?.();
              return state;
            })()`), 1000);
          }
          finally { await owned.close(); }
        } };
      },
      async saveLog() {},
    });
    expect(result).toMatchObject({ status: "fail", phase: "startup" });
    expect(result.attempts[0]?.harnessSetup?.status).toBe("pass");
    expect(result.attempts[0]?.phases[0]?.durationMs).toBeGreaterThanOrEqual(startupTimeoutMs - 100);
    expect(result.attempts[0]?.phases.map(phase => phase.phase)).toEqual(["startup", "cleanup"]);
    const startup = result.attempts[0]?.phases[0];
    if (stage !== "navigation") expectInitializationDuringStartup(initializationState, startup);
    if (stage === "cache storage") expect(serviceWorkerRequested).toBe(false);
    if (stage === "service worker") {
      expect(serviceWorkerRequested).toBe(true);
      expectStartedDuringStartup(serviceWorkerRequestedAt, startup);
    }
  } finally {
    pending.resolve(new Response("self.addEventListener('install', () => self.skipWaiting())", { headers: { "content-type": "text/javascript" } }));
    await transport?.close();
    await server.stop(true);
  }
}, 20_000);

function expectInitializationDuringStartup(state: unknown, startup: PhaseResult | undefined): void {
  if (!state || typeof state !== "object" || !("startedAt" in state)) throw new Error("Initialization was not observed");
  expect(state).toMatchObject({ error: null });
  expectStartedDuringStartup(state.startedAt, startup);
}

function expectStartedDuringStartup(startedAt: unknown, startup: PhaseResult | undefined): void {
  if (typeof startedAt !== "number" || !startup) throw new Error("Missing initialization clock observation");
  expect(startedAt).toBeGreaterThanOrEqual(Date.parse(startup.startedAt));
  expect(startedAt).toBeLessThanOrEqual(Date.parse(startup.startedAt) + startup.durationMs + 1);
}
