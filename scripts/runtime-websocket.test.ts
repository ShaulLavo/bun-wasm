import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";
import { runtimeSyntax } from "./runtime-syntax";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-websocket-controls-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("preview bundles the shared typed WebSocket factory", async () => {
  const { previewWebsocketScript } = await import("../web/preview-build");
  const source = await previewWebsocketScript();
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).toContain("Invalid WebSocket handshake");
});

test("WebSocket rejects unsupported TLS options before native connection or header access", async () => {
  const { runInNewContext } = await import("node:vm");
  const output = join(scratch, "websocket-controls.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/websocket.ts"), output]);
  expect(result.exitCode).toBe(0);
  const factory: (internal: object) => { clientClass(connection: unknown): new(input: string, options?: object) => object } = runInNewContext(readFileSync(output, "utf8"), {
    TextEncoder, TextDecoder, EventTarget, URL, SyntaxError, Error,
  });
  const runtime = factory({ require: () => ({ Buffer }), native: { hostConnect() { throw new Error("unexpected native connection"); } } });
  const Socket = runtime.clientClass(class {});
  expect(() => new Socket("wss://127.0.0.1/")).toThrow("WebSocket requires a ws:// URL without credentials or a fragment");
  const options = { tls: {}, get headers() { throw new Error("headers read too early"); } };
  expect(() => new Socket("ws://127.0.0.1/", options)).toThrow("WebSocket proxy and TLS options are not supported by this networking host");
  expect(() => new Socket("ws://127.0.0.1/", { proxy: "fixture" })).toThrow("WebSocket proxy and TLS options are not supported by this networking host");
});

const originalHash = "dc216befcf12f2d82ced593f19185a9e74c97e65c72fbe48b84ccb0bc882d795";
const sourcePath = join(root, "crates/bunwasm-runtime/src/js/websocket.ts");

function emittedSource() {
  const output = join(scratch, "factory.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), sourcePath, output]);
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

const dispatch = `const callHandler = (invocation) => {
  const current = handlers();
  switch (invocation[0]) {
    case "open": return current.open?.(socket);
    case "message": return current.message?.(socket, invocation[1]);
    case "ping": return current.ping?.(socket, invocation[1]);
    case "pong": return current.pong?.(socket, invocation[1]);
    case "error": return current.error?.(socket, invocation[1]);
    case "close": return current.close?.(socket, invocation[1], invocation[2]);
    case "drain": return current.drain?.(socket);
  }
  const unhandled = invocation;
  return unhandled;
};`;
const invoke = `const invoke = (...invocation) => {
  try {
    const result = callHandler(invocation);
    if (result && typeof result.then === "function") result.catch((err) => invokeError(err));
  } catch (err) { invokeError(err); }
};`;
const originalInvoke = `const invoke = (name, ...args) => {
  try {
    const result = handlers()[name]?.(socket, ...args);
    if (result && typeof result.then === "function") result.catch((err) => invokeError(err));
  } catch (err) { invokeError(err); }
};`;

const presentState = `function present(value) {
  if (value === null || value === undefined) throw new TypeError("Missing WebSocket state");
  return value;
}`;
const sendQueued = `_sendQueued(item, bytes) {
  this._pendingBytes -= item.size;
  if (this.readyState === 1) present(this._peer).sendFrame(item.opcode, bytes);
}`;

function originalStateSyntax(text: string) {
  const parsed = ts.createSourceFile("factory.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { start: number; end: number; replacement: string }[] = [];
  const calls: string[] = [];
  function replace(node: ts.Node, replacement: string) {
    edits.push({ start: node.getStart(parsed), end: node.end, replacement });
  }
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "present") {
      expect(runtimeSyntax(node.getText(parsed))).toBe(runtimeSyntax(presentState));
      replace(node, "");
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === "_sendQueued") {
      expect(runtimeSyntax(node.getText(parsed))).toBe(runtimeSyntax(sendQueued));
      replace(node, "");
      return;
    }
    if (ts.isCallExpression(node)) inspectCall(node);
    ts.forEachChild(node, visit);
  }
  function argument(node: ts.CallExpression) {
    const value = node.arguments[0];
    if (!value || node.arguments.length !== 1) throw new Error("Expected one state argument");
    return value.getText(parsed);
  }
  function inspectCall(node: ts.CallExpression) {
    const name = node.expression.getText(parsed);
    if (name === "present") {
      const value = argument(node);
      calls.push(value);
      replace(node, `(${value})`);
    }
    if (name === "clearTimeout") {
      expect(runtimeSyntax(argument(node))).toBe(runtimeSyntax("this.closeTimer ?? undefined"));
      replace(node, "clearTimeout(this.closeTimer)");
    }
    if (name === "this._sendQueued") replace(node, "this._pendingBytes -= item.size; if (this.readyState === 1) (this._peer).sendFrame(item.opcode, bytes)");
  }
  visit(parsed);
  expect(calls).toEqual(["this._conn", "this._head", "this._key", "this._conn", "this._peer", "this._sendQueue.shift()", "this._peer"]);
  expect(edits).toHaveLength(11);
  edits.sort((left, right) => right.start - left.start);
  for (const edit of edits) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return text;
}

function originalSyntax(text: string) {
  text = originalStateSyntax(text);
  const parsed = ts.createSourceFile("factory.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { start: number; end: number; replacement: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) inspectDeclaration(node);
    ts.forEachChild(node, visit);
  }
  function inspectDeclaration(node: ts.VariableStatement) {
    const name = node.declarationList.declarations[0]?.name.getText(parsed);
    if (name !== "callHandler" && name !== "invoke") return;
    expect(runtimeSyntax(node.getText(parsed))).toBe(runtimeSyntax(name === "callHandler" ? dispatch : invoke));
    edits.push({ start: node.getStart(parsed), end: node.end, replacement: name === "callHandler" ? "" : originalInvoke });
  }
  visit(parsed);
  expect(edits).toHaveLength(2);
  edits.sort((left, right) => right.start - left.start);
  for (const edit of edits) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return createHash("sha256").update(runtimeSyntax(text)).digest("hex");
}

test("WebSocket syntax differs only by checked dispatch and explicit state checks", () => {
  expect(originalSyntax(emittedSource())).toBe(originalHash);
});

test("WebSocket syntax proof rejects a wrong handler or reordered failure", () => {
  const emitted = emittedSource();
  expect(() => originalSyntax(emitted.replace('current.pong?.(socket, invocation[1])', 'current.ping?.(socket, invocation[1])'))).toThrow();
  expect(originalSyntax(emitted.replace('this._state = 3;', 'this._state = 2;'))).not.toBe(originalHash);
  expect(() => originalSyntax(emitted.replace('value === null || value === undefined', 'value === null'))).toThrow();
});

function field(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object" && typeof value !== "function") throw new TypeError("Expected an object");
  return Reflect.get(value, key);
}
function call(receiver: unknown, name: PropertyKey, args: unknown[] = []): unknown {
  const method = field(receiver, name);
  if (typeof method !== "function") throw new TypeError("Expected a callable method");
  return Reflect.apply(method, receiver, args);
}

class Connection {
  closed = false;
  bufferedAmount = 0;
  onData: ((bytes: Uint8Array) => void) | null = null;
  onEnd: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onClose: (() => void) | null = null;
  onDrain: (() => void) | null = null;
  write(_bytes: Uint8Array) {}
  startReading() {}
  end() {}
  destroy() {}
  peer() { return { address: "synthetic" }; }
}

function server(source: string, connection: Connection, handlers: () => object) {
  const factory: unknown = runInNewContext(source, { TextEncoder, TextDecoder, setTimeout, clearTimeout });
  if (typeof factory !== "function") throw new TypeError("Expected the factory");
  const api: unknown = Reflect.apply(factory, undefined, [{ require: () => ({ Buffer }), concatBytes: (chunks: readonly Uint8Array[]) => Buffer.concat(chunks), printError(error: unknown) { throw error; } }]);
  return call(api, "serverSocket", [connection, handlers, {}, () => {}, () => 0]);
}

async function dispatchTrace(source: string) {
  const trace: unknown[] = [];
  const failure = new Error("synthetic callback failure");
  const connection = new Connection();
  let expectedReceiver: object = {};
  const handlers = {
    open(socket: unknown) { trace.push(["open", this === expectedReceiver, field(socket, "readyState")]); },
    message(_socket: unknown, data: unknown) { trace.push(["message", this === expectedReceiver, data]); throw failure; },
    drain(_socket: unknown) { trace.push(["drain", this === expectedReceiver]); return Promise.reject(failure); },
    error(_socket: unknown, error: unknown) { trace.push(["error", this === expectedReceiver, error === failure]); },
    close(_socket: unknown, code: number, reason: string) { trace.push(["close", this === expectedReceiver, code, reason]); },
  };
  const observed = new Proxy(handlers, { get(target, name, receiver) { trace.push(["get", String(name)]); return Reflect.get(target, name, receiver); } });
  expectedReceiver = observed;
  const active = server(source, connection, () => { trace.push("provider"); return observed; });
  call(active, "activate", [new Uint8Array([0x81, 0x81, 0, 0, 0, 0, 120])]);
  connection.onDrain?.();
  await Promise.resolve();
  connection.onClose?.();
  return trace;
}

test("WebSocket synthetic dispatch preserves provider reads, receiver, arguments and failures", async () => {
  const before = readFileSync(join(root, "crates/bunwasm-runtime/src/js/websocket.ts"), "utf8");
  // The pinned inverse restricts runtime changes to the checked dispatcher and explicit state checks.
  const emitted = emittedSource();
  expect(originalSyntax(emitted)).toBe(originalHash);
  const original = originalStateSyntax(emitted).replace(/const callHandler = [\s\S]*?(?=    const invokeError)/, originalInvoke + "\n");
  const expected = await dispatchTrace(original);
  expect(await dispatchTrace(emitted)).toEqual(expected);
  expect(expected).toContainEqual(["message", true, "x"]);
  expect(expected).toContainEqual(["error", true, true]);
  expect(before).toContain("const unhandled: never = invocation");
});

function setField(receiver: unknown, key: PropertyKey, value: unknown) {
  if (receiver === null || typeof receiver !== "object") throw new TypeError("Expected an object");
  Reflect.set(receiver, key, value);
}

class SyntheticEvent extends Event {
  constructor(type: string, props: object = {}) {
    super(type);
    Object.assign(this, props);
  }
}

function client(source: string, timers?: (() => void)[]) {
  const factory: unknown = runInNewContext(source, {
    TextEncoder, TextDecoder, EventTarget, Event, URL, Headers, Blob, crypto, TypeError, clearTimeout,
    setTimeout: timers ? (callback: () => void) => { timers.push(callback); return 0; } : setTimeout,
    MessageEvent: SyntheticEvent, ErrorEvent: SyntheticEvent, CloseEvent: SyntheticEvent,
  });
  if (typeof factory !== "function") throw new TypeError("Expected the factory");
  const api: unknown = Reflect.apply(factory, undefined, [{
    require: () => ({ Buffer }),
    builtin: () => ({ createHash }),
    native: { hostConnect: () => 1 },
    concatBytes: (chunks: readonly Uint8Array[]) => Buffer.concat(chunks),
    toUint8: (data: Uint8Array) => data,
  }]);
  const Socket = call(api, "clientClass", [Connection]);
  if (typeof Socket !== "function") throw new TypeError("Expected the client class");
  const socket: unknown = Reflect.construct(Socket, ["ws://127.0.0.1/"]);
  return socket;
}

async function queuedTrace(source: string) {
  const socket = client(source);
  const trace: unknown[] = [];
  const deferred = Promise.withResolvers<ArrayBuffer>();
  class PendingBlob extends Blob {
    arrayBuffer() { return deferred.promise; }
  }
  setField(socket, "_state", 1);
  setField(socket, "_peer", { sendFrame() { trace.push("old peer"); } });
  setField(socket, "_pendingBytes", 2);
  setField(socket, "_sendQueue", [
    { bytes: new PendingBlob(["a"]), size: 1, opcode: 2 },
    { bytes: new Uint8Array([98]), size: 1, opcode: 2 },
  ]);
  const flushing = call(socket, "_flushSends");
  setField(socket, "_peer", { sendFrame(opcode: number, bytes: Uint8Array) { trace.push([opcode, Array.from(bytes)]); } });
  deferred.resolve(new Uint8Array([97]).buffer);
  await flushing;
  trace.push(field(socket, "_pendingBytes"), field(socket, "_sending"));
  return trace;
}

test("WebSocket queue keeps byte order and reads the current peer after Blob await", async () => {
  const source = emittedSource();
  expect(await queuedTrace(source)).toEqual(await queuedTrace(originalStateSyntax(source)));
  expect(await queuedTrace(source)).toEqual([[2, [97]], [2, [98]], 0, false]);
});

test("WebSocket deferred callbacks read current connection and peer rather than cached state", () => {
  const timers: (() => void)[] = [];
  const socket = client(emittedSource(), timers);
  const connection = field(socket, "_conn");
  const trace: string[] = [];
  setField(socket, "_conn", { destroy() { trace.push("current connection"); } });
  call(connection, "onEnd");
  expect(trace).toEqual(["current connection"]);
  setField(socket, "_conn", undefined);
  expect(() => call(connection, "onEnd")).toThrow(TypeError);
  setField(socket, "_peer", { terminate() { trace.push("old peer"); } });
  call(socket, "_abort");
  setField(socket, "_peer", { terminate() { trace.push("current peer"); } });
  expect(timers).toHaveLength(1);
  timers[0]?.();
  expect(trace).toEqual(["current connection", "current peer"]);
});

test("WebSocket state checks reject missing peer and handshake input rather than dropping work", () => {
  const socket = client(emittedSource());
  setField(socket, "_state", 1);
  expect(() => call(socket, "send", [new Uint8Array([1])])).toThrow(TypeError);
  setField(socket, "_head", null);
  expect(() => call(socket, "_handshake", [new Uint8Array([1])])).toThrow(TypeError);
});

test("WebSocket state correction retains exactly the disclosed unresolved assertions", () => {
  const source = readFileSync(sourcePath, "utf8");
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const remaining: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) remaining.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  expect(remaining).toEqual([
    "err as { code?: number }",
    'handlers().error as NonNullable<BunWasm.WebSocketHandlers["error"]>',
    "err as { message?: string }",
  ]);
});
