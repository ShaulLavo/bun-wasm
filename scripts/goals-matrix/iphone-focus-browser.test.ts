import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse } from "./iphone-server";
import { createIphoneTransport } from "./iphone-transport";

async function pendingLoadFocus(engine: BrowserType): Promise<void> {
  const bus = new IphoneBus("/__goals_iphone/" + "e".repeat(64));
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let ownerOrigin = "";
  let controlOrigin = "";
  const close: Array<() => void | Promise<void>> = [() => bus.close()];
  const serveOwner = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/held.png") {
      requested.resolve();
      await release.promise;
      return new Response(null, { status: 404 });
    }
    const html = path === "/preview"
      ? '<!doctype html><body><button>Count 0</button><img src="/held.png"></body>'
      : '<!doctype html><body><input id="editor"></body>';
    return observeIphoneResponse(new Response(html, { headers: { "content-type": "text/html" } }), request, bus, controlOrigin);
  };
  try {
    const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => bus.handle(request, ownerOrigin) });
    close.push(() => control.stop(true));
    controlOrigin = control.url.origin;
    const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serveOwner });
    close.push(() => owner.stop(true));
    ownerOrigin = owner.url.origin;
    const browser = await engine.launch({ headless: true });
    close.push(() => browser.close());
    bus.configure("host", owner.url.href);
    const page = await browser.newPage();
    await page.addInitScript(() => { Document.prototype.hasFocus = () => false; });
    await page.goto(owner.url.href);
    await page.waitForFunction(() => document.title.startsWith("Goals "));
    await page.locator("#editor").focus();
    const transport = await createIphoneTransport({ control: control.url.origin + bus.path, agent: "/unused/agent-device", deviceUDID: "focus-test", timeoutMs: 1000 });
    let presented = false;
    const opening = transport.openPreview(owner.url.origin + "/preview").then(() => { presented = true; });
    close.push(() => opening.catch(() => {}));
    await requested.promise;
    const arm = `(${armIphoneClick.toString()})("button", "button")`;
    expect(presented).toBe(false);
    expect(await page.frameLocator("iframe").locator("button").isEnabled()).toBe(true);
    expect(await page.frameLocator("iframe").locator("button").evaluate(() => typeof Reflect.get(globalThis, "__goalsIphoneClick"))).toBe("undefined");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editor");
    release.resolve();
    await opening;
    await page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: 1000 });
    expect(await transport.evaluate(arm)).toMatchObject({ ready: true, before: "Count 0" });
    expect(await transport.evaluate("document.hasFocus()")).toBe(false);
    await transport.closePreview();
  } finally {
    release.resolve();
    await Promise.allSettled(close.map(async finish => finish()));
  }
}

for (const engine of [chromium, webkit]) {
  test(`enabled native counter waits for pending load focus in ${engine.name()}`, () => pendingLoadFocus(engine), 10000);
  test(`new native preview takes focus from the owner editor in ${engine.name()}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<input id="editor">');
      await page.locator("input").focus();
      const preview = "data:text/html," + encodeURIComponent('<button>Increment</button>');
      await page.evaluate(`(${presentIphonePreview.toString()})(${JSON.stringify(preview)})`);
      await page.waitForFunction(() => document.activeElement === document.getElementById("__goalsIphonePreview"), undefined, { timeout: 1000 });
      expect(await page.locator("iframe").count()).toBe(1);
      await page.evaluate(`(${presentIphonePreview.toString()})(null)`);
      expect(await page.locator("iframe").count()).toBe(0);
    } finally { await browser.close(); }
  }, 10000);
}
