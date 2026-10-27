import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { observeNativeProductTraffic } from "./app-matrix/product-browser";

test("native HMR evidence comes from real frames after editing without patching browser events", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: undefined })) return; return new Response("<!doctype html><p>native traffic</p>", { headers: { "content-type": "text/html" } }); },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  let browser: Browser | undefined;
  let traffic: Awaited<ReturnType<typeof observeNativeProductTraffic>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const dispatch = await page.evaluate(() => EventTarget.prototype.dispatchEvent.toString());
    traffic = await observeNativeProductTraffic(page);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace("http:", "ws:"));
      Reflect.set(globalThis, "trafficSocket", socket);
      socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Native fixture socket failed"));
    }));
    async function send(payload: string) {
      await page.evaluate(payload => new Promise<void>(resolve => {
        const socket: unknown = Reflect.get(globalThis, "trafficSocket");
        if (!(socket instanceof WebSocket)) throw new Error("Missing native socket");
        socket.addEventListener("message", () => resolve(), { once: true });
        socket.send(payload);
      }), payload);
    }
    const update = JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/src/app.tsx" }] });
    await send(update);
    expect(await traffic.count()).toBe(0);
    await traffic.beginEdit();
    await send(update);
    expect((await traffic.evidenceSince(0)).map(event => [event.framework, event.event])).toEqual([["vite", "update"]]);
    await page.evaluate(payload => {
      const socket: unknown = Reflect.get(globalThis, "trafficSocket");
      if (!(socket instanceof WebSocket)) throw new Error("Missing native socket");
      socket.dispatchEvent(new MessageEvent("message", { data: payload }));
    }, update);
    expect(await traffic.count()).toBe(1);
    expect(await page.evaluate(() => EventTarget.prototype.dispatchEvent.toString())).toBe(dispatch);
    await traffic.close();
    await send(update);
    expect(await traffic.count()).toBe(1);
  } finally { await traffic?.close(); await browser?.close(); await server.stop(true); }
}, 30_000);
