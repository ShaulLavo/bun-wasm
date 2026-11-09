import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse, observeIphoneOrigins } from "./iphone-server";
import { LoopbackPreviewOrigins } from "../../web/preview-origin-host";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";
import { nativeButtonRef, validateIphoneControl } from "./iphone-transport";
import { checkClick } from "./playground";
import { withPlayground } from "./test-fixture";
import { frameworks } from "./catalog";
import { closeIphoneTab } from "./iphone-cleanup";
import { ownedCommand } from "./lifetime";

test("visible iPhone options reject SafariDriver-shaped or non-loopback controls", () => {
  validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "/bound/agent-device");
  expect(() => validateIphoneControl("http://remote:1234/session", "/bound/agent-device")).toThrow();
  expect(() => validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "agent-device")).toThrow();
  expect(nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Other"', "Count 0")).toBe("@e1");
  expect(() => nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Count 0"', "Count 0")).toThrow("found 2");
});

test("native click hook bypasses the script click without changing other transports", async () => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async transport => {
    let native = 0;
    transport.nativeClick = async () => { native++; return { before: "0", after: "1", trusted: true }; };
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "0", after: "1", trusted: true });
    expect(native).toBe(1);
    delete transport.nativeClick;
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "count 0", after: "count 1" });
  });
});

test("bus rejects wrong documents, stale replies and expired commands", async () => {
  const bus = new IphoneBus("/test");
  bus.configure("host", "http://127.0.0.1:1234/");
  const state = bus.state("host")!;
  const key = { nonce: state.nonce, url: state.url, timeOrigin: 1, visible: true };
  expect(() => bus.poll("host", { ...key, nonce: "wrong" }, "http://127.0.0.1:1234")).toThrow();
  bus.poll("host", key, "http://127.0.0.1:1234");
  const pending = bus.execute("host", "1", 20);
  const rejected = expect(pending).rejects.toThrow("expired");
  await rejected;
  expect(() => bus.reply("host", { ...key, id: 1, ok: true, value: 1 }, "http://127.0.0.1:1234")).toThrow("Late");
  expect(() => bus.poll("host", { ...key, timeOrigin: 2 }, "http://127.0.0.1:1234")).toThrow("replaced");
  bus.close();
});

test("ordinary visible page keeps its owner alive and observes trusted iframe input and same-document edits", async () => {
  const bus = new IphoneBus("/__goals_iphone/" + "a".repeat(64));
  let ownerOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request): Promise<Response> => bus.handle(request, ownerOrigin) });
  const restore = observeIphoneOrigins(bus, control.url.origin);
  const origins = new LoopbackPreviewOrigins();
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: (request): Promise<Response> => observeIphoneResponse(new Response("<!doctype html><html><body>owner</body></html>", { headers: { "content-type": "text/html" } }), request.url, bus, control.url.origin),
  });
  ownerOrigin = owner.url.origin;
  const binding = await origins.bind({}, 5173, {
    fetch: () => new Response('<!doctype html><html><body><h1>original</h1><button onclick="this.textContent=\'Count 1\'">Count 0</button></body></html>', { headers: { "content-type": "text/html" } }),
    upgrade: (_request, socket) => { socket.destroy(); }, close() {},
  });
  const browser = await chromium.launch({ headless: true });
  try {
    bus.configure("host", owner.url.href);
    const page = await browser.newPage();
    await page.goto(owner.url.href);
    await page.waitForFunction(() => document.title.startsWith("Goals "));
    await waitReady(bus, "host");
    bus.configure("preview", binding.origin + "/");
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(binding.origin + "/")})`, 3000);
    await waitReady(bus, "preview");
    const before = await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000);
    expect(before).toMatchObject({ before: "Count 0", label: "Count 0" });
    await bus.execute("preview", "document.querySelector('button').click()", 3000);
    expect(await bus.execute("preview", "globalThis.__goalsIphoneClick.trusted", 3000)).toBe(false);
    await bus.execute("preview", "document.querySelector('button').textContent = 'Count 0'", 3000);
    await bus.execute("preview", "Object.defineProperty(performance, 'timeOrigin', { get: () => 123 })", 3000);
    const anchored = await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000);
    expect(anchored).toMatchObject({ timeOrigin: bus.state("preview")?.timeOrigin, nonce: bus.state("preview")?.nonce });
    expect(bus.state("preview")?.timeOrigin).not.toBe(123);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "Count 0" }).click();
    expect(await bus.execute("preview", "({trusted:globalThis.__goalsIphoneClick.trusted, text:document.querySelector('button').textContent})", 3000)).toEqual({ trusted: true, text: "Count 1" });
    const origin = await bus.execute("preview", "performance.timeOrigin", 3000);
    await bus.execute("host", "document.body.dataset.edited='yes'", 3000);
    await bus.execute("preview", "document.querySelector('h1').textContent='updated'", 3000);
    expect(await bus.execute("preview", "performance.timeOrigin", 3000)).toBe(origin);
    expect(await frame.locator("h1").innerText()).toBe("updated");
    await bus.execute("host", `(${presentIphonePreview.toString()})(null)`, 3000);
    expect(await page.locator("iframe").count()).toBe(0);
  } finally {
    await browser.close(); bus.close(); restore(); await origins.close(); await owner.stop(true); await control.stop(true);
  }
}, 20000);

async function waitReady(bus: IphoneBus, role: "host" | "preview"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!bus.state(role)?.visible || bus.state(role)?.timeOrigin === undefined) {
    if (Date.now() >= deadline) throw new Error("Observer did not become visible");
    await Bun.sleep(20);
  }
}

test("native cleanup shares one deadline, cancels its child and never dispatches a later input", async () => {
  const started: { args: string[]; at: number; timeoutMs: number }[] = [];
  let active = 0;
  const deadline = Date.now() + 200;
  await expect(closeIphoneTab(async (args, timeoutMs, signal) => {
    expect(active).toBe(0);
    active++;
    started.push({ args, at: Date.now(), timeoutMs });
    try {
      const delay = started.length === 1 ? 10 : 500;
      return await ownedCommand([process.execPath, "-e", `await Bun.sleep(${delay}); console.log('done')`], signal, timeoutMs);
    } finally { active--; }
  }, "owned tab", deadline)).rejects.toThrow();
  const count = started.length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(2);
  expect(active).toBe(0);
  expect(started.every(item => item.at < deadline && item.timeoutMs <= deadline - item.at + 1)).toBe(true);
  await Bun.sleep(250);
  expect(started.length).toBe(count);
});

test("real product service worker injects the configured preview even when HTTP never sees its HTML", async () => {
  const built = await Bun.build({ entrypoints: [new URL("../../web/src/sw.ts", import.meta.url).pathname], target: "browser", define: { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify("/* socket fixture */") } });
  if (!built.success || !built.outputs[0]) throw new AggregateError(built.logs, "Product service worker did not build");
  const source = await built.outputs[0].text();
  const bus = new IphoneBus("/__goals_iphone/" + "b".repeat(64));
  let ownerOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => bus.handle(request, ownerOrigin) });
  let networkPreviewRequests = 0;
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__preview/")) { networkPreviewRequests++; return new Response("HTTP must not serve the preview", { status: 500 }); }
    if (path === "/sw.js") return observeIphoneResponse(new Response(source, { headers: { "content-type": "text/javascript", "service-worker-allowed": "/" } }), request.url, bus, control.url.origin);
    const html = `<!doctype html><html><body>owner<script>
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type !== 'preview-request') return;
        const port = event.ports[0];
        port.postMessage({type:'accepted'});
        port.postMessage({type:'head',status:200,statusText:'OK',headers:[['content-type','text/html']]});
        port.postMessage({type:'data',chunk:new TextEncoder().encode('<!doctype html><html><body><h1>real worker preview</h1><button>Increment</button></body></html>')});
        port.postMessage({type:'end'});
      });
    </script></body></html>`;
    return observeIphoneResponse(new Response(html, { headers: { "content-type": "text/html" } }), request.url, bus, control.url.origin);
  } });
  ownerOrigin = owner.url.origin;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    bus.configure("host", owner.url.href);
    await page.goto(owner.url.href);
    await waitReady(bus, "host");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/__preview/" });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (!worker) throw new Error("Missing actual preview worker");
      if (worker.state === "activated") return;
      await new Promise<void>(resolve => worker.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); }));
    });
    const preview = owner.url.origin + "/__preview/5173/";
    bus.configure("preview", preview);
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(preview)})`, 3000);
    await waitReady(bus, "preview");
    expect(await bus.execute("preview", "document.querySelector('h1').textContent", 3000)).toBe("real worker preview");
    expect(bus.state("preview")?.url).toBe(preview);
    expect(networkPreviewRequests).toBe(0);
    await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
  } finally { await browser.close(); bus.close(); await owner.stop(true); await control.stop(true); }
}, 15000);
