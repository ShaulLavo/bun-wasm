import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, errors, webkit, type BrowserType, type Route } from "playwright";
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

async function navigationFailure(engine: BrowserType, mode: "timeout" | "connection" | "sink"): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-stack-navigation-"));
  const previous = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  const occupied = join(directory, "occupied");
  writeFileSync(occupied, "occupied");
  process.env.BUN_WASM_BROWSER_REPORT_DIR = mode === "sink" ? occupied : join(directory, "reports");
  let documents = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { documents++; return new Response("probe body"); },
  });
  let browser;
  try {
    browser = await engine.launch();
    const page = await browser.newPage();
    const target = `${server.url}?engine=quickjs&prompt=off&mode=memory`;
    const timeout = new errors.TimeoutError("fixture navigation timeout");
    if (mode === "timeout") page.goto = async () => { throw timeout; };
    if (mode === "connection") await page.route("**/*", route => route.abort());
    if (mode === "sink") await page.close();
    let failure: unknown;
    try { await openQuickjsStackPage(page, String(server.url)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(documents).toBe(1);
    expect(readFileSync(occupied, "utf8")).toBe("occupied");
    if (mode === "sink") {
      expect(String(failure)).toContain("Target page, context or browser has been closed");
      return;
    }
    const files = readdirSync(join(directory, "reports"));
    expect(files).toHaveLength(1);
    const report: unknown = JSON.parse(readFileSync(join(directory, "reports", files[0]!), "utf8"));
    expect(report).toMatchObject({
      browser: engine.name(), url: target, error: String(failure),
      pageAtFailure: { closed: false, browserConnected: true },
      requests: { requested: mode === "connection" ? 1 : 0, pending: [] },
      server: { outcome: "ok", value: { status: 200, bytes: Buffer.byteLength("probe body") } },
    });
    if (mode === "connection") expect(report).toMatchObject({ requests: { events: expect.arrayContaining([
      expect.objectContaining({ event: "requestfailed", url: target }),
    ]) } });
    if (mode === "timeout") {
      expect(failure).toBe(timeout);
      expect(report).toMatchObject({ pageState: { outcome: "ok", value: { readyState: "complete", status: null, published: false } } });
    }
  } finally {
    const stopped = await Promise.allSettled([browser?.close(), server.stop(true)]);
    if (previous === undefined) delete process.env.BUN_WASM_BROWSER_REPORT_DIR;
    else process.env.BUN_WASM_BROWSER_REPORT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
    expect(stopped.filter(result => result.status === "rejected")).toEqual([]);
  }
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: stack readiness does not wait for an unrelated load resource`, () => heldResource(engine), 10_000);
  test(`${engine.name()}: stack navigation still requires the published runtime`, () => unpublishedRuntime(engine), 10_000);
  test(`${engine.name()}: a navigation timeout records page and independent server state without retrying`, () => navigationFailure(engine, "timeout"), 30_000);
  test(`${engine.name()}: a navigation failure records browser requests`, () => navigationFailure(engine, "connection"), 30_000);
  test(`${engine.name()}: a diagnostic write failure preserves the navigation error`, () => navigationFailure(engine, "sink"), 30_000);
}
