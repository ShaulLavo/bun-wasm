import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { campaignDeadlines, cellDeadlines } from "./deadlines";
import { createPlaywrightTransport } from "./transport";
import { execute } from "./execute";
import { frameworks } from "./catalog";

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

test.each(["navigation", "cache and service worker"])("Firefox counts pending %s inside product startup", async stage => {
  const pending = Promise.withResolvers<Response>();
  const cache = "goals-startup-" + crypto.randomUUID();
  let serviceWorkerRequested = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/sw.js") { serviceWorkerRequested = true; return pending.promise; }
    if (stage === "navigation") return pending.promise;
    return new Response(`<div id="status">Starting</div><select id="engine"><option>browser</option></select><script type="module">
      globalThis.cacheOpened = false;
      await caches.open(${JSON.stringify(cache)});
      globalThis.cacheOpened = true;
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      document.querySelector('#status').textContent = 'Browser (native) ready';
      globalThis.playground = { profile: 'split' };
    </script>`, { headers: { "content-type": "text/html" } });
  } });
  let transport: Awaited<ReturnType<typeof createPlaywrightTransport>> | undefined;
  let cacheOpened: unknown;
  const framework = frameworks[0]!;
  const startupTimeoutMs = stage === "navigation" ? 1000 : 5000;
  try {
    const result = await execute({ box: { framework: framework.id, browser: "firefox", engine: "browser" }, framework,
      url: `${server.url}?engine=browser`, timeoutMs: 100, startupTimeoutMs,
      async createTransport() {
        const owned = await createPlaywrightTransport("firefox", 100);
        transport = owned;
        return { ...owned, async close() {
          try { cacheOpened = await withScoped(owned, page => page.evaluate("globalThis.cacheOpened"), 1000); }
          finally { await owned.close(); }
        } };
      },
      async saveLog() {},
    });
    expect(result).toMatchObject({ status: "fail", phase: "startup" });
    expect(result.attempts[0]?.harnessSetup?.status).toBe("pass");
    expect(result.attempts[0]?.phases[0]?.durationMs).toBeGreaterThanOrEqual(startupTimeoutMs - 100);
    expect(result.attempts[0]?.phases.map(phase => phase.phase)).toEqual(["startup", "cleanup"]);
    if (stage === "cache and service worker") {
      expect(cacheOpened).toBe(true);
      expect(serviceWorkerRequested).toBe(true);
    }
  } finally {
    pending.resolve(new Response("self.addEventListener('install', () => self.skipWaiting())", { headers: { "content-type": "text/javascript" } }));
    await transport?.close();
    await server.stop(true);
  }
}, 20_000);
