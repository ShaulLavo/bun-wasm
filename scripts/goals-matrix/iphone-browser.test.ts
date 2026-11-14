import { test, expect, spyOn } from "bun:test";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { brotliCompressSync } from "node:zlib";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse, observeIphoneOrigins } from "./iphone-server";
import { LoopbackPreviewOrigins } from "../../web/preview-origin-host";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";

function counterResponse(request: Request, encodings: { asset: string | null; navigations: (string | null)[] }): Response {
  const encoding = request.headers.get("accept-encoding");
  if (new URL(request.url).pathname === "/asset.js") { encodings.asset = encoding; return new Response("asset"); }
  encodings.navigations.push(encoding);
  const html = '<!doctype html><html><body><h1>original</h1><button disabled onclick="this.textContent=\'Count 1\'">Count 0</button></body></html>';
  return encoding?.includes("br") ? new Response(brotliCompressSync(html), { headers: { "content-type": "text/html", "content-encoding": "br" } }) : new Response(html, { headers: { "content-type": "text/html" } });
}

test("ordinary visible page keeps its owner alive and observes trusted iframe input and same-document edits", async () => {
  const bus = new IphoneBus("/__goals_iphone/" + "a".repeat(64));
  let ownerOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request): Promise<Response> => bus.handle(request, ownerOrigin) });
  const restore = observeIphoneOrigins(bus, control.url.origin);
  const origins = new LoopbackPreviewOrigins();
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: (request): Promise<Response> => observeIphoneResponse(new Response("<!doctype html><html><body>owner</body></html>", { headers: { "content-type": "text/html" } }), request, bus, control.url.origin),
  });
  ownerOrigin = owner.url.origin;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const encodings: { asset: string | null; navigations: (string | null)[] } = { asset: null, navigations: [] };
  try {
    browser = await chromium.launch({ headless: true });
    const binding = await origins.bind({}, 5173, {
      fetch: request => counterResponse(request, encodings),
      upgrade: (_request, socket) => { socket.destroy(); }, close() {},
    });
    bus.configure("host", owner.url.href);
    const page = await browser.newPage();
    await page.goto(owner.url.href);
    await page.waitForFunction(() => document.title.startsWith("Goals "));
    await waitReady(bus, "host");
    bus.configure("preview", binding.origin + "/");
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(binding.origin + "/")})`, 3000, false, Date.now() + 3000);
    await waitReady(bus, "preview");
    expect(encodings.navigations).toEqual(["identity"]);
    const asset = new URL("/asset.js", binding.origin);
    asset.hostname = "127.0.0.1";
    await fetch(asset, { headers: { host: new URL(binding.origin).host, "accept-encoding": "br" } });
    expect(encodings.asset).toBe("br");
    expect(await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000, false, Date.now() + 3000)).toMatchObject({ ready: false, before: "Count 0" });
    await bus.execute("preview", "document.querySelector('button').disabled = false", 3000, false, Date.now() + 3000);
    const before = await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000, false, Date.now() + 3000);
    expect(before).toMatchObject({ before: "Count 0", label: "Count 0" });
    await bus.execute("preview", "document.querySelector('button').click()", 3000, false, Date.now() + 3000);
    expect(await bus.execute("preview", "globalThis.__goalsIphoneClick.trusted", 3000, false, Date.now() + 3000)).toBe(false);
    await bus.execute("preview", "document.querySelector('button').textContent = 'Count 0'", 3000, false, Date.now() + 3000);
    await bus.execute("preview", "Object.defineProperty(performance, 'timeOrigin', { get: () => 123 })", 3000, false, Date.now() + 3000);
    const anchored = await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000, false, Date.now() + 3000);
    expect(anchored).toMatchObject({ timeOrigin: bus.state("preview")?.timeOrigin, nonce: bus.state("preview")?.nonce });
    expect(bus.state("preview")?.timeOrigin).not.toBe(123);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "Count 0" }).click();
    expect(await bus.execute("preview", "({trusted:globalThis.__goalsIphoneClick.trusted, text:document.querySelector('button').textContent})", 3000, false, Date.now() + 3000)).toEqual({ trusted: true, text: "Count 1" });
    await expect(bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000, false, Date.now() + 3000)).rejects.toThrow("must start at zero");
    const origin = await bus.execute("preview", "performance.timeOrigin", 3000, false, Date.now() + 3000);
    await bus.execute("host", "document.body.dataset.edited='yes'", 3000, false, Date.now() + 3000);
    await bus.execute("preview", "document.querySelector('h1').textContent='updated'", 3000, false, Date.now() + 3000);
    expect(await bus.execute("preview", "performance.timeOrigin", 3000, false, Date.now() + 3000)).toBe(origin);
    expect(await frame.locator("h1").innerText()).toBe("updated");
    await bus.execute("host", `(${presentIphonePreview.toString()})(null)`, 3000, false, Date.now() + 3000);
    expect(await page.locator("iframe").count()).toBe(0);
  } finally {
    await browser?.close(); bus.close(); restore(); await origins.close(); await owner.stop(true); await control.stop(true);
  }
}, 20000);

async function waitReady(bus: IphoneBus, role: "host" | "preview"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!bus.state(role)?.visible || bus.state(role)?.timeOrigin === undefined) {
    if (Date.now() >= deadline) throw new Error("Observer did not become visible");
    await Bun.sleep(20);
  }
}

test("the observer still rejects a server that sends encoded HTML after identity negotiation", async () => {
  const bus = new IphoneBus("/__goals_iphone/" + "f".repeat(64));
  const url = "http://127.0.0.1:1234/";
  bus.configure("preview", url);
  const request = new Request(url, { headers: { "sec-fetch-mode": "navigate", "accept-encoding": "identity" } });
  const response = new Response(brotliCompressSync("<html><body>fixture</body></html>"), { headers: { "content-type": "text/html", "content-encoding": "br" } });
  await expect(observeIphoneResponse(response, request, bus, "http://127.0.0.1:1235")).rejects.toThrow("requires uncompressed HTML");
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
    if (path === "/sw.js") return observeIphoneResponse(new Response(source, { headers: { "content-type": "text/javascript", "service-worker-allowed": "/" } }), request, bus, control.url.origin);
    const html = `<!doctype html><html><body>owner<script>
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type !== 'preview-request') return;
        const port = event.ports[0];
        port.postMessage({type:'accepted'});
        port.postMessage({type:'head',status:200,statusText:'OK',headers:[['content-type','text/html']]});
        port.postMessage({type:'data',chunk:new TextEncoder().encode('<!doctype html><html><body><h1>real worker preview '+(document.body.dataset.revision ?? '1')+'</h1><button>Increment</button></body></html>')});
        port.postMessage({type:'end'});
      });
    </script></body></html>`;
    return observeIphoneResponse(new Response(html, { headers: { "content-type": "text/html" } }), request, bus, control.url.origin);
  } });
  ownerOrigin = owner.url.origin;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
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
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(preview)})`, 3000, false, Date.now() + 3000);
    await waitReady(bus, "preview");
    expect(await bus.execute("preview", "document.querySelector('h1').textContent", 3000, false, Date.now() + 3000)).toBe("real worker preview 1");
    for (const revision of [2, 3]) {
      await page.evaluate(value => { document.body.dataset.revision = String(value); }, revision);
      const read = `new Promise(resolve => { const text = document.querySelector('h1').textContent; if (text === 'real worker preview ${revision}') resolve(text); })`;
      const pending = bus.execute("preview", read, 3000, true, Date.now() + 3000).catch((error: unknown) => error);
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>("iframe")!.contentWindow!.location.reload());
      expect(await pending).toBe(`real worker preview ${revision}`);
    }
    expect(bus.state("preview")?.url).toBe(preview);
    expect(networkPreviewRequests).toBe(0);
    await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
  } finally { await browser?.close(); bus.close(); await owner.stop(true); await control.stop(true); }
}, 15000);

function reloadingHtml(request: Request, revision: { value: number }): Response {
  if (new URL(request.url).pathname === "/revision") return new Response(String(revision.value));
  return new Response(`<!doctype html><html><body><h1>revision ${revision.value}</h1><script>
const initial = ${revision.value};
setInterval(async () => { if (await (await fetch('/revision')).text() !== String(initial)) location.reload(); }, 20);
</script></body></html>`, { headers: { "content-type": "text/html" } });
}

async function reloadAfterDelivery(bus: IphoneBus, read: string, reload: () => void): Promise<unknown> {
  const delivered = Promise.withResolvers<void>();
  const poll = bus.poll.bind(bus);
  const observedPoll = spyOn(bus, "poll").mockImplementation((...args) => {
    const value = poll(...args);
    if (value && typeof value === "object" && "source" in value && value.source === read) delivered.resolve();
    return value;
  });
  try {
    const pending = bus.execute("preview", read, 3000, true, Date.now() + 3000);
    await Promise.race([delivered.promise, pending.then(() => { throw new Error("Preview observation settled before delivery"); })]);
    reload();
    return await pending;
  } finally {
    observedPoll.mockRestore();
    bus.cancel("preview");
  }
}

async function previewReload(engine: BrowserType): Promise<void> {
  const bus = new IphoneBus("/__goals_iphone/" + "d".repeat(64));
  let ownerOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => bus.handle(request, ownerOrigin) });
  const restore = observeIphoneOrigins(bus, control.url.origin);
  const origins = new LoopbackPreviewOrigins();
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => observeIphoneResponse(new Response("<!doctype html><html><body>owner</body></html>", { headers: { "content-type": "text/html" } }), request, bus, control.url.origin),
  });
  ownerOrigin = owner.url.origin;
  const revision = { value: 1 };
  const read = "new Promise(resolve => { const text = document.querySelector('h1').textContent; if (text === 'revision 2') resolve(text); })";
  let browser: Browser | undefined;
  try {
    browser = await engine.launch({ headless: true });
    const binding = await origins.bind({}, 5173, { fetch: request => reloadingHtml(request, revision), upgrade: (_request, socket) => { socket.destroy(); }, close() {} });
    bus.configure("host", owner.url.href);
    const page = await browser.newPage();
    await page.goto(owner.url.href);
    await waitReady(bus, "host");
    bus.configure("preview", binding.origin + "/");
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(binding.origin + "/")})`, 3000, false, Date.now() + 3000);
    await waitReady(bus, "preview");
    const before = bus.state("preview");
    if (!before?.timeOrigin) throw new Error("Missing initial preview identity");
    expect(await reloadAfterDelivery(bus, read, () => { revision.value = 2; })).toBe("revision 2");
    expect(bus.state("preview")?.nonce).not.toBe(before.nonce);
    expect(bus.state("preview")?.timeOrigin).not.toBe(before.timeOrigin);
  } finally {
    await browser?.close(); bus.close(); restore(); await origins.close(); await owner.stop(true); await control.stop(true);
  }
}

for (const engine of [chromium, webkit]) {
  test(`read-only preview observation follows a real automatic document reload in ${engine.name()}`, () => previewReload(engine), 15000);
}

function attachedPreview() {
  const bus = new IphoneBus("/test");
  const url = "http://127.0.0.1:1234/";
  bus.configure("preview", url);
  const page = bus.state("preview");
  if (!page) throw new Error("Missing preview");
  const key = { url, nonce: page.nonce, timeOrigin: 1, visible: true };
  bus.poll("preview", key, new URL(url).origin);
  return { bus, key, origin: new URL(url).origin };
}

test.each(["expiry", "close"] as const)("reload delivery wait propagates %s and restores its poll spy", async scenario => {
  const { bus, key, origin } = attachedPreview();
  const poll = bus.poll;
  const reload = { called: false };
  const waiting = reloadAfterDelivery(bus, "read()", () => { reload.called = true; });
  const guard = Promise.withResolvers<never>();
  const timer = setTimeout(() => guard.reject(new Error("Delivery wait stranded after command settlement")), 100);
  const guarded = Promise.race([waiting, guard.promise]);
  try {
    if (scenario === "close") bus.close();
    else {
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + 3001);
      try { expect(bus.poll("preview", key, origin)).toBeNull(); }
      finally { clock.mockRestore(); }
    }
    await expect(guarded).rejects.toThrow(scenario === "expiry" ? "delivery deadline expired" : "expired or closed");
    expect(reload.called).toBe(false);
    expect(bus.poll).toBe(poll);
    if (scenario === "expiry") expect(bus.poll("preview", key, origin)).toBeNull();
    else expect(bus.state("preview")).toBeNull();
  } finally { clearTimeout(timer); bus.close(); }
}, 1000);

test("reload delivery wait observes delivery before reloading and cancels on reload failure", async () => {
  const { bus, key, origin } = attachedPreview();
  const poll = bus.poll;
  const failure = new Error("reload fixture failed");
  const waiting = reloadAfterDelivery(bus, "read()", () => { throw failure; });
  void waiting.catch(() => {});
  try {
    expect(bus.poll("preview", key, origin)).toMatchObject({ source: "read()" });
    await expect(waiting).rejects.toBe(failure);
    expect(bus.poll).toBe(poll);
    const next = bus.execute("preview", "next()", 3000, true, Date.now() + 3000);
    const task = bus.poll("preview", key, origin);
    expect(task).toMatchObject({ id: 2, source: "next()" });
    bus.reply("preview", { ...key, id: 2, ok: true, value: "clean" }, origin);
    expect(await next).toBe("clean");
  } finally { bus.close(); }
});
