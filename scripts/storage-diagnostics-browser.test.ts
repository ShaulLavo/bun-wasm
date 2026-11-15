import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { diagnostic } from "../sandbox/tests/storage-browser";
import { StorageLifetime } from "./storage-browser-evidence";

type Event = Parameters<NonNullable<ConstructorParameters<typeof StorageLifetime>[0]>>[0];
const lifetimes: StorageLifetime[] = [];
const expectedFailures = new Map<StorageLifetime, readonly Error[]>();
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) {
    await lifetime.cleanup();
    const expected = expectedFailures.get(lifetime) ?? [];
    expectedFailures.delete(lifetime);
    assertFailures(lifetime.failures, expected);
    if (expected.length === 0) lifetime.assertClean();
    else assert.throws(() => lifetime.assertClean(), error => error instanceof AggregateError && hasFailures(error.errors, expected));
  }
});

function hasFailures(actual: readonly unknown[], expected: readonly Error[]): boolean {
  return actual.length === expected.length && actual.every((error, index) => error === expected[index]);
}

function assertFailures(actual: readonly unknown[], expected: readonly Error[]): void {
  assert(hasFailures(actual, expected), `Unexpected evidence or cleanup failures: ${actual.map(String).join(", ")}`);
}

type ContextOptions = {
  open?: (browser: Browser) => Promise<BrowserContext>;
  close?: (context: BrowserContext) => Promise<void>;
};

async function fixture(engine: BrowserType, write?: (event: Event) => void, contextOptions: ContextOptions = {}) {
  const events: Event[] = [];
  const lifetime = new StorageLifetime(event => { events.push(event); write?.(event); });
  lifetimes.push(lifetime);
  let closeContext: (() => Promise<void>) | undefined;
  const { value: browser } = await lifetime.acquire("browser.launch", () => engine.launch({ headless: true }), async browser => {
    try { await closeContext?.(); }
    finally { await browser.close(); }
  });
  lifetime.observeBrowser(browser);
  const opening = contextOptions.open ? contextOptions.open(browser) : browser.newContext();
  let contextClosing = false;
  closeContext = lifetime.own("context.close", async () => {
    contextClosing = true;
    const context = await opening;
    await (contextOptions.close ? contextOptions.close(context) : context.close());
  });
  const context = await opening;
  if (contextClosing) throw new Error("Storage diagnostic context closed during setup");
  lifetime.observeContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.route("http://storage.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Host</h1>" }));
  await page.goto("http://storage.test/");
  return { browser, page, events, lifetime };
}

function requestEvents(events: readonly Event[], path: string): Event[] {
  return events.filter(event => typeof event.detail === "object" && event.detail !== null && "url" in event.detail
    && event.detail.url === `http://storage.test/${path}`);
}

function eventDetail(event: Event | undefined): object {
  assert(event && event.detail && typeof event.detail === "object");
  // Bun 1.4.4's asymmetric matchers mutate their input; preserve the emitted journal.
  return structuredClone(event.detail);
}

function requestIdentity(event: Event | undefined): { page: number; request: number } {
  assert(event && event.detail && typeof event.detail === "object" && "page" in event.detail && "request" in event.detail);
  const { page, request } = event.detail;
  assert(typeof page === "number" && typeof request === "number");
  return { page, request };
}

async function frameSnapshot(page: Page) {
  const snapshot = await diagnostic(page);
  assert.notEqual(typeof snapshot, "string");
  if (typeof snapshot === "string") throw new Error(snapshot);
  assert.equal(snapshot.frames.length, 1);
  return snapshot.frames[0];
}

async function acceptDocument(page: Page, accepted: boolean | null): Promise<void> {
  await page.evaluate(accepted => {
    const frame = document.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Missing iframe");
    const loaded = accepted === null ? { document: null } : accepted ? { document: frame.contentDocument } : null;
    Object.assign(window, { sandbox: { fs: { state: { status: "ready" } }, editor: { path: null, hasPending: false }, preview: () => ({ loaded }) } });
  }, accepted);
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: delayed iframe module exposes loading, completion, render and accepted Document`, async () => {
    const started = performance.now();
    const { page, events, lifetime } = await fixture(engine);
    const held = Promise.withResolvers<void>();
    lifetime.own("module.release", () => held.resolve());
    const requested = Promise.withResolvers<void>();
    await page.route("**/delayed.ts", async route => {
      requested.resolve();
      await held.promise;
      await route.fulfill({ contentType: "text/javascript", body: 'document.body.innerHTML = "<h1>Rendered module</h1>";' });
    });
    await page.route("**/preview", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><body><script type="module" src="/delayed.ts"></script>' }));
    await page.evaluate(() => { document.body.innerHTML = '<iframe name="preview" src="/preview"></iframe>'; });
    await requested.promise;
    await acceptDocument(page, false);
    expect(await frameSnapshot(page)).toMatchObject({ documentUrl: "http://storage.test/preview", readyState: "interactive", acceptedDocument: false });
    const pending = requestEvents(events, "delayed.ts");
    expect(pending.map(event => event.kind)).toEqual(["request"]);
    expect(eventDetail(pending[0])).toMatchObject({ request: expect.any(Number), startObserved: true, method: "GET", resourceType: "script", navigation: false,
      frame: { frame: expect.any(Number), name: "preview", main: false, parent: expect.any(Number) } });
    held.resolve();
    await page.frameLocator("iframe").getByRole("heading", { name: "Rendered module" }).waitFor();
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");
    expect(await frameSnapshot(page)).toMatchObject({ readyState: "complete", acceptedDocument: false, body: "Rendered module" });
    await acceptDocument(page, true);
    expect(await frameSnapshot(page)).toMatchObject({ readyState: "complete", acceptedDocument: true });
    const delivered = requestEvents(events, "delayed.ts");
    expect(delivered.map(event => event.kind)).toEqual(["request", "response", "requestfinished"]);
    const first = pending[0]?.detail;
    assert(first && typeof first === "object");
    for (const event of delivered) expect(eventDetail(event)).toMatchObject(first);
    expect(eventDetail(delivered[1])).toMatchObject({ status: 200 });
    const navigation = requestEvents(events, "preview");
    expect(eventDetail(navigation.find(event => event.kind === "request"))).toMatchObject({ resourceType: "document", navigation: true });
    const request = pending[0]?.detail;
    assert(request && typeof request === "object" && "frame" in request);
    assert(request.frame && typeof request.frame === "object");
    expect(eventDetail(navigation.find(event => event.kind === "navigation"))).toMatchObject(request.frame);
    const replaced = page.waitForEvent("framenavigated", frame => frame.url() === "http://storage.test/replaced");
    await page.locator("iframe").evaluate(frame => { if (frame instanceof HTMLIFrameElement) frame.src = "/replaced"; });
    await replaced;
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");
    expect(await frameSnapshot(page)).toMatchObject({ documentUrl: "http://storage.test/replaced", readyState: "complete", acceptedDocument: false });
    await acceptDocument(page, false);
    await page.frameLocator("iframe").locator("body").evaluate(() => { document.open(); document.write("<h1>Parsing</h1>"); });
    expect(await frameSnapshot(page)).toMatchObject({ readyState: "loading", acceptedDocument: false });
    await page.frameLocator("iframe").locator("body").evaluate(() => document.close());
    console.log(JSON.stringify({ browser: engine.name(), control: "delayed module", durationMs: performance.now() - started, events: delivered }));
  }, 60_000);

  test(`${engine.name()}: concurrent same-URL, failed, unknown-start and lost requests stay distinct`, async () => {
    const started = performance.now();
    const { page, events, lifetime } = await fixture(engine);
    const held = Promise.withResolvers<void>();
    lifetime.own("requests.release", () => held.resolve());
    const both = Promise.withResolvers<void>();
    let count = 0;
    await page.route("**/same", async route => {
      if (++count === 2) both.resolve();
      await held.promise;
      await route.fulfill({ status: 201, body: "delivered" });
    });
    const fetching = page.evaluate(() => Promise.all([fetch("/same", { cache: "no-store" }), fetch("/same", { cache: "no-store" })]).then(responses => Promise.all(responses.map(response => response.text()))));
    await both.promise;
    const pending = requestEvents(events, "same");
    expect(pending.map(event => event.kind)).toEqual(["request", "request"]);
    expect(new Set(pending.map(event => requestIdentity(event).request)).size).toBe(2);
    let completed = 0;
    const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/same") && ++completed === 2);
    held.resolve();
    expect(await fetching).toEqual(["delivered", "delivered"]);
    await finished;
    const delivered = requestEvents(events, "same");
    for (const start of pending) {
      assert(start.detail && typeof start.detail === "object" && "request" in start.detail);
      const request = start.detail.request;
      const related = delivered.filter(event => typeof event.detail === "object" && event.detail !== null && "request" in event.detail && event.detail.request === request);
      expect(related.map(event => event.kind)).toEqual(["request", "response", "requestfinished"]);
      expect(eventDetail(related[1])).toMatchObject({ status: 201, startObserved: true });
    }
    await page.route("**/failed", route => route.abort("failed"));
    const failed = page.waitForEvent("requestfailed");
    await page.evaluate(() => fetch("/failed").catch(() => {}));
    await failed;
    const failures = requestEvents(events, "failed");
    expect(failures.map(event => event.kind)).toEqual(["request", "requestfailed"]);
    expect(requestIdentity(failures[1])).toEqual(requestIdentity(failures[0]));
    expect(pending.map(event => requestIdentity(event).request)).not.toContain(requestIdentity(failures[0]).request);
    expect(eventDetail(failures[1])).toMatchObject({ startObserved: true, failure: { errorText: expect.any(String) } });
    await unknownStart(await page.context().newPage(), events);
    await lostRequest(page, events, lifetime);
    console.log(JSON.stringify({ browser: engine.name(), control: "request lifecycles", durationMs: performance.now() - started, events: events.filter(event => /^(request|response|page-close)/.test(event.kind)) }));
  }, 60_000);

  test(`${engine.name()}: null cross-origin iframe Document is never accepted`, async () => {
    const { page } = await fixture(engine);
    await page.route("http://other.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Other origin</h1>" }));
    const loaded = page.waitForEvent("framenavigated", frame => frame.url() === "http://other.test/");
    await page.evaluate(() => { document.body.innerHTML = '<iframe src="http://other.test/"></iframe>'; });
    await loaded;
    await acceptDocument(page, null);
    expect(await page.locator("iframe").evaluate(frame => frame instanceof HTMLIFrameElement && frame.contentDocument === null)).toBe(true);
    const snapshot = await frameSnapshot(page);
    expect(snapshot).toMatchObject({ src: "http://other.test/", acceptedDocument: false });
    expect(snapshot?.documentUrl).toBeUndefined();
    expect(snapshot?.readyState).toBeUndefined();
  }, 60_000);

  for (const primary of [false, true]) {
    for (const closeFailure of [false, true]) test(`${engine.name()}: response evidence write failure blocks with primary=${primary}, closeFailure=${closeFailure}`,
      () => responseFailure(engine, primary, closeFailure), 60_000);
  }

  test(`${engine.name()}: context teardown settles late iframe load before browser close`, () => orderedTeardown(engine), 60_000);
  test(`${engine.name()}: cleanup awaits late context acquisition before browser close`, () => lateContext(engine), 60_000);
  test(`${engine.name()}: context setup rejection still closes browser`, () => rejectedSetup(engine), 60_000);
}

async function responseFailure(engine: BrowserType, primary: boolean, closeFailure: boolean): Promise<void> {
  const started = performance.now();
  const failure = new Error("response evidence write failed");
  const original = new Error("original storage assertion");
  const report = new Error("fixture report failed");
  const close = new Error("fixture context close failed");
  const response = Promise.withResolvers<void>();
  const { browser, page, lifetime, events } = await fixture(engine, event => {
    if (event.kind !== "response" || requestEvents([event], "evidence").length === 0) return;
    response.resolve();
    throw failure;
  }, closeFailure ? { close: async () => { throw close; } } : {});
  const expected = closeFailure ? [failure, report, close] : [failure];
  expectedFailures.set(lifetime, expected);
  await page.evaluate(() => { document.body.innerHTML = '<iframe src="/evidence"></iframe>'; });
  await response.promise;
  if (closeFailure) lifetime.secondary("fixture.report", report);
  const run = lifetime.run(async () => { if (primary) throw original; });
  await assert.rejects(run, error => primary ? error === original : error instanceof AggregateError && hasFailures(error.errors, expected));
  assertFailures(lifetime.failures, expected);
  assert.equal(browser.isConnected(), false);
  assert.equal(page.isClosed(), true);
  assert.equal(requestEvents(events, "evidence").filter(event => event.kind === "response").length, 1);
  console.log(JSON.stringify({ browser: engine.name(), control: "response failure", primary, closeFailure, durationMs: performance.now() - started,
    failures: lifetime.failures.map(String), events: events.filter(event => /^(cleanup|secondary|context-close|browser-disconnected)/.test(event.kind)) }));
}

async function orderedTeardown(engine: BrowserType): Promise<void> {
  const started = performance.now();
  const closing = Promise.withResolvers<void>();
  const allowClose = Promise.withResolvers<void>();
  const order: string[] = [];
  let cleanup = async () => {};
  try {
    const { browser, page, events, lifetime } = await fixture(engine, undefined, { close: async context => {
      order.push("context close started");
      closing.resolve();
      await allowClose.promise;
      await context.close();
      order.push("context close settled");
    } });
    cleanup = () => lifetime.cleanup();
    browser.on("disconnected", () => order.push("browser disconnected"));
    const frame = await lateLoad(page, lifetime);
    const loaded = frame.waitForLoadState("load");
    void lifetime.cleanup();
    await closing.promise;
    await loaded;
    assert.equal(browser.isConnected(), true);
    assert.equal(await frame.locator("h1").textContent(), "Late module");
    allowClose.resolve();
    await cleanup();
    assert.deepEqual(order, ["context close started", "context close settled", "browser disconnected"]);
    assert.equal(page.isClosed(), true);
    assert.equal(browser.contexts().length, 0);
    console.log(JSON.stringify({ browser: engine.name(), control: "ordered teardown", durationMs: performance.now() - started, order,
      events: events.filter(event => /^(cleanup|context-close|browser-disconnected)/.test(event.kind)) }));
  } finally { allowClose.resolve(); await cleanup(); }
}

async function lateLoad(page: Page, lifetime: StorageLifetime) {
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  lifetime.own("module.release", () => held.resolve());
  await page.route("**/late.ts", async route => {
    requested.resolve();
    await held.promise;
    await route.fulfill({ contentType: "text/javascript", body: 'document.body.innerHTML = "<h1>Late module</h1>";' });
  });
  await page.route("**/late", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><body><script type="module" src="/late.ts"></script>' }));
  await page.evaluate(() => { document.body.innerHTML = '<iframe src="/late"></iframe>'; });
  await requested.promise;
  const frame = page.frames().find(frame => frame.url() === "http://storage.test/late");
  assert(frame);
  return frame;
}

async function lateContext(engine: BrowserType): Promise<void> {
  const started = performance.now();
  const acquired = Promise.withResolvers<Browser>();
  const deliver = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const setup = fixture(engine, event => {
    if (event.kind === "cleanup-begin" && typeof event.detail === "object" && event.detail !== null
      && "phase" in event.detail && event.detail.phase === "context.close") closing.resolve();
  }, { open: async browser => {
    const context = await browser.newContext();
    acquired.resolve(browser);
    await deliver.promise;
    return context;
  } }).then(() => assert.fail("Setup must reject after context cleanup"), error => error);
  const browser = await acquired.promise;
  const lifetime = lifetimes.at(-1);
  assert(lifetime);
  const cleanup = lifetime.cleanup();
  try {
    await closing.promise;
    assert.equal(browser.isConnected(), true);
  } finally { deliver.resolve(); await cleanup; }
  assert.match(String(await setup), /closed/);
  assert.equal(browser.isConnected(), false);
  assert.equal(browser.contexts().length, 0);
  console.log(JSON.stringify({ browser: engine.name(), control: "late context", durationMs: performance.now() - started }));
}

async function rejectedSetup(engine: BrowserType): Promise<void> {
  const started = performance.now();
  const acquired = Promise.withResolvers<Browser>();
  await assert.rejects(fixture(engine, undefined, { open: async browser => {
    acquired.resolve(browser);
    const context = await browser.newContext();
    await context.close();
    return context;
  } }), /closed/);
  const browser = await acquired.promise;
  const lifetime = lifetimes.at(-1);
  assert(lifetime);
  await lifetime.cleanup();
  assert.equal(browser.isConnected(), false);
  console.log(JSON.stringify({ browser: engine.name(), control: "setup rejection", durationMs: performance.now() - started }));
}

async function unknownStart(page: Page, events: Event[]): Promise<void> {
  await page.route("http://storage.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Unknown start control</h1>" }));
  await page.goto("http://storage.test/unknown-host");
  await page.route("**/unknown", async route => {
    await route.fulfill({ status: 202, body: "unknown start" });
  });
  await page.removeAllListeners("request");
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/unknown"));
  await page.evaluate(() => fetch("/unknown").then(response => response.text()));
  await finished;
  const unknown = requestEvents(events, "unknown");
  expect(unknown.map(event => event.kind)).toEqual(["response", "requestfinished"]);
  expect(eventDetail(unknown[0])).toMatchObject({ status: 202, startObserved: false });
  assert(unknown[0]?.detail && typeof unknown[0].detail === "object" && "request" in unknown[0].detail);
  expect(eventDetail(unknown[1])).toMatchObject({ request: unknown[0].detail.request, startObserved: false });
  expect(requestIdentity(unknown[0])).toEqual(requestIdentity(unknown[1]));
  expect(requestIdentity(unknown[0]).request).not.toBe(requestIdentity(requestEvents(events, "unknown-host")[0]).request);
}

async function lostRequest(page: Page, events: Event[], lifetime: StorageLifetime): Promise<void> {
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  lifetime.own("lost.release", () => release.resolve());
  await page.route("**/lost", async () => { requested.resolve(); await release.promise; });
  await page.evaluate(() => { void fetch("/lost").catch(() => {}); });
  await requested.promise;
  await page.removeAllListeners("requestfailed");
  try { await page.close(); }
  finally { release.resolve(); }
  expect(requestEvents(events, "lost").map(event => event.kind)).toEqual(["request"]);
  expect(events.some(event => event.kind === "page-close")).toBe(true);
}
