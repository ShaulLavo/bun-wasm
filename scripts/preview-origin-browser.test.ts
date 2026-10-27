import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { fixture } from "../web/tests/fixtures/preview-origin-native";
import { LoopbackPreviewOrigins, type PreviewOriginEndpoint } from "../web/preview-origin-host";

const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
const client = `document.querySelector('#client-path').textContent = location.pathname;
document.querySelector('button').onclick = () => document.querySelector('#count').textContent = '1';`;

function nativeApp(paths: string[]): PreviewOriginEndpoint {
  const sockets = fixture("native");
  return {
    fetch(request) {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === "/client.js") return new Response(client, { headers: { ...isolation, "content-type": "text/javascript" } });
      return new Response(`<!doctype html><p id="server-path">${url.pathname}</p><p id="client-path"></p>
        <button>Count</button><output id="count">0</output><a href="/nested?value=native">Nested</a>
        <script type="module" src="/client.js"></script>`, { headers: { ...isolation, "content-type": "text/html" } });
    },
    upgrade: sockets.upgrade,
    close: sockets.close,
  };
}

test("native loopback root origin preserves browser routing, isolation and socket ownership", async () => {
  const registry = new LoopbackPreviewOrigins();
  let browser: Browser | undefined;
  const paths: string[] = [];
  const owner = {};
  const first = await registry.bind(owner, 3137, nativeApp(paths));
  const second = await registry.bind({}, 3137, nativeApp([]));
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.goto(`${registry.originForPort(owner, 3137)}/?value=root`);
    expect(response?.status()).toBe(200);
    expect(await page.locator("#client-path").textContent()).toBe("/");
    expect(await page.locator("#server-path").textContent()).toBe("/");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await page.getByRole("button").click();
    expect(await page.locator("#count").textContent()).toBe("1");
    await page.getByRole("link").click();
    await page.waitForURL(`${first.origin}/nested?value=native`);
    expect(await page.locator("#client-path").textContent()).toBe("/nested");
    await page.reload();
    expect(await page.locator("#server-path").textContent()).toBe("/nested");
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.goForward();
    expect(new URL(page.url()).pathname).toBe("/nested");
    const accepted = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace("http:", "ws:")}/socket`);
      socket.onopen = () => socket.send("native-upgrade");
      socket.onmessage = event => { resolve(String(event.data)); socket.close(); };
      socket.onerror = () => reject(new Error("Same-owner socket rejected"));
    }));
    expect(accepted).toBe("native-upgrade");
    const rejected = await page.evaluate(origin => new Promise<boolean>(resolve => {
      const socket = new WebSocket(`${origin.replace("http:", "ws:")}/socket`);
      socket.onopen = () => { socket.close(); resolve(false); };
      socket.onerror = () => resolve(true);
    }), second.origin);
    expect(rejected).toBe(true);
    expect(paths).toContain("/?value=root");
    expect(paths).toContain("/client.js");
    expect(paths).toContain("/nested?value=native");
    expect(errors).toEqual([]);
    await registry.closeOwner(owner);
    await expect(fetch(first.origin)).rejects.toThrow();
    expect((await fetch(second.origin)).status).toBe(200);
    await context.close();
    console.log(JSON.stringify({ nativeRootOrigin: true, rootRelativeModule: true, nestedReloadHistory: true,
      crossOriginIsolated: true, serviceWorkers: 0, websocketAccepted: true, foreignOwnerSocketRejected: true, closedOwnerListenerRemoved: true }));
  } finally {
    await browser?.close();
    await registry.close();
  }
}, 30_000);
