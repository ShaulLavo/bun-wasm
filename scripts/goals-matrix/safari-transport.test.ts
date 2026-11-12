import { withScoped, withAdmission } from "./scope-fixture";
import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { createSafariTransport, type SafariTransport, type SafariTransportOptions } from "./safari-transport";
import { campaignDeadlines, cellDeadlines } from "./deadlines";
import { Scope } from "./scope";
import { armSafariClick, observeSafariClick } from "./safari-click";

type Call = { method: string; path: string; body: Record<string, unknown> };
type FixtureOptions = {
  capabilities?: Record<string, unknown>;
  intercept?: (call: Call) => Response | undefined | Promise<Response | undefined>;
};
const fixtures: { stop(): Promise<void> }[] = [];
afterEach(async () => { for (const driver of fixtures.splice(0)) await driver.stop(); });

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
function reply(value: unknown, status = 200): Response { return Response.json({ value }, { status }); }
function failure(message: string): Response { return reply({ error: "unknown error", message }, 500); }
const desktop = { browserName: "Safari", browserVersion: "26.4", platformName: "macOS", "safari:automaticInspection": false };
const iphone = { browserName: "Safari", browserVersion: "26.5", platformName: "iOS", "safari:useSimulator": true,
  "safari:deviceType": "iPhone", "safari:deviceUDID": "owned-iphone" };

class FixtureFrame {
  id = "";
  src = "";
  title = "";
  style = { cssText: "" };
  dataset: Record<string, string> = {};
  readonly reference = crypto.randomUUID();
  context: Context = createContext();
  constructor(readonly elements: Map<string, FixtureFrame>) {}
  addEventListener(): void {}
  focus(): void {}
  remove(): void { if (this.elements.get(this.id) === this) this.elements.delete(this.id); }
}

function document(url = "about:blank"): Context {
  const elements = new Map<string, FixtureFrame>();
  return createContext({ setTimeout, clearTimeout, crypto, location: { href: url }, HTMLIFrameElement: FixtureFrame,
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new FixtureFrame(elements),
      body: { appendChild(frame: FixtureFrame) { frame.context = document(frame.src); elements.set(frame.id, frame); } },
    },
  });
}

async function execute(context: Context, call: Call, timeoutMs: number): Promise<Response> {
  const args = call.body.args;
  assert.ok(Array.isArray(args));
  const script = runInContext(`(function () { ${text(call.body.script)} })`, context);
  assert.equal(typeof script, "function");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: "script timeout", message: "async callback never completed" }), timeoutMs);
      script.apply(undefined, args.concat([resolve]));
    });
    return reply(value, record(value).error === "script timeout" ? 500 : 200);
  } finally { clearTimeout(timer); }
}

function executeSync(context: Context, call: Call, elements: Map<string, FixtureFrame>): Response {
  try {
    const script = runInContext(`(function () { ${text(call.body.script)} })`, context);
    assert.ok(Array.isArray(call.body.args));
    const result: unknown = script.apply(undefined, call.body.args);
    if (!(result instanceof FixtureFrame)) return reply(result);
    elements.set(result.reference, result);
    return reply({ "element-6066-11e4-a52e-4f735466cecf": result.reference });
  } catch (error) { return failure(String(error)); }
}

function fixture(options: FixtureOptions = {}) {
  const calls: Call[] = [];
  const pending = new Set<Promise<Response>>();
  const windows = new Map<string, Context>([["host", document()]]);
  const elements = new Map<string, FixtureFrame>();
  let frame: FixtureFrame | undefined;
  let selected = "host", created = 0, deleted = false, scriptTimeout = 1000;

  function context(): Context {
    const current = frame?.context ?? windows.get(selected);
    assert.ok(current);
    return current;
  }

  async function route(call: Call): Promise<Response> {
    if (call.path === "/session" && call.method === "POST") {
      const requested = record(record(call.body.capabilities).alwaysMatch);
      return reply({ sessionId: "owned", capabilities: options.capabilities ?? (requested.platformName === "iOS" ? iphone : desktop) });
    }
    if (call.path === "/session/owned" && call.method === "DELETE") { deleted = true; windows.clear(); return reply(null); }
    if (call.path === "/session/owned/timeouts") { scriptTimeout = Number(call.body.script); return reply(null); }
    if (call.path === "/session/owned/window/new") {
      const id = `preview-${++created}`;
      windows.set(id, document());
      return reply({ handle: id, type: "tab" });
    }
    if (call.path === "/session/owned/window" && call.method === "GET") return reply(selected);
    if (call.path === "/session/owned/window" && call.method === "POST") {
      selected = text(call.body.handle);
      frame = undefined;
      assert.ok(windows.has(selected));
      return reply(null);
    }
    if (call.path === "/session/owned/window" && call.method === "DELETE") { windows.delete(selected); return reply(Array.from(windows.keys())); }
    if (call.path === "/session/owned/url") { windows.set(selected, document(text(call.body.url))); return reply(null); }
    if (call.path === "/session/owned/frame") {
      frame = call.body.id === null ? undefined : elements.get(text(record(call.body.id)["element-6066-11e4-a52e-4f735466cecf"]));
      assert.ok(call.body.id === null || frame);
      return reply(null);
    }
    if (call.path === "/session/owned/execute/sync") return executeSync(context(), call, elements);
    if (call.path === "/session/owned/execute/async") {
      return execute(context(), call, scriptTimeout);
    }
    return failure(`Unexpected request ${call.method} ${call.path}`);
  }

  async function dispatch(request: Request): Promise<Response> {
    const body = request.method === "POST" ? record(await request.json()) : {};
    const call = { method: request.method, path: new URL(request.url).pathname, body };
    calls.push(call);
    return await options.intercept?.(call) ?? await route(call);
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const response = dispatch(request);
    pending.add(response);
    void response.then(() => pending.delete(response), () => pending.delete(response));
    return response;
  } });
  const driver = { calls, windows, context, get selected() { return selected; }, get deleted() { return deleted; },
    async connect(overrides: Partial<SafariTransportOptions> = {}): Promise<SafariTransport> {
      return createSafariTransport({ endpoint: server.url.href, browser: "safari", timeoutMs: 1000, ...overrides });
    },
    async stop() { await server.stop(true); await Promise.all(pending); },
  };
  fixtures.push(driver);
  return driver;
}

function selectedCalls(calls: readonly Call[]): string[] {
  return calls.map(call => `${call.method} ${call.path}${call.body.handle ? ` ${call.body.handle}` : ""}`);
}

async function capturedFailure(action: Promise<unknown>): Promise<Error> {
  try { await action; }
  catch (error) { assert.ok(error instanceof Error); return error; }
  throw new Error("Expected rejection");
}

test("requests desktop Safari and exposes exact, deeply read-only returned capabilities", async () => {
  const capabilities = { ...desktop, extra: { values: [1, 2] } };
  const driver = fixture({ capabilities });
  const transport = await driver.connect();
  try {
    expect(driver.calls[0]?.body).toEqual({ capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } } });
    expect(driver.calls[1]?.body).toEqual({ script: 1000, pageLoad: 1000, implicit: 0 });
    expect(transport.capabilities).toEqual(capabilities);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.isFrozen(transport.capabilities)).toBe(true);
    expect(Object.isFrozen(record(transport.capabilities.extra).values)).toBe(true);
  } finally { await transport.close(); }
  expect(driver.deleted).toBe(true);
});

test("pins iPhone simulator identity in both the request and returned capabilities", async () => {
  const driver = fixture({ capabilities: iphone });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try {
    expect(driver.calls[0]?.body).toEqual({ capabilities: { alwaysMatch: { browserName: "safari", platformName: "iOS",
      "safari:useSimulator": true, "safari:deviceType": "iPhone", "safari:deviceUDID": "owned-iphone" } } });
    expect(transport.capabilities).toEqual(iphone);
  } finally { await transport.close(); }
});

test("rejects emulation, wrong desktop platform, and every iPhone identity mismatch, deleting each created session", async () => {
  const mismatches = [{ browserName: "webkit" }, { platformName: "Linux" }, { "safari:useSimulator": true }];
  for (const mismatch of mismatches) {
    const driver = fixture({ capabilities: { ...desktop, ...mismatch } });
    await expect(driver.connect()).rejects.toThrow(/Safari/);
    expect(driver.deleted).toBe(true);
    expect(driver.calls.some(call => call.path.endsWith("/url"))).toBe(false);
  }
  for (const mismatch of [{ browserName: "Chrome" }, { platformName: "macOS" }, { "safari:useSimulator": false }, { "safari:deviceType": "iPad" }, { "safari:deviceUDID": "someone-elses-phone" }]) {
    const driver = fixture({ capabilities: { ...iphone, ...mismatch } });
    await expect(driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" })).rejects.toThrow(/Safari/);
    expect(driver.deleted).toBe(true);
  }
});

test("validates options before creating any session", async () => {
  const driver = fixture();
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) await expect(driver.connect({ timeoutMs })).rejects.toThrow("timeoutMs");
  await expect(driver.connect({ browser: "iphone-safari" })).rejects.toThrow("deviceUDID");
  await expect(driver.connect({ endpoint: "file:///tmp/driver" })).rejects.toThrow("HTTP");
  await expect(driver.connect({ endpoint: "http://localhost/?secret=bad" })).rejects.toThrow("HTTP");
  expect(driver.calls).toEqual([]);
});

test("awaits delayed expressions and parses nested, null, and undefined results", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  try {
    const value = await withScoped(transport, page => page.evaluate<{ answer: number; nested: unknown[] }>('new Promise(resolve => setTimeout(() => resolve({ answer: 42, nested: [null, true, "unicode ☃"] }), 25))'));
    expect(value).toEqual({ answer: 42, nested: [null, true, "unicode ☃"] });
    expect(await withScoped(transport, page => page.evaluate("null"))).toBeNull();
    expect(await withScoped(transport, page => page.evaluate("undefined"))).toBeNull();
    expect(driver.calls.at(-1)?.body.args).toEqual(["undefined"]);
    expect(driver.calls.at(-1)?.path).toEndWith("/execute/async");
  } finally { await transport.close(); }
});

test("propagates synchronous, rejected-promise, syntax, and JSON serialization errors without poisoning later commands", async () => {
  const transport = await fixture().connect();
  try {
    await expect(withScoped(transport, page => page.evaluate('(() => { throw new Error("sync failure"); })()'))).rejects.toThrow("sync failure");
    await expect(withScoped(transport, page => page.evaluate('new Promise((_, reject) => setTimeout(() => reject(new Error("delayed failure")), 10))'))).rejects.toThrow("delayed failure");
    await expect(withScoped(transport, page => page.evaluate("(()"))).rejects.toThrow("SyntaxError");
    await expect(withScoped(transport, page => page.evaluate("1n"))).rejects.toThrow(/BigInt/);
    await expect(withScoped(transport, page => page.evaluate("(() => { const v = {}; v.self = v; return v; })()"))).rejects.toThrow(/circular|cyclic/i);
    expect(await withScoped(transport, page => page.evaluate<number>("6 * 7"))).toBe(42);
  } finally { await transport.close(); }
});

test("desktop preview uses a native frame context, survives host edits and reload, and reopens for production", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.navigate("http://fixture.test/editor"));
    await withScoped(transport, page => page.evaluate('globalThis.editor = "alive"'));
    await withScoped(transport, page => page.openPreview("http://fixture.test/dev"));
    expect(driver.windows.size).toBe(1);
    expect(await withScoped(transport, page => page.evaluate("location.href"))).toBe("http://fixture.test/dev");
    await withScoped(transport, page => page.evaluate("globalThis.documentIdentity = 123"));
    await withScoped(transport, page => page.useHost());
    expect(await withScoped(transport, page => page.evaluate("editor"))).toBe("alive");
    await withScoped(transport, page => page.evaluate('globalThis.editor = "edited"'));
    const before = driver.calls.length;
    await withScoped(transport, page => page.usePreview());
    expect(await withScoped(transport, page => page.evaluate("documentIdentity"))).toBe(123);
    expect(driver.calls.slice(before).some(call => call.path.endsWith("/url"))).toBe(false);
    await withScoped(transport, page => page.useHost());
    const frame: unknown = runInContext('document.getElementById("__goalsIphonePreview")', driver.context());
    assert.ok(frame instanceof FixtureFrame);
    const token = frame.dataset.goalsPresentation;
    frame.context = document("http://fixture.test/dev");
    await withScoped(transport, page => page.usePreview());
    expect(await withScoped(transport, page => page.evaluate("globalThis.documentIdentity"))).toBeNull();
    await withScoped(transport, page => page.closePreview());
    expect(await withScoped(transport, page => page.evaluate("editor"))).toBe("edited");
    expect(frame.elements.size).toBe(0);
    await withScoped(transport, page => page.closePreview());
    await expect(withScoped(transport, page => page.usePreview())).rejects.toThrow("no preview");
    await withScoped(transport, page => page.openPreview("http://fixture.test/production"));
    expect(await withScoped(transport, page => page.evaluate("location.href"))).toBe("http://fixture.test/production");
    await withScoped(transport, page => page.useHost());
    expect(await withScoped(transport, page => page.evaluate('document.getElementById("__goalsIphonePreview").dataset.goalsPresentation'))).not.toBe(token);
    await withScoped(transport, page => page.closePreview());
    expect(driver.calls.some(call => call.path.endsWith("/window/new") || call.path.endsWith("/window") && call.method === "DELETE")).toBe(false);
    expect(driver.calls.some(call => call.path.endsWith("/frame") && call.body.id !== null)).toBe(true);
  } finally { await transport.close(); }
});

test("iPhone WebDriver host and retained preview survive serialized alternation, and usePreview never navigates or creates", async () => {
  const driver = fixture();
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try {
    await withScoped(transport, page => page.navigate("http://fixture.test/editor"));
    await withScoped(transport, page => page.evaluate('globalThis.editor = "alive"'));
    await withScoped(transport, page => page.openPreview("http://fixture.test/app"));
    await withScoped(transport, page => page.evaluate("globalThis.documentIdentity = 123"));
    const before = driver.calls.length;
    const results = await Promise.all([
      withScoped(transport, page => page.evaluate('new Promise(resolve => setTimeout(() => resolve(globalThis.documentIdentity), 20))')),
      withScoped(transport, page => page.useHost()), withScoped(transport, page => page.evaluate("globalThis.editor")), withScoped(transport, page => page.usePreview()), withScoped(transport, page => page.evaluate("globalThis.documentIdentity")),
    ]);
    expect(results).toEqual([123, undefined, "alive", undefined, 123]);
    const alternation = driver.calls.slice(before);
    expect(alternation.filter(call => call.path.endsWith("/window")).map(call => call.body.handle)).toEqual(["host", "preview-1"]);
    expect(alternation.some(call => call.path.endsWith("/url") || call.path.endsWith("/window/new"))).toBe(false);
    await withScoped(transport, page => page.openPreview("http://fixture.test/replacement"));
    expect(await withScoped(transport, page => page.evaluate("globalThis.documentIdentity"))).toBeNull();
    expect(driver.windows.size).toBe(2);
    expect(driver.calls.filter(call => call.path.endsWith("/window/new"))).toHaveLength(1);
    await withScoped(transport, page => page.useHost());
    expect(await withScoped(transport, page => page.evaluate("globalThis.editor"))).toBe("alive");
    await withScoped(transport, page => page.closePreview());
    expect(driver.selected).toBe("host");
    expect(driver.windows.size).toBe(1);
    await expect(withScoped(transport, page => page.usePreview())).rejects.toThrow("no preview");
    await withScoped(transport, page => page.closePreview());
    await withScoped(transport, page => page.openPreview("http://fixture.test/next"));
    expect(driver.windows.has("preview-2")).toBe(true);
  } finally { await transport.close(); }
});

test("desktop frame identity checks preserve a replaced or pre-existing presentation", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.openPreview("http://fixture.test/dev"));
    await withScoped(transport, page => page.useHost());
    await withScoped(transport, page => page.evaluate('document.getElementById("__goalsIphonePreview").dataset.goalsPresentation = "someone-else"'));
    await expect(withScoped(transport, page => page.usePreview())).rejects.toThrow("identity changed");
    await expect(withScoped(transport, page => page.closePreview())).rejects.toThrow("identity changed");
    await expect(withScoped(transport, page => page.openPreview("http://fixture.test/production"))).rejects.toThrow("identity changed");
    expect(await withScoped(transport, page => page.evaluate('document.getElementById("__goalsIphonePreview").dataset.goalsPresentation'))).toBe("someone-else");
    expect(driver.windows.has("host")).toBe(true);
  } finally { await transport.close(); }

  const occupied = fixture();
  const second = await occupied.connect();
  try {
    await withScoped(second, page => page.evaluate('(() => { const frame = document.createElement("iframe"); frame.id = "__goalsIphonePreview"; frame.dataset.goalsPresentation = "existing"; document.body.appendChild(frame); })()'));
    await expect(withScoped(second, page => page.openPreview("http://fixture.test/dev"))).rejects.toThrow("already occupied");
    expect(await withScoped(second, page => page.evaluate('document.getElementById("__goalsIphonePreview").dataset.goalsPresentation'))).toBe("existing");
  } finally { await second.close(); }
});

test("failed native frame selection removes only its owned frame and restores the host", async () => {
  const driver = fixture({ intercept: call => call.path.endsWith("/frame") && call.body.id !== null ? failure("frame selection failed") : undefined });
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.evaluate('globalThis.editor = "alive"'));
    await expect(withScoped(transport, page => page.openPreview("http://fixture.test/broken"))).rejects.toThrow("frame selection failed");
    expect(await withScoped(transport, page => page.evaluate('({ editor, frame: !!document.getElementById("__goalsIphonePreview") })'))).toEqual({ editor: "alive", frame: false });
    await expect(withScoped(transport, page => page.usePreview())).rejects.toThrow("no preview");
    expect(driver.calls.some(call => call.method === "DELETE" && call.path.endsWith("/window"))).toBe(false);
  } finally { await transport.close(); }
});

test("desktop reopening replaces its own frame even at the same URL and preserves unrelated frames", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.evaluate('(() => { const frame = document.createElement("iframe"); frame.id = "unrelated"; document.body.appendChild(frame); })()'));
    await withScoped(transport, page => page.openPreview("http://fixture.test/app"));
    await withScoped(transport, page => page.evaluate("globalThis.oldDocument = true"));
    await withScoped(transport, page => page.openPreview("http://fixture.test/app"));
    expect(await withScoped(transport, page => page.evaluate("globalThis.oldDocument"))).toBeNull();
    await withScoped(transport, page => page.useHost());
    expect(await withScoped(transport, page => page.evaluate('!!document.getElementById("unrelated")'))).toBe(true);
    await withScoped(transport, page => page.evaluate('document.getElementById("__goalsIphonePreview").remove()'));
    await withScoped(transport, page => page.closePreview());
    expect(await withScoped(transport, page => page.evaluate('!!document.getElementById("unrelated")'))).toBe(true);
  } finally { await transport.close(); }
});

test("a failed frame removal preserves its error and can be cleaned within the cleanup allowance", async () => {
  let failRemoval = true;
  const driver = fixture({ intercept: call => {
    const args = call.body.args;
    if (failRemoval && call.path.endsWith("/execute/sync") && Array.isArray(args) && args[1] === true) return failure("frame removal failed");
  } });
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.openPreview("http://fixture.test/dev"));
    await expect(withScoped(transport, page => page.closePreview())).rejects.toThrow("frame removal failed");
    expect(await withScoped(transport, page => page.evaluate('!!document.getElementById("__goalsIphonePreview")'))).toBe(true);
    failRemoval = false;
    await withAdmission(async admission => transport.beginCleanup?.(admission));
    await withScoped(transport, page => page.closePreview());
    expect(await withScoped(transport, page => page.evaluate('!!document.getElementById("__goalsIphonePreview")'))).toBe(false);
  } finally { await transport.close(); }
});

test("late desktop frame creation remains owned for cleanup and dispatches no expired selection", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const driver = fixture({ intercept: async call => {
    const args = call.body.args;
    if (!call.path.endsWith("/execute/sync") || !Array.isArray(args) || typeof args[0] !== "object") return;
    const script = runInContext(`(function () { ${text(call.body.script)} })`, driver.context());
    script.apply(undefined, args);
    entered.resolve(); await release.promise;
    return reply(null);
  } });
  const transport = await driver.connect();
  const scope = Scope.open(1000);
  try {
    const opening = transport.openPreview("http://fixture.test/late", scope);
    await entered.promise;
    scope.close(new Error("frame phase ended"));
    await expect(opening).rejects.toThrow("frame phase ended");
    release.resolve();
    await withScoped(transport, page => page.closePreview());
    expect(await withScoped(transport, page => page.evaluate('!!document.getElementById("__goalsIphonePreview")'))).toBe(false);
    expect(driver.calls.filter(call => call.path.endsWith("/frame") && call.body.id !== null)).toEqual([]);
    expect(driver.windows.size).toBe(1);
  } finally { release.resolve(); scope.close(); await transport.close(true); }
});

test("failed preview navigation closes only the owned preview and restores host", async () => {
  const driver = fixture({ intercept: call => call.path.endsWith("/url") ? failure("navigation failed") : undefined });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try {
    await expect(withScoped(transport, page => page.openPreview("http://fixture.test/broken"))).rejects.toThrow("navigation failed");
    expect(driver.windows.has("host")).toBe(true);
    expect(driver.windows.size).toBe(1);
    expect(driver.selected).toBe("host");
    expect(selectedCalls(driver.calls).slice(-3)).toEqual([
      "POST /session/owned/window preview-1", "DELETE /session/owned/window", "POST /session/owned/window host",
    ]);
  } finally { await transport.close(); }
});

test("preview failure preserves its first error and cleanup failures in order", async () => {
  const driver = fixture({ intercept: call => {
    if (call.path.endsWith("/url")) return failure("navigation failed");
    if (call.path.endsWith("/window") && call.method === "DELETE") return failure("preview delete failed");
  } });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try {
    const error = await capturedFailure(withScoped(transport, page => page.openPreview("http://fixture.test/broken")));
    assert.ok(error instanceof AggregateError);
    expect(error.errors.map(String)).toEqual([expect.stringContaining("navigation failed"), expect.stringContaining("preview delete failed")]);
    expect(driver.selected).toBe("host");
  } finally { await transport.close(); }
});

test("closePreview reports close and host-switch failures while session deletion can still clean up", async () => {
  let failCleanup = false;
  const driver = fixture({ intercept: call => {
    if (!failCleanup || !call.path.endsWith("/window")) return;
    if (call.method === "DELETE") return failure("window close failed");
    if (call.body.handle === "host") return failure("host switch failed");
  } });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  await withScoped(transport, page => page.openPreview("http://fixture.test/app"));
  failCleanup = true;
  const error = await capturedFailure(withScoped(transport, page => page.closePreview()));
  assert.ok(error instanceof AggregateError);
  expect(error.errors.map(String)).toEqual([expect.stringContaining("window close failed"), expect.stringContaining("host switch failed")]);
  await transport.close();
  expect(driver.deleted).toBe(true);
});

test("startup errors after session creation always delete it, and cleanup failure is not hidden", async () => {
  const driver = fixture({ intercept: call => call.path.endsWith("/timeouts") ? failure("timeouts failed") : undefined });
  await expect(driver.connect()).rejects.toThrow("timeouts failed");
  expect(driver.deleted).toBe(true);
  const failed = fixture({ intercept: call => {
    if (call.path.endsWith("/timeouts")) return failure("first startup error");
    if (call.method === "DELETE") return failure("session delete failed");
  } });
  const error = await capturedFailure(failed.connect());
  assert.ok(error instanceof AggregateError);
  expect(error.errors.map(String)).toEqual([expect.stringContaining("first startup error"), expect.stringContaining("session delete failed")]);
});

test("failed session creation never deletes a pre-existing session", async () => {
  const driver = fixture({ intercept: call => call.path === "/session" ? failure("session already in use") : undefined });
  await expect(driver.connect()).rejects.toThrow("session already in use");
  expect(driver.calls).toHaveLength(1);
  expect(driver.windows.has("host")).toBe(true);
});

test("malformed created capabilities and missing host handles clean up the created session", async () => {
  for (const path of ["/session", "/session/owned/window"]) {
    const driver = fixture({ intercept: call => {
      if (call.path !== path) return;
      return path === "/session" ? reply({ sessionId: "owned", capabilities: null }) : reply(null);
    } });
    await expect(driver.connect()).rejects.toThrow(/Safari WebDriver/);
    expect(driver.deleted).toBe(true);
  }
});

test("a malformed new-window handle cannot cause host deletion", async () => {
  const driver = fixture({ intercept: call => call.path.endsWith("/window/new") ? reply({ handle: "host" }) : undefined });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try {
    await expect(withScoped(transport, page => page.openPreview("http://fixture.test/app"))).rejects.toThrow("host handle");
    expect(driver.calls.some(call => call.path.endsWith("/window") && call.method === "DELETE")).toBe(false);
  } finally { await transport.close(); }
});

test("bounds never-settling promises and stalled HTTP commands", async () => {
  const driver = fixture();
  const transport = await driver.connect({ timeoutMs: 50 });
  try {
    await expect(withScoped(transport, page => page.evaluate("new Promise(() => {})"))).rejects.toThrow();
  } finally { await transport.close(); }
  const stalled = fixture({ intercept: async call => {
    if (!call.path.endsWith("/execute/async")) return;
    await Bun.sleep(200);
    return reply({ ok: true, json: "42" });
  } });
  const second = await stalled.connect({ timeoutMs: 50 });
  try { await expect(withScoped(second, page => page.evaluate("42"))).rejects.toThrow(); }
  finally { await second.close(); }
  expect(driver.deleted).toBe(true);
  expect(stalled.deleted).toBe(true);
});

test("close waits for queued commands, sends DELETE once, and rejects new operations", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  const evaluating = withScoped(transport, page => page.evaluate("new Promise(resolve => setTimeout(() => resolve(42), 20))"));
  const closed = transport.close();
  expect(transport.close()).toBe(closed);
  await expect(withScoped(transport, page => page.useHost())).rejects.toThrow("closed");
  expect(await evaluating).toBe(42);
  await closed;
  expect(driver.calls.at(-1)?.method).toBe("DELETE");
  expect(driver.calls.filter(call => call.path === "/session/owned" && call.method === "DELETE")).toHaveLength(1);
});

test("interrupted cleanup deletes a stalled session before its command timeout and permits the next cell", async () => {
  let started = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const driver = fixture({ intercept: async call => {
    if (!call.path.endsWith("/execute/async")) return;
    started = true;
    await held;
    return reply({ ok: true, json: "42" });
  } });
  const transport = await driver.connect({ timeoutMs: 90000 });
  const evaluating = capturedFailure(withScoped(transport, page => page.evaluate("42")));
  while (!started) await Bun.sleep(1);
  const queued = capturedFailure(withScoped(transport, page => page.useHost()));
  try {
    const closing = transport.close(true);
    await Promise.race([closing, Bun.sleep(1000).then(() => { throw new Error("Session deletion waited behind stalled command"); })]);
    expect(driver.deleted).toBe(true);
    expect(String(await evaluating)).toContain("interrupted");
    expect(String(await queued)).toContain("interrupted");
    const next = await driver.connect();
    await next.close();
    expect(driver.calls.filter(call => call.method === "POST" && call.path === "/session")).toHaveLength(2);
    expect(driver.calls.filter(call => call.method === "DELETE" && call.path === "/session/owned")).toHaveLength(2);
  } finally { release?.(); await transport.close(true); }
});

test("DELETE session failure propagates on every close call without an unsafe retry", async () => {
  const driver = fixture({ intercept: call => call.path === "/session/owned" && call.method === "DELETE" ? failure("delete session failed") : undefined });
  const transport = await driver.connect();
  const first = transport.close();
  await expect(first).rejects.toThrow("delete session failed");
  expect(transport.close()).toBe(first);
  await expect(transport.close()).rejects.toThrow("delete session failed");
  expect(driver.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});


test("reports malformed protocol and evaluation responses instead of returning false success", async () => {
  const invalidResponses = [
    () => Response.json({ missing: "value" }),
    () => reply({ error: "javascript error", message: "protocol error with HTTP 200" }),
    () => reply({ ok: true, json: "not json" }),
    () => reply({ ok: true }),
    () => new Response("not json"),
  ];
  for (const response of invalidResponses) {
    const driver = fixture({ intercept: call => call.path.endsWith("/execute/async") ? response() : undefined });
    const transport = await driver.connect();
    try { await expect(withScoped(transport, page => page.evaluate("42"))).rejects.toThrow(); }
    finally { await transport.close(); }
    expect(driver.deleted).toBe(true);
  }
});

test("startup HTTP timeout still deletes the session whose ID was already received", async () => {
  const driver = fixture({ intercept: async call => {
    if (!call.path.endsWith("/timeouts")) return;
    await Bun.sleep(200);
    return reply(null);
  } });
  await expect(driver.connect({ timeoutMs: 50 })).rejects.toThrow();
  expect(driver.deleted).toBe(true);
});

test("DELETE session timeout propagates and remains the cached close outcome", async () => {
  const driver = fixture({ intercept: async call => {
    if (call.path !== "/session/owned" || call.method !== "DELETE") return;
    await Bun.sleep(200);
    return reply(null);
  } });
  const transport = await driver.connect({ timeoutMs: 50 });
  const closing = transport.close();
  await expect(closing).rejects.toThrow();
  expect(transport.close()).toBe(closing);
  expect(driver.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

test.each(["safari", "iphone-safari"] as const)("%s session cleanup retains its inner allowance when phase deadlines tighten", async browser => {
  const limits = cellDeadlines(campaignDeadlines(), { framework: "hono", browser: "safari", engine: "browser" });
  expect(limits.timeoutMs).toBe(1470);
  const driver = fixture({ capabilities: browser === "safari" ? desktop : iphone, intercept: async call => {
    if (call.path === "/session/owned" && call.method === "DELETE") await Bun.sleep(1800);
    return undefined;
  } });
  const transport = await driver.connect({ browser, deviceUDID: browser === "iphone-safari" ? "owned-iphone" : undefined,
    timeoutMs: limits.timeoutMs, cleanupTimeoutMs: 10_000 });
  await transport.close();
  expect(driver.deleted).toBe(true);
}, 10_000);

test("cleanup updates the WebDriver script deadline only when an independent allowance is supplied", async () => {
  const ordinary = fixture();
  const direct = await ordinary.connect({ timeoutMs: 100 });
  await withAdmission(async admission => direct.beginCleanup?.(admission));
  expect(ordinary.calls.filter(call => call.path.endsWith("/timeouts")).at(-1)?.body).toEqual({ script: 100, pageLoad: 100, implicit: 0 });
  await direct.close();

  const driver = fixture();
  const transport = await driver.connect({ timeoutMs: 100, cleanupTimeoutMs: 1000 });
  try {
    await expect(withScoped(transport, page => page.evaluate("new Promise(resolve => setTimeout(() => resolve(42), 200))"))).rejects.toThrow();
    await withAdmission(async admission => transport.beginCleanup?.(admission));
    expect(await withScoped(transport, page => page.evaluate("new Promise(resolve => setTimeout(() => resolve(42), 200))"))).toBe(42);
    expect(driver.calls.filter(call => call.path.endsWith("/timeouts")).at(-1)?.body).toEqual({ script: 1000, pageLoad: 1000, implicit: 0 });
  } finally { await transport.close(); }
});

test("a late Safari preview window is retained for teardown without selection or navigation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const driver = fixture({ intercept: async call => {
    if (!call.path.endsWith("/window/new")) return;
    entered.resolve(); await release.promise;
    return reply({ handle: "late-preview" });
  } });
  const transport = await driver.connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  const scope = Scope.open(1000);
  try {
    const opening = transport.openPreview("http://fixture.test/late", scope);
    await entered.promise;
    scope.close(new Error("phase cancelled"));
    await expect(opening).rejects.toThrow("phase cancelled");
    const closing = transport.close();
    release.resolve();
    await closing;
    expect(driver.calls.filter(call => call.path.endsWith("/url"))).toEqual([]);
    expect(driver.calls.filter(call => call.path.endsWith("/window") && call.method === "POST")).toEqual([]);
    expect(driver.deleted).toBe(true);
  } finally { release.resolve(); scope.close(); await transport.close(true); }
});

test("a queued Safari command withdraws on expiry while the dispatched command remains owned", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const driver = fixture({ intercept: async call => {
    if (!call.path.endsWith("/execute/async")) return;
    entered.resolve(); await release.promise;
    return reply({ ok: true, json: "42" });
  } });
  const transport = await driver.connect();
  const scope = Scope.open(1000), queuedScope = Scope.open(1000);
  try {
    const evaluating = transport.evaluate("42", scope);
    await entered.promise;
    const queued = transport.navigate("http://fixture.test/withdrawn", queuedScope);
    queuedScope.close(new Error("queued phase ended"));
    await expect(queued).rejects.toThrow("queued phase ended");
    release.resolve();
    expect(await evaluating).toBe(42);
    await transport.close();
    expect(driver.calls.filter(call => call.path.endsWith("/url"))).toEqual([]);
  } finally { release.resolve(); scope.close(); queuedScope.close(); await transport.close(true); }
});

function counterDriver(options: { trusted?: boolean; before?: string; intercept?: FixtureOptions["intercept"] } = {}) {
  const driver = fixture({ intercept: async call => {
    const intercepted = await options.intercept?.(call);
    if (intercepted) return intercepted;
    if (call.path.endsWith("/element")) return reply({ "element-6066-11e4-a52e-4f735466cecf": "counter/id" });
    if (!call.path.endsWith("/element/counter%2Fid/click")) return;
    const context = driver.context();
    runInContext(`counter.textContent = '1'; listener({ isTrusted: ${options.trusted ?? true}, currentTarget: target });`, context);
    return reply(null);
  } });
  function install(): void {
    const context = driver.context();
    runInContext(`
      globalThis.performance = { timeOrigin: 123 };
      globalThis.listener = undefined;
      globalThis.counter = { textContent: ${JSON.stringify(options.before ?? "0")} };
      globalThis.target = { disabled: false, isConnected: true,
        addEventListener(type, callback) { if (type !== 'click') throw Error(type); listener = callback; },
        click() { throw Error('DOM click is forbidden'); } };
      globalThis.document = { querySelector(selector) { return selector === 'button' ? target : counter; } };
    `, context);
  }
  return { driver, install };
}

test("desktop click sends one WebDriver element click and requires observed trusted counter evidence", async () => {
  const { driver, install } = counterDriver();
  const transport = await driver.connect();
  try {
    await withScoped(transport, page => page.openPreview("http://fixture.test/counter"));
    install();
    const result = await withScoped(transport, page => page.nativeClick!("button", "output", 1000));
    expect(result).toEqual({ before: "0", after: "1", trusted: true, inputMethod: "Safari WebDriver element click" });
    const requests = driver.calls.filter(call => call.path.includes("/element"));
    expect(requests).toEqual([
      { method: "POST", path: "/session/owned/element", body: { using: "css selector", value: "button" } },
      { method: "POST", path: "/session/owned/element/counter%2Fid/click", body: {} },
    ]);
    expect(driver.selected).toBe("host");
  } finally { await transport.close(); }
  expect(driver.deleted).toBe(true);
});

test("an untrusted fixture event cannot pass despite the expected counter value", async () => {
  const { driver, install } = counterDriver({ trusted: false });
  const transport = await driver.connect();
  try {
    install();
    await expect(withScoped(transport, page => page.nativeClick!("button", "output", 1000))).rejects.toThrow("trusted event");
    expect(driver.calls.filter(call => call.path.endsWith("/click"))).toHaveLength(1);
  } finally { await transport.close(); }
});

test("a nonzero counter refuses native input and simulator transport retains its existing path", async () => {
  const { driver, install } = counterDriver({ before: "1" });
  const transport = await driver.connect();
  try {
    install();
    await expect(withScoped(transport, page => page.nativeClick!("button", "output", 1000))).rejects.toThrow("start at zero");
    expect(driver.calls.filter(call => call.path.includes("/element"))).toEqual([]);
  } finally { await transport.close(); }
  const simulator = await fixture({ capabilities: iphone }).connect({ browser: "iphone-safari", deviceUDID: "owned-iphone" });
  try { expect(simulator.nativeClick).toBeUndefined(); }
  finally { await simulator.close(); }
});

test.each(["/element", "/click"])("native click protocol failure at %s propagates without retry", async suffix => {
  const { driver, install } = counterDriver({ intercept: call => call.path.endsWith(suffix) ? failure("native input refused") : undefined });
  const transport = await driver.connect();
  try {
    install();
    await expect(withScoped(transport, page => page.nativeClick!("button", "output", 1000))).rejects.toThrow("native input refused");
    expect(driver.calls.filter(call => call.path.endsWith(suffix))).toHaveLength(1);
  } finally { await transport.close(); }
  expect(driver.deleted).toBe(true);
});

test("expired element lookup cannot dispatch a late native click, and cleanup retains the pending lookup", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { driver, install } = counterDriver({ intercept: async call => {
    if (!call.path.endsWith("/element")) return;
    entered.resolve(); await release.promise;
    return reply({ "element-6066-11e4-a52e-4f735466cecf": "counter/id" });
  } });
  const transport = await driver.connect();
  const scope = Scope.open(1000);
  try {
    install();
    const clicking = transport.nativeClick!("button", "output", scope);
    await entered.promise;
    scope.close(new Error("click phase ended"));
    await expect(clicking).rejects.toThrow("click phase ended");
    const closing = transport.close();
    release.resolve(); await closing;
    expect(driver.calls.filter(call => call.path.endsWith("/click"))).toEqual([]);
    expect(driver.deleted).toBe(true);
  } finally { release.resolve(); scope.close(); await transport.close(true); }
});

test("a queued native click expires before sending its arming script or input", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { driver, install } = counterDriver({ intercept: async call => {
    if (!call.path.endsWith("/url")) return;
    entered.resolve(); await release.promise;
    return reply(null);
  } });
  const transport = await driver.connect();
  const active = Scope.open(1000), queued = Scope.open(1000);
  try {
    install();
    const navigating = transport.navigate("http://fixture.test/blocked", active);
    await entered.promise;
    const clicking = transport.nativeClick!("button", "output", queued);
    queued.close(new Error("queued click ended"));
    await expect(clicking).rejects.toThrow("queued click ended");
    release.resolve(); await navigating;
    await transport.close();
    expect(driver.calls.filter(call => /\/element|\/execute/.test(call.path))).toEqual([]);
  } finally { release.resolve(); active.close(); queued.close(); await transport.close(true); }
});

test("click observation rejects replacement targets and document identity changes", async () => {
  const { driver, install } = counterDriver();
  const transport = await driver.connect();
  try {
    install();
    const input = { button: "button", clicked: "output", token: "fixture" };
    const arm = `(${armSafariClick.toString()})(${JSON.stringify(input)})`;
    const observe = `(${observeSafariClick.toString()})(${JSON.stringify(input)})`;
    await withScoped(transport, page => page.evaluate(arm));
    await withScoped(transport, page => page.evaluate("target = { ...target }"));
    await expect(withScoped(transport, page => page.evaluate(observe))).rejects.toThrow("target changed");
    await withScoped(transport, page => page.evaluate(arm));
    await withScoped(transport, page => page.evaluate("location.href = 'http://fixture.test/other'"));
    await expect(withScoped(transport, page => page.evaluate(observe))).rejects.toThrow("document changed");
  } finally { await transport.close(); }
});

test("a dispatched click stays owned past its deadline without starting an observation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { driver, install } = counterDriver({ intercept: async call => {
    if (!call.path.endsWith("/click")) return;
    entered.resolve(); await release.promise;
    return reply(null);
  } });
  const transport = await driver.connect();
  const scope = Scope.open(100);
  try {
    install();
    const clicking = transport.nativeClick!("button", "output", scope);
    await entered.promise;
    await expect(clicking).rejects.toThrow("100 ms");
    const calls = driver.calls.length;
    const closing = transport.close();
    release.resolve(); await closing;
    expect(driver.calls.slice(calls).map(call => call.method + " " + call.path)).toEqual(["DELETE /session/owned"]);
    expect(driver.calls.filter(call => call.path.endsWith("/click"))).toHaveLength(1);
  } finally { release.resolve(); scope.close(); await transport.close(true); }
});

test("a malformed element reference refuses input and a missing counter expires without input", async () => {
  const { driver, install } = counterDriver({ intercept: call => call.path.endsWith("/element") ? reply({}) : undefined });
  const transport = await driver.connect();
  try {
    install();
    await expect(withScoped(transport, page => page.nativeClick!("button", "output", 1000))).rejects.toThrow("handle");
    await withScoped(transport, page => page.evaluate("target.disabled = true"));
    await expect(withScoped(transport, page => page.nativeClick!("button", "output", 20))).rejects.toThrow("20 ms");
    await transport.close();
    expect(driver.calls.filter(call => call.path.endsWith("/click"))).toEqual([]);
  } finally { await transport.close(true); }
});
