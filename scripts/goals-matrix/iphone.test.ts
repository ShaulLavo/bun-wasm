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
    await bus.execute("preview", `(${armIphoneClick.toString()})("button", "button")`, 3000);
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
