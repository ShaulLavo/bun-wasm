import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { isSafari } from "../web/src/playground/preview-links";

// Captured from the genuine Safari 26.4 in-page lifecycle pass on November 12.
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
let server: ReturnType<typeof Bun.serve>;
const browsers: Browser[] = [];
let origin: string;

beforeAll(async () => {
  const build = await Bun.build({ entrypoints: ["web/tests/playground-preview-main.ts"], target: "browser", minify: true });
  if (!build.success) throw new AggregateError(build.logs, "Preview fixture bundle failed");
  const outputs = new Map(build.outputs.map(output => [new URL(output.path, "http://fixture/").pathname.split("/").pop(), output]));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const output = outputs.get(url.pathname.slice(1));
    if (output) return new Response(output);
    if (url.pathname.startsWith("/preview/")) return new Response('<button onclick="this.textContent = \'Count 1\'">Count 0</button>', { headers: { "content-type": "text/html" } });
    return new Response('<!doctype html><link rel="stylesheet" href="/playground-preview-main.css"><div id="app"><header>Editor</header><main><textarea id="editor">unsaved source</textarea><section id="terminal"></section></main></div><script type="module" src="/playground-preview-main.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  origin = server.url.origin;
  console.log(`Preview fixture listener: ${origin}; browser profiles belong to Playwright and close in teardown.`);
}, 30000);

afterAll(async () => {
  await Promise.all(browsers.map(browser => browser.close()));
  await server?.stop(true);
});

test("Safari brand selection excludes other browsers using WebKit or Safari tokens", () => {
  for (const userAgent of [safari, "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1"]) expect(isSafari(userAgent)).toBe(true);
  for (const userAgent of [chrome, safari.replace("Version/26.4", "FxiOS/145.0"), safari.replace("Version/26.4", "CriOS/157.0"), safari + " Edg/157.0", safari + " OPR/99.0", "Mozilla/5.0 AppleWebKit/605.1.15", ""]) expect(isSafari(userAgent)).toBe(false);
});

async function fixture(browser: Browser, userAgent: string): Promise<Page> {
  const context = await browser.newContext({ userAgent, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const opened: string[] = [];
    Reflect.set(globalThis, "previewOpens", opened);
    window.open = (url) => { opened.push(String(url)); return null; };
  });
  await page.goto(origin);
  await page.waitForSelector('body[data-ready="true"]');
  return page;
}

async function activate(page: Page, row: number): Promise<void> {
  const screen = await page.locator(".xterm-screen").boundingBox();
  if (!screen) throw new Error("Missing terminal screen");
  const x = screen.x + screen.width / 100 * 4;
  const y = screen.y + screen.height / 8 * (row + 0.5);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

async function frameReady(page: Page): Promise<void> {
  await page.frameLocator('iframe[title="App preview"]').getByRole("button", { name: "Count 0" }).waitFor();
}

async function openedUrls(page: Page, count: number): Promise<string[]> {
  await page.waitForFunction(count => Reflect.get(globalThis, "previewOpens").length === count, count);
  return page.evaluate(() => Reflect.get(globalThis, "previewOpens"));
}

for (const [name, engine] of [["Chromium", chromium], ["Linux WebKit", webkit]] as const) {
  test(`${name}: real OSC8 and localhost activation own, reuse, replace and close the Safari frame`, async () => {
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    const page = await fixture(browser, safari);
    try {
      await page.locator("#editor").fill("unsaved edit survives preview");
      await activate(page, 0);
      await frameReady(page);
      expect(await page.locator("iframe").count()).toBe(1);
      await page.waitForFunction(() => document.activeElement === document.querySelector("iframe"));
      expect(await page.locator("iframe").evaluate(node => node === document.activeElement)).toBe(true);
      expect(await page.locator("iframe").getAttribute("src")).toBe(`${origin}/preview/5173/nested?value=%2F#hello`);
      expect(await page.evaluate(() => ({ visibility: document.visibilityState, hidden: document.hidden }))).toEqual({ visibility: "visible", hidden: false });
      await page.frameLocator("iframe").getByRole("button", { name: "Count 0" }).click();
      expect(await page.frameLocator("iframe").getByRole("button").textContent()).toBe("Count 1");
      const frame = await page.locator("iframe").elementHandle();
      await page.evaluate(() => Reflect.get(globalThis, "previewFixture").term.options.linkHandler.activate(new MouseEvent("click"), location.origin + "/preview/5173/nested?value=%2F#hello"));
      expect(await frame?.evaluate(node => node === document.querySelector("iframe"))).toBe(true);
      expect(await page.frameLocator("iframe").getByRole("button").textContent()).toBe("Count 1");
      await page.getByRole("button", { name: "Close preview" }).click();
      expect(await page.locator("iframe").count()).toBe(0);
      expect(await page.locator("#editor").inputValue()).toBe("unsaved edit survives preview");
      expect(await page.locator("#editor").evaluate(node => node === document.activeElement)).toBe(true);
      await activate(page, 1);
      await frameReady(page);
      expect(await page.locator("iframe").getAttribute("src")).toBe(`${origin}/preview/5173/raw?value=%2F#raw`);
      const raw = await page.locator("iframe").elementHandle();
      await page.evaluate(() => Reflect.get(globalThis, "previewFixture").term.options.linkHandler.activate(new MouseEvent("click"), location.origin + "/preview/4173/"));
      await frameReady(page);
      expect(await raw?.evaluate(node => node.isConnected)).toBe(false);
      expect(await page.locator("iframe").count()).toBe(1);
      await page.getByRole("button", { name: "Close preview" }).press("Escape");
      expect(await page.locator("iframe").count()).toBe(0);
      await page.evaluate(() => Reflect.get(globalThis, "previewFixture").stop());
      await activate(page, 1);
      expect(await page.locator("iframe").count()).toBe(0);
      expect(await openedUrls(page, 0)).toEqual([]);
      await activate(page, 3);
      expect(await openedUrls(page, 1)).toEqual(["https://example.com/"]);
      await activate(page, 4);
      expect(await openedUrls(page, 2)).toEqual(["https://example.com/", `${origin}/preview/9999/`]);
      expect(await page.locator("iframe").count()).toBe(0);
      await activate(page, 2);
      await frameReady(page);
      await page.evaluate(() => Reflect.get(globalThis, "previewFixture").dispose());
      expect(await page.locator("iframe").count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(globalThis, "previewFixture").term.options.linkHandler)).toBeNull();
      await page.evaluate(() => {
        const fixture = Reflect.get(globalThis, "previewFixture");
        fixture.dispose();
        fixture.activate(new MouseEvent("click"), location.origin + "/preview/5173/");
      });
      expect(await page.locator("iframe").count()).toBe(0);
      expect(await openedUrls(page, 2)).toHaveLength(2);
      expect(page.context().pages().length).toBe(1);
    } finally { await page.context().close(); }
  }, 30000);

  test(`${name}: other browsers retain new-tab defaults for both terminal link sources`, async () => {
    const browser = browsers[browsers.length - 1]!;
    const page = await fixture(browser, chrome);
    try {
      await activate(page, 0);
      await openedUrls(page, 1);
      await activate(page, 1);
      expect(await openedUrls(page, 2)).toEqual([`${origin}/preview/5173/nested?value=%2F#hello`, `${origin}/preview/5173/raw?value=%2F#raw`]);
      expect(await page.locator("iframe").count()).toBe(0);
    } finally { await page.context().close(); }
  }, 30000);

  test(`${name}: page teardown removes its frame and stale links; persisted pagehide preserves it`, async () => {
    const browser = browsers[browsers.length - 1]!;
    const page = await fixture(browser, safari);
    try {
      await activate(page, 0);
      await frameReady(page);
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      expect(await page.locator("iframe").count()).toBe(1);
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
      expect(await page.locator("iframe").count()).toBe(0);
      await activate(page, 1);
      expect(await page.locator("iframe").count()).toBe(0);
      expect(await openedUrls(page, 0)).toEqual([]);
    } finally { await page.context().close(); }
  }, 30000);
}
