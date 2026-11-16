import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, errors, webkit, type BrowserType, type Page, type Route } from "playwright";
import { openQuickjsStackPage } from "../web/tests/quickjs-stack-navigation";
import { openPlaygroundPage } from "../web/tests/playground-navigation";

const consumers = [
  { name: "quickjs", prefix: "quickjs-stack-navigation", open: openQuickjsStackPage },
  { name: "browser", prefix: "playground-navigation", open: (page: Page, url: string) => openPlaygroundPage(page, `${url}?engine=browser&prompt=off&mode=memory`) },
];
type Consumer = typeof consumers[number];

async function serveFixture(route: Route, held: Promise<void>, published = true): Promise<void> {
  if (route.request().url().endsWith("/held.png")) {
    await held;
    await route.abort();
    return;
  }
  await route.fulfill({ contentType: "text/html", body: `<span id="status">loading</span><img src="/held.png">
    <script>setTimeout(() => { globalThis.playground = ${published ? "{}" : "undefined"}; document.querySelector('#status').textContent = 'ready'; }, 50);</script>` });
}

async function heldResource(engine: BrowserType, consumer: Consumer): Promise<void> {
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
    await consumer.open(page, "http://stack.test/");
    await requested;
    expect(page.url()).toBe(`http://stack.test/?engine=${consumer.name}&prompt=off&mode=memory`);
    expect(await page.textContent("#status")).toBe("ready");
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    expect(await page.evaluate(() => Boolean(Reflect.get(globalThis, "playground")))).toBe(true);
  } finally {
    clearTimeout(timer);
    release();
    await browser.close();
  }
}

async function navigationFailure(engine: BrowserType, consumer: Consumer, mode: "timeout" | "connection" | "sink" | "publication"): Promise<void> {
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
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let browser;
  try {
    browser = await engine.launch();
    const page = await browser.newPage();
    const target = `${server.url}?engine=${consumer.name}&prompt=off&mode=memory`;
    const timeout = new errors.TimeoutError("fixture navigation timeout");
    if (mode === "timeout") page.goto = async () => { throw timeout; };
    if (mode === "connection") await page.route("**/*", route => route.abort());
    if (mode === "sink") await page.close();
    if (mode === "publication") await page.route("**/*", route => serveFixture(route, held, false));
    let failure: unknown;
    try { await consumer.open(page, String(server.url)); }
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
    expect(files[0]).toStartWith(`${consumer.prefix}-${engine.name()}-`);
    const report: unknown = JSON.parse(readFileSync(join(directory, "reports", files[0]!), "utf8"));
    expect(report).toMatchObject({
      browser: engine.name(), url: target, error: String(failure), stage: mode === "publication" ? "runtime-publication" : "navigation", waitUntil: "domcontentloaded",
      pageAtFailure: { closed: false, browserConnected: true },
      requests: {
        requested: mode === "publication" ? 2 : Number(mode === "connection"),
        pending: mode === "publication" ? [`${server.url}held.png`] : [],
        lifecycle: { documentCommitted: mode === "publication", domcontentloaded: mode === "publication", load: false },
      },
      server: { outcome: "ok", value: { status: 200, bytes: Buffer.byteLength("probe body") } },
    });
    if (consumer.name === "quickjs") expect(report).toMatchObject({ budget: process.env.QUICKJS_STACK_KIB ?? "default" });
    else expect(report).not.toHaveProperty("budget");
    if (mode === "publication") {
      expect(String(failure)).toContain("before globalThis.playground was ready");
      expect(report).toMatchObject({ pageState: { outcome: "ok", value: { readyState: "interactive", status: "ready", published: false } } });
    }
    if (mode === "connection") expect(report).toMatchObject({ requests: { events: expect.arrayContaining([
      expect.objectContaining({ event: "requestfailed", url: target }),
    ]) } });
    if (mode === "timeout") {
      expect(failure).toBe(timeout);
      expect(report).toMatchObject({ pageState: { outcome: "ok", value: { readyState: "complete", status: null, published: false } } });
    }
  } finally {
    release();
    const stopped = await Promise.allSettled([browser?.close(), server.stop(true)]);
    if (previous === undefined) delete process.env.BUN_WASM_BROWSER_REPORT_DIR;
    else process.env.BUN_WASM_BROWSER_REPORT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
    expect(stopped.filter(result => result.status === "rejected")).toEqual([]);
  }
}

function registerControls(engine: BrowserType, consumer: Consumer) {
  const label = `${engine.name()} ${consumer.name}`;
  test(`${label}: readiness does not wait for an unrelated load resource`, () => heldResource(engine, consumer), 10_000);
  test(`${label}: runtime publication failure retains document and held-resource stages`, () => navigationFailure(engine, consumer, "publication"), 30_000);
  test(`${label}: a navigation timeout records page and independent server state without retrying`, () => navigationFailure(engine, consumer, "timeout"), 30_000);
  test(`${label}: a navigation failure records browser requests`, () => navigationFailure(engine, consumer, "connection"), 30_000);
  test(`${label}: a diagnostic write failure preserves the navigation error`, () => navigationFailure(engine, consumer, "sink"), 30_000);
}

for (const engine of [chromium, webkit]) for (const consumer of consumers) registerControls(engine, consumer);

for (const consumer of consumers) test(`${consumer.name}: a diagnostic sink that never settles preserves the navigation error and removes listeners`, () => {
  const directory = mkdtempSync(join(tmpdir(), "qjs-report-"));
  try {
    const output = execFileSync(process.execPath, [new URL("./fixtures/quickjs-stack-stalled-report.ts", import.meta.url).pathname], {
      encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
      env: { ...process.env, TMPDIR: directory, BUN_WASM_BROWSER_REPORT_DIR: join(directory, "reports"), NAVIGATION_CONSUMER: consumer.name },
    });
    expect(output).toContain("STALLED_REPORT_WRITE");
    expect(output).toContain("STALLED_REPORT_RESULT original error preserved; listeners removed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 90_000);
