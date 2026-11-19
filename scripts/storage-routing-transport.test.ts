import { afterEach, expect, test } from "bun:test";
import { chromium, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { instrumentWorker } from "./storage-routing-build-source";
import { StorageLifetime } from "./storage-browser-evidence";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

const lifetimes: StorageLifetime[] = [];
afterEach(async () => { await Promise.all(lifetimes.splice(0).map(lifetime => lifetime.cleanup())); });

for (const engine of [chromium, webkit]) test(`${engine.name()}: SW transport and delayed metadata survive failure and context closure`, async () => {
  const events: Parameters<NonNullable<ConstructorParameters<typeof StorageLifetime>[0]>>[0][] = [];
  const primary = Error("Original preservation failure");
  const evidenceFailure = Error("Routing report write failed");
  const lifetime = new StorageLifetime(event => { events.push(event); if (event.kind === "routing-final") throw evidenceFailure; });
  lifetimes.push(lifetime);
  let closeContext: (() => Promise<void>) | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  lifetime.own("server.stop", async () => { await server?.stop(true); });
  await expect(lifetime.run(async () => {
    const runtime = readFileSync(resolve(import.meta.dir, "../sandbox/node_modules/waffle/browser/service-worker.ts"), "utf8");
    const collector = readFileSync(resolve(import.meta.dir, "storage-routing-collector.ts"), "utf8");
    const script = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(collector + "\n" + instrumentWorker(runtime).replaceAll("export ", "") + `
      const worker = self as unknown as ServiceWorkerGlobalScope;
      const router = createPreviewServiceWorker({ scope: worker.registration.scope, clients: worker.clients, fetch: request => fetch(request) });
      worker.addEventListener("install", () => void worker.skipWaiting());
      worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
      worker.addEventListener("fetch", event => { const response = router.fetch(event.request, event.clientId); if (response) event.respondWith(response); });
    `);
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      return new URL(request.url).pathname === "/sw.js" ? new Response(script, { headers: { "content-type": "text/javascript" } }) : new Response("<!doctype html><h1>Transport control</h1>", { headers: { "content-type": "text/html" } });
    } });
    const { value: browser } = await lifetime.acquire("browser.open", () => engine.launch(), async browser => { await closeContext?.(); await browser.close(); });
    const acquired = await lifetime.acquire("context.open", () => browser.newContext(), context => context.close());
    closeContext = acquired.release;
    const context = acquired.value;
    await lifetime.observeContext(context);
    const page = await context.newPage();
    await navigateTestPage(page, server.url.href);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/__preview/" });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (!worker) throw Error("Missing actual SW");
      await new Promise<void>(resolve => {
        const check = () => { if (worker.state === "activated") resolve(); };
        worker.addEventListener("statechange", check); check();
      });
    });
    // Real native SW processing, intentionally empty discovery is covered by source controls.
    await page.addScriptTag({ content: new Bun.Transpiler({ loader: "ts" }).transformSync(collector) });
    await page.evaluate(() => navigator.serviceWorker.addEventListener("message", event => {
      if (event.data?.type !== "preview-request") return;
      event.ports[0]?.postMessage({ type: "none" });
      event.ports[0]?.close();
    }));
    const response = page.waitForResponse(response => response.url().endsWith("/src/main.ts"));
    const observed = page.waitForEvent("console", message => message.text().startsWith("[storage-routing] ") && message.text().includes("sw-fetch"));
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = "/__preview/5173/src/main.ts"; document.body.appendChild(frame); });
    await observed;
    const nativeResponse = await response;
    expect(nativeResponse.fromServiceWorker()).toBe(true);
    await nativeResponse.finished();
    lifetime.event("preservation-error", { fixture: "injected failure after actual SW delivery" });
    const late = page.waitForEvent("console", message => message.text().includes("delayed-metadata"));
    await page.evaluate(() => console.debug("[storage-routing] " + JSON.stringify({ kind: "delayed-metadata", generation: "late-control", sequence: 1 })));
    await late;
    expect(JSON.stringify(events)).toContain("sw-fetch");
    expect(browser.isConnected()).toBe(true);
    await acquired.release();
    throw primary;
  })).rejects.toBe(primary);
  const final = events.find(event => event.kind === "routing-final");
  expect(JSON.stringify(final)).toContain("delayed-metadata");
  expect(events.some(event => event.kind === "context-close")).toBe(true);
  expect(lifetime.failures).toEqual([evidenceFailure]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
}, 60_000);
