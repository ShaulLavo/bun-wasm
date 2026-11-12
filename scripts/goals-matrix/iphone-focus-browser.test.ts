import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";
import { withHeldPreview } from "./iphone-load-fixture";

async function pendingLoadFocus(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "resource", 1000, async ({ page, transport, preview, requested, release }) => {
    let presented = false;
    const opening = withScoped(transport, page => page.openPreview(preview)).then(() => { presented = true; });
    void opening.catch(() => {});
    await requested;
    const arm = `(${armIphoneClick.toString()})("button", "button")`;
    expect(presented).toBe(false);
    expect(await page.frameLocator("iframe").locator("button").isEnabled()).toBe(true);
    expect(await page.frameLocator("iframe").locator("button").evaluate(() => typeof Reflect.get(globalThis, "__goalsIphoneClick"))).toBe("undefined");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editor");
    release();
    await opening;
    await page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: 1000 });
    expect(await withScoped(transport, page => page.evaluate(arm))).toMatchObject({ ready: true, before: "Count 0" });
    expect(await withScoped(transport, page => page.evaluate("document.hasFocus()"))).toBe(false);
    await withScoped(transport, page => page.closePreview());
  });
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
