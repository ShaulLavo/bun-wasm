import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { createSafariTransport, type SafariTransport, type SafariTransportOptions } from "./safari-transport";

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

function document(url = "about:blank"): Context {
  return createContext({ setTimeout, clearTimeout, location: { href: url } });
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

function fixture(options: FixtureOptions = {}) {
  const calls: Call[] = [];
  const pending = new Set<Promise<Response>>();
  const windows = new Map<string, Context>([["host", document()]]);
  let selected = "host", created = 0, deleted = false, scriptTimeout = 1000;

  async function route(call: Call): Promise<Response> {
    if (call.path === "/session" && call.method === "POST") return reply({ sessionId: "owned", capabilities: options.capabilities ?? desktop });
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
      assert.ok(windows.has(selected));
      return reply(null);
    }
    if (call.path === "/session/owned/window" && call.method === "DELETE") { windows.delete(selected); return reply(Array.from(windows.keys())); }
    if (call.path === "/session/owned/url") { windows.set(selected, document(text(call.body.url))); return reply(null); }
    if (call.path === "/session/owned/execute/async") {
      const context = windows.get(selected);
      assert.ok(context);
      return execute(context, call, scriptTimeout);
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
  const driver = { calls, windows, get selected() { return selected; }, get deleted() { return deleted; },
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
    const value = await transport.evaluate<{ answer: number; nested: unknown[] }>('new Promise(resolve => setTimeout(() => resolve({ answer: 42, nested: [null, true, "unicode ☃"] }), 25))');
    expect(value).toEqual({ answer: 42, nested: [null, true, "unicode ☃"] });
    expect(await transport.evaluate("null")).toBeNull();
    expect(await transport.evaluate("undefined")).toBeNull();
    expect(driver.calls.at(-1)?.body.args).toEqual(["undefined"]);
    expect(driver.calls.at(-1)?.path).toEndWith("/execute/async");
  } finally { await transport.close(); }
});

test("propagates synchronous, rejected-promise, syntax, and JSON serialization errors without poisoning later commands", async () => {
  const transport = await fixture().connect();
  try {
    await expect(transport.evaluate('(() => { throw new Error("sync failure"); })()')).rejects.toThrow("sync failure");
    await expect(transport.evaluate('new Promise((_, reject) => setTimeout(() => reject(new Error("delayed failure")), 10))')).rejects.toThrow("delayed failure");
    await expect(transport.evaluate("(()")).rejects.toThrow("SyntaxError");
    await expect(transport.evaluate("1n")).rejects.toThrow(/BigInt/);
    await expect(transport.evaluate("(() => { const v = {}; v.self = v; return v; })()")).rejects.toThrow(/circular|cyclic/i);
    expect(await transport.evaluate<number>("6 * 7")).toBe(42);
  } finally { await transport.close(); }
});

test("host and retained preview survive serialized alternation, and usePreview never navigates or creates", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  try {
    await transport.navigate("http://fixture.test/editor");
    await transport.evaluate('globalThis.editor = "alive"');
    await transport.openPreview("http://fixture.test/app");
    await transport.evaluate("globalThis.documentIdentity = 123");
    const before = driver.calls.length;
    const results = await Promise.all([
      transport.evaluate('new Promise(resolve => setTimeout(() => resolve(globalThis.documentIdentity), 20))'),
      transport.useHost(), transport.evaluate("globalThis.editor"), transport.usePreview(), transport.evaluate("globalThis.documentIdentity"),
    ]);
    expect(results).toEqual([123, undefined, "alive", undefined, 123]);
    const alternation = driver.calls.slice(before);
    expect(alternation.filter(call => call.path.endsWith("/window")).map(call => call.body.handle)).toEqual(["host", "preview-1"]);
    expect(alternation.some(call => call.path.endsWith("/url") || call.path.endsWith("/window/new"))).toBe(false);
    await transport.openPreview("http://fixture.test/replacement");
    expect(await transport.evaluate("globalThis.documentIdentity")).toBeNull();
    expect(driver.windows.size).toBe(2);
    expect(driver.calls.filter(call => call.path.endsWith("/window/new"))).toHaveLength(1);
    await transport.useHost();
    expect(await transport.evaluate("globalThis.editor")).toBe("alive");
    await transport.closePreview();
    expect(driver.selected).toBe("host");
    expect(driver.windows.size).toBe(1);
    await expect(transport.usePreview()).rejects.toThrow("no preview");
    await transport.closePreview();
    await transport.openPreview("http://fixture.test/next");
    expect(driver.windows.has("preview-2")).toBe(true);
  } finally { await transport.close(); }
});

test("failed preview navigation closes only the owned preview and restores host", async () => {
  const driver = fixture({ intercept: call => call.path.endsWith("/url") ? failure("navigation failed") : undefined });
  const transport = await driver.connect();
  try {
    await expect(transport.openPreview("http://fixture.test/broken")).rejects.toThrow("navigation failed");
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
  const transport = await driver.connect();
  try {
    const error = await capturedFailure(transport.openPreview("http://fixture.test/broken"));
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
  const transport = await driver.connect();
  await transport.openPreview("http://fixture.test/app");
  failCleanup = true;
  const error = await capturedFailure(transport.closePreview());
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
  const transport = await driver.connect();
  try {
    await expect(transport.openPreview("http://fixture.test/app")).rejects.toThrow("host handle");
    expect(driver.calls.some(call => call.path.endsWith("/window") && call.method === "DELETE")).toBe(false);
  } finally { await transport.close(); }
});

test("bounds never-settling promises and stalled HTTP commands", async () => {
  const driver = fixture();
  const transport = await driver.connect({ timeoutMs: 50 });
  try {
    await expect(transport.evaluate("new Promise(() => {})")).rejects.toThrow();
  } finally { await transport.close(); }
  const stalled = fixture({ intercept: async call => {
    if (!call.path.endsWith("/execute/async")) return;
    await Bun.sleep(200);
    return reply({ ok: true, json: "42" });
  } });
  const second = await stalled.connect({ timeoutMs: 50 });
  try { await expect(second.evaluate("42")).rejects.toThrow(); }
  finally { await second.close(); }
  expect(driver.deleted).toBe(true);
  expect(stalled.deleted).toBe(true);
});

test("close waits for queued commands, sends DELETE once, and rejects new operations", async () => {
  const driver = fixture();
  const transport = await driver.connect();
  const evaluating = transport.evaluate("new Promise(resolve => setTimeout(() => resolve(42), 20))");
  const closed = transport.close();
  expect(transport.close()).toBe(closed);
  await expect(transport.useHost()).rejects.toThrow("closed");
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
  const evaluating = capturedFailure(transport.evaluate("42"));
  while (!started) await Bun.sleep(1);
  const queued = capturedFailure(transport.useHost());
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
    try { await expect(transport.evaluate("42")).rejects.toThrow(); }
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
