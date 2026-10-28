import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { waitForPreviewReady } from "./app-matrix/product-browser";
import { browserRegistryRoute } from "./app-matrix/registry-request";

// Real Chromium against loopback servers: the probe page must reach the preview the way the
// application page will (same context, routing, service worker and redirects) without running it.

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

const html = (body: string, status = 200) => new Response(`<!doctype html>${body}`, { status, headers: { "content-type": "text/html" } });

async function withServer(fetch: (request: Request) => Response | Promise<Response>, run: (origin: string, context: BrowserContext) => Promise<void>): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  const context = await browser.newContext({ serviceWorkers: "allow" });
  try { await run(server.url.origin, context); }
  finally {
    await context.close();
    await server.stop(true);
  }
}

test("the probe never runs application scripts, including a self-reloading 503 loading page", async () => {
  let effects = 0;
  let loading = 2;
  await withServer(request => {
    const path = new URL(request.url).pathname;
    if (path === "/effect") { effects++; return new Response("ok"); }
    if (loading-- > 0) return html(`<script>fetch("/effect"); setTimeout(() => location.reload(), 5)</script>Loading`, 503);
    return html(`<script>fetch("/effect")</script>ready`);
  }, async (origin, context) => {
    const probe = await context.newPage();
    await waitForPreviewReady(probe, `${origin}/`, Date.now() + 5_000);
    await probe.close();
    expect(effects).toBe(0);
    const app = await context.newPage();
    await app.goto(`${origin}/`);
    await app.waitForFunction(() => performance.getEntriesByType("resource").some(entry => entry.name.endsWith("/effect")));
    expect(effects).toBe(1);
  });
}, 20_000);

test("a 503 followed by an ordinary redirect to a ready page passes like normal navigation", async () => {
  let requests = 0;
  await withServer(request => {
    if (new URL(request.url).pathname === "/ready") return html("ready");
    return requests++ === 0 ? html("Loading", 503) : new Response(null, { status: 302, headers: { location: "/ready" } });
  }, async (origin, context) => {
    await waitForPreviewReady(await context.newPage(), `${origin}/`, Date.now() + 5_000);
    expect(requests).toBe(2);
  });
}, 20_000);

test("the probe stays behind the context network guard", async () => {
  const external: string[] = [];
  await withServer(() => html("unused"), async (_origin, context) => {
    await context.route("**/*", route => browserRegistryRoute(route, "http://127.0.0.1:1", external));
    const failure = await waitForPreviewReady(await context.newPage(), "https://example.com/preview", Date.now() + 5_000).catch(error => error);
    expect(String(failure)).toContain("net::ERR_FAILED");
    expect(external).toEqual(["https://example.com/preview"]);
  });
}, 20_000);

test("a non-503 HTTP failure is reported without a retry", async () => {
  let requests = 0;
  await withServer(() => { requests++; return new Response("server crashed", { status: 500 }); }, async (origin, context) => {
    await expect(waitForPreviewReady(await context.newPage(), `${origin}/`, Date.now() + 5_000)).rejects.toThrow("Preview HTTP 500: server crashed");
    expect(requests).toBe(1);
  });
}, 20_000);

test("stalled response headers stop at the shared deadline", async () => {
  await withServer(() => new Promise<Response>(() => {}), async (origin, context) => {
    const started = performance.now();
    await expect(waitForPreviewReady(await context.newPage(), `${origin}/`, Date.now() + 1_000)).rejects.toThrow("not HTTP-ready before the deadline: no complete response");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
}, 20_000);

test("a stalled 503 body stops at the shared deadline and keeps the last complete 503 body", async () => {
  let requests = 0;
  await withServer(() => {
    if (requests++ === 0) return html("Loading: prior 503", 503);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html>partial")); } });
    return new Response(body, { status: 503, headers: { "content-type": "text/html" } });
  }, async (origin, context) => {
    const started = performance.now();
    await expect(waitForPreviewReady(await context.newPage(), `${origin}/`, Date.now() + 2_000)).rejects.toThrow("last HTTP 503: <!doctype html>Loading: prior 503");
    expect(performance.now() - started).toBeLessThan(3_000);
  });
}, 20_000);

const previewWorker = `
let starting = 2;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (!new URL(event.request.url).pathname.startsWith("/__preview/")) return;
  const status = starting-- > 0 ? 503 : 200;
  event.respondWith(new Response("<!doctype html><script>fetch('/effect')</script>" + (status === 503 ? "Loading" : "ready"), { status, headers: { "content-type": "text/html" } }));
});`;

test("a mounted service-worker preview is probed through its worker with page scripts disabled", async () => {
  let effects = 0;
  let previewRequests = 0;
  await withServer(request => {
    const path = new URL(request.url).pathname;
    if (path === "/sw.js") return new Response(previewWorker, { headers: { "content-type": "text/javascript" } });
    if (path === "/effect") { effects++; return new Response("ok"); }
    if (path.startsWith("/__preview/")) { previewRequests++; return new Response("bypassed the worker", { status: 404 }); }
    return html("playground");
  }, async (origin, context) => {
    const playground = await context.newPage();
    await playground.goto(`${origin}/`);
    await playground.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/__preview/" });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (worker?.state === "activated") return;
      await new Promise<void>(resolve => worker?.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); }));
    });
    const probe = await context.newPage();
    await waitForPreviewReady(probe, `${origin}/__preview/3137/`, Date.now() + 5_000);
    expect(previewRequests).toBe(0);
    expect(effects).toBe(0);
  });
}, 20_000);
