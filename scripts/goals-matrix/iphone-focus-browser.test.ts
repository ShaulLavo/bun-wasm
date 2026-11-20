import { withScoped } from "./scope-fixture";
import { expect, setDefaultTimeout, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { armIphoneClick, iphonePreviewFocus, presentIphonePreview } from "./iphone-browser";
import { withHeldPreview } from "./iphone-load-fixture";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

// These tests check focus outcomes. Launching a browser takes seconds in CI, most in
// WebKit, so the only limit is a hang cap, and waits inside run until it.
const HANG_CAP_MS = 60_000;
const COMMAND_CAP_MS = 30_000;

async function pendingLoadFocus(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "resource", COMMAND_CAP_MS, async ({ page, transport, preview, requested, release }) => {
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
    await page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: COMMAND_CAP_MS });
    expect(await withScoped(transport, page => page.evaluate(arm))).toMatchObject({ ready: true, before: "Count 0" });
    expect(await withScoped(transport, page => page.evaluate("document.hasFocus()"))).toBe(false);
    await withScoped(transport, page => page.closePreview());
  });
}

// The owner record tells a frame still on its initial about:blank apart from one that committed.
async function committedRecord(engine: BrowserType): Promise<void> {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve: arrived } = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/held") return new Response("<input id=editor>", { headers: { "content-type": "text/html" } });
    arrived();
    await released;
    return new Response("<button>Increment</button>", { headers: { "content-type": "text/html" } });
  } });
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const read = () => page.evaluate(`(${iphonePreviewFocus.toString()})()`);
    expect(await read()).toEqual({ presented: false, focused: false, presentation: null, committed: null });
    await page.evaluate(`(${presentIphonePreview.toString()})(${JSON.stringify(new URL("/held", server.url).href)})`);
    await requested;
    expect(await read()).toMatchObject({ presented: true, focused: false, committed: false });
    release();
    await page.waitForFunction(`(${iphonePreviewFocus.toString()})().focused`, undefined, { timeout: COMMAND_CAP_MS });
    expect(await read()).toMatchObject({ presented: true, focused: true, committed: true });
  } finally { release(); await browser.close(); await server.stop(true); }
}

for (const engine of [chromium, webkit]) {
  test(`owner focus record reports whether the preview frame committed in ${engine.name()}`, () => committedRecord(engine), HANG_CAP_MS);
  test(`enabled native counter waits for pending load focus in ${engine.name()}`, () => pendingLoadFocus(engine), HANG_CAP_MS);
  test(`new native preview takes focus from the owner editor in ${engine.name()}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<input id="editor">');
      await page.locator("input").focus();
      const preview = "data:text/html," + encodeURIComponent('<button>Increment</button>');
      await page.evaluate(`(${presentIphonePreview.toString()})(${JSON.stringify(preview)})`);
      await page.waitForFunction(() => document.activeElement === document.getElementById("__goalsIphonePreview"), undefined, { timeout: COMMAND_CAP_MS });
      expect(await page.locator("iframe").count()).toBe(1);
      await page.evaluate(`(${presentIphonePreview.toString()})(null)`);
      expect(await page.locator("iframe").count()).toBe(0);
    } finally { await browser.close(); }
  }, HANG_CAP_MS);
}
