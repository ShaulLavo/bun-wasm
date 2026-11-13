import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Route } from "playwright";
import { openQuickjsStackPage } from "../web/tests/quickjs-stack-navigation";

async function serveFixture(route: Route, held: Promise<void>): Promise<void> {
  if (route.request().url().endsWith("/held.png")) {
    await held;
    await route.abort();
    return;
  }
  await route.fulfill({ contentType: "text/html", body: `<span id="status">loading</span><img src="/held.png">
    <script>setTimeout(() => { globalThis.playground = {}; document.querySelector('#status').textContent = 'ready'; }, 50);</script>` });
}

async function heldResource(engine: BrowserType): Promise<void> {
  const browser = await engine.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await browser.newPage();
    await page.route("http://stack.test/**", route => serveFixture(route, held));
    const requested = page.waitForRequest("http://stack.test/held.png");
    // Release even with the old load wait, so the regression fails without waiting 30 seconds.
    timer = setTimeout(release, 5_000);
    await openQuickjsStackPage(page, "http://stack.test/");
    await requested;
    expect(page.url()).toBe("http://stack.test/?engine=quickjs&prompt=off&mode=memory");
    expect(await page.textContent("#status")).toBe("ready");
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    expect(await page.evaluate(() => Boolean(Reflect.get(globalThis, "playground")))).toBe(true);
  } finally {
    clearTimeout(timer);
    release();
    await browser.close();
  }
}

async function unpublishedRuntime(engine: BrowserType): Promise<void> {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://stack.test/**", route => route.fulfill({ contentType: "text/html", body: '<span id="status">ready</span>' }));
    await expect(openQuickjsStackPage(page, "http://stack.test/")).rejects.toThrow("before globalThis.playground was ready");
  } finally { await browser.close(); }
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: stack readiness does not wait for an unrelated load resource`, () => heldResource(engine), 10_000);
  test(`${engine.name()}: stack navigation still requires the published runtime`, () => unpublishedRuntime(engine), 10_000);
}
