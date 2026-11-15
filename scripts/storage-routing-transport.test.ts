import { expect, test } from "bun:test";
import { chromium, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { instrumentWorker } from "./storage-routing-build-source";
import { StorageLifetime } from "./storage-browser-evidence";

for (const engine of [chromium, webkit]) test(`${engine.name()}: actual SW diagnostic transport reaches host before context closure`, async () => {
  const events: unknown[] = [];
  const lifetime = new StorageLifetime(event => events.push(event));
  let server: ReturnType<typeof Bun.serve> | undefined;
  lifetime.own("server.stop", async () => { await server?.stop(true); });
  await lifetime.run(async () => {
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
    const { value: browser } = await lifetime.acquire("browser.open", () => engine.launch(), browser => browser.close());
    const acquired = await lifetime.acquire("context.open", () => browser.newContext(), context => context.close());
    const context = acquired.value;
    await lifetime.observeContext(context);
    const page = await context.newPage();
    await page.goto(server.url.href);
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
    const observed = page.waitForEvent("console", message => message.text().startsWith("[storage-routing] ") && message.text().includes("sw-fetch"));
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = "/__preview/5173/src/main.ts"; document.body.appendChild(frame); });
    await observed;
    lifetime.event("preservation-error", { fixture: "injected failure after actual SW delivery" });
    expect(JSON.stringify(events)).toContain("sw-fetch");
    expect(browser.isConnected()).toBe(true);
    await acquired.release();
  });
  lifetime.assertClean();
}, 60_000);
