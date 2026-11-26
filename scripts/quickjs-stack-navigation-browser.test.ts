import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, errors, webkit, type BrowserType, type Page, type Route } from "playwright";
import { openQuickjsStackPage } from "../web/tests/quickjs-stack-navigation";
import { openPlaygroundPage } from "../web/tests/playground-navigation";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const consumers = [
  { name: "quickjs", prefix: "quickjs-stack-navigation", open: openQuickjsStackPage },
  { name: "browser", prefix: "playground-navigation", open: (page: Page, url: string) => openPlaygroundPage(page, `${url}?engine=browser&prompt=off`) },
];

test("tools navigation retains its explicit load condition", async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    await page.route("http://stack.test/**", route => serveFixture(route, held));
    let loaded = false;
    page.once("load", () => { loaded = true; });
    const requested = page.waitForRequest("http://stack.test/held.png");
    const opening = openPlaygroundPage(page, "http://stack.test/?engine=browser&prompt=off", { waitUntil: "load" })
      .then(status => { expect(loaded).toBe(true); return status; });
    const result = opening.then(value => ({ value }), error => ({ error }));
    await requested;
    await page.waitForFunction(() => document.readyState === "interactive");
    release();
    expect(await result).toEqual({ value: "ready" });
    expect(await page.evaluate(() => document.readyState)).toBe("complete");
  } finally { release(); await browser.close(); }
}, 30_000);
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
    expect(page.url()).toBe(`http://stack.test/?engine=${consumer.name}&prompt=off`);
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
  let navigations = 0;
  try {
    browser = await engine.launch();
    const page = await browser.newPage();
    const target = `${server.url}?engine=${consumer.name}&prompt=off`;
    const timeout = new errors.TimeoutError("fixture navigation timeout");
    const realGoto = page.goto.bind(page);
    if (mode === "timeout") page.goto = async () => { navigations++; throw timeout; };
    if (mode === "connection") await page.route("**/*", route => route.abort());
    if (mode === "sink") await page.close();
    if (mode === "publication") await page.route("**/*", route => serveFixture(route, held, false));
    const routes = mode === "sink" ? undefined : spyRoutes(page);
    let failure: unknown;
    try { await consumer.open(page, String(server.url)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    // The WebKit route is removed even when goto fails before it fires (timeout) or the request is aborted.
    if (routes) expect(routes.calls).toEqual(engine.name() === "webkit" ? ["route", "unroute"] : []);
    const handledBefore = routes?.handled() ?? 0;
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
      expect(navigations).toBe(1);
      expect(report).toMatchObject({ pageState: { outcome: "ok", value: { readyState: "complete", status: null, published: false } } });
    }
    // The route is really gone: navigating to the same URL again runs none of the recorded handlers.
    // Commit is enough: the publication fixture holds a resource, so load never fires.
    await realGoto(target, { waitUntil: "commit" }).catch(() => {});
    expect(routes?.handled()).toBe(handledBefore);
  } finally {
    release();
    const stopped = await Promise.allSettled([browser?.close(), server.stop(true)]);
    if (previous === undefined) delete process.env.BUN_WASM_BROWSER_REPORT_DIR;
    else process.env.BUN_WASM_BROWSER_REPORT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
    expect(stopped.filter(result => result.status === "rejected")).toEqual([]);
  }
}

type RouteHandler = Parameters<Page["route"]>[1];

/**
 * Records route registrations and removals made after this call, and counts how often their handlers run,
 * so a later navigation can show that no registered route is still intercepting.
 */
function spyRoutes(page: Page): { calls: string[]; handled: () => number } {
  const route = page.route.bind(page);
  const unroute = page.unroute.bind(page);
  const calls: string[] = [];
  const wrappers = new Map<RouteHandler, RouteHandler>();
  let handled = 0;
  page.route = async (url, handler, options) => {
    calls.push(options?.times === undefined ? "route" : `route times=${options.times}`);
    const counted: RouteHandler = (...args) => { handled++; return handler(...args); };
    wrappers.set(handler, counted);
    return route(url, counted, options);
  };
  page.unroute = async (url, handler) => {
    calls.push("unroute");
    return unroute(url, handler && (wrappers.get(handler) ?? handler));
  };
  return { calls, handled: () => handled };
}

// WebKit bug 325840 workaround: a cross-origin-isolated document from a real server is admitted through a
// pass-through route on WebKit only, removed after the navigation. With a context route, the pass-through
// must hand the document to it, and that handler's own continue() must still succeed.
async function isolatedDocument(engine: BrowserType, consumer: Consumer, withContextRoute = false): Promise<void> {
  const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
  const body = `<span id="status">loading</span><script>globalThis.playground = {}; document.querySelector('#status').textContent = 'ready';</script>`;
  let documents = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/later") return new Response("later", { headers: isolation });
      documents++;
      return new Response(body, { headers: { ...isolation, "content-type": "text/html" } });
    },
  });
  const browser = await engine.launch();
  try {
    const context = await browser.newContext();
    const continued: string[] = [];
    const rejected: string[] = [];
    if (withContextRoute) await context.route("**/*", route => route.continue().then(
      () => { continued.push(new URL(route.request().url()).pathname); },
      (error: unknown) => { rejected.push(String(error)); },
    ));
    const page = await context.newPage();
    const routes = spyRoutes(page);
    await consumer.open(page, String(server.url));
    expect(await page.textContent("#status")).toBe("ready");
    expect(routes.calls).toEqual(engine.name() === "webkit" ? ["route", "unroute"] : []);
    // On WebKit the pass-through saw the document once; on other engines nothing was routed.
    expect(routes.handled()).toBe(engine.name() === "webkit" ? 1 : 0);
    expect(rejected).toEqual([]);
    expect(continued).toEqual(withContextRoute ? ["/"] : []);
    expect(documents).toBe(1);
    expect(page.url()).toBe(`${server.url}?engine=${consumer.name}&prompt=off`);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => fetch("/later").then(response => response.text()))).toBe("later");
    // The route is really gone: a second navigation to the same URL runs no recorded handler.
    const handled = routes.handled();
    await page.goto(page.url());
    expect(documents).toBe(2);
    expect(routes.handled()).toBe(handled);
  } finally {
    await Promise.allSettled([browser.close(), server.stop(true)]);
  }
}

function registerControls(engine: BrowserType, consumer: Consumer) {
  const label = `${engine.name()} ${consumer.name}`;
  test(`${label}: readiness does not wait for an unrelated load resource`, () => heldResource(engine, consumer), 10_000);
  test(`${label}: runtime publication failure retains document and held-resource stages`, () => navigationFailure(engine, consumer, "publication"), 30_000);
  test(`${label}: a navigation timeout records page and independent server state without retrying`, () => navigationFailure(engine, consumer, "timeout"), 30_000);
  test(`${label}: a cross-origin-isolated document opens without a lingering route`, () => isolatedDocument(engine, consumer), 30_000);
  test(`${label}: a context route still continues the cross-origin-isolated document`, () => isolatedDocument(engine, consumer, true), 30_000);
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
