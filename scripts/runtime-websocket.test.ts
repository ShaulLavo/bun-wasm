import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";
import { runtimeSyntax } from "./runtime-syntax";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-websocket-controls-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const boundaryEvidence: Record<string, unknown> = {};
afterAll(() => {
  const destination = process.env.BUN_WASM_WEBSOCKET_EVIDENCE;
  if (destination && Object.keys(boundaryEvidence).length) writeFileSync(destination, JSON.stringify(boundaryEvidence, null, 2) + "\n");
});

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

function client(source: string, timers?: (() => void)[], observeRealm?: (realm: unknown) => void) {
  const realm: unknown = runInNewContext(`({ factory: ${source}, numberPrototype: Number.prototype })`, {
    TextEncoder, TextDecoder, EventTarget, Event, URL, Headers, Blob, crypto, TypeError, clearTimeout,
    setTimeout: timers ? (callback: () => void) => { timers.push(callback); return 0; } : setTimeout,
    MessageEvent: SyntheticEvent, ErrorEvent: SyntheticEvent, CloseEvent: SyntheticEvent,
  });
  observeRealm?.(realm);
  const factory = field(realm, "factory");
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

type BoundaryOutcome = { kind: "returned" } | { kind: "thrown"; value: unknown };
function boundaryOutcome(action: () => unknown): BoundaryOutcome {
  try { action(); return { kind: "returned" }; }
  catch (value) { return { kind: "thrown", value }; }
}

function handlerBoundary(source: string, first: () => unknown, second: () => unknown) {
  const trace: unknown[] = [];
  const connection = new Connection();
  const failure = new Error("callback input");
  const providers = [
    { get error() { trace.push("first.error"); return first(); } },
    { get error() { trace.push("second.error"); return second(); } },
  ];
  let reads = 0;
  const active = server(source, connection, () => { trace.push("provider"); return providers[Math.min(reads++, 1)] ?? {}; });
  call(active, "activate", [new Uint8Array()]);
  trace.length = 0;
  reads = 0;
  const result = boundaryOutcome(() => call(connection, "onError", [failure]));
  return { trace, result, secondProvider: providers[1], failure };
}

test("WebSocket boundary error callback preserves both lookups, second receiver and getter failures", () => {
  const source = emittedSource();
  const calls: { receiver: unknown; input: unknown }[] = [];
  function callback(this: unknown, _socket: unknown, error: unknown) { calls.push({ receiver: this, input: error }); }
  Object.defineProperty(callback, "call", { get() { throw new Error("must not read callback.call"); } });
  const called = handlerBoundary(source, () => callback, () => callback);
  expect(called.trace).toEqual(["provider", "first.error", "provider", "second.error"]);
  expect(called.result.kind).toBe("returned");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.receiver).toBe(called.secondProvider);
  expect(calls[0]?.input).toBe(called.failure);
  const sentinel = new Error("second error getter threw");
  const failed = handlerBoundary(source, () => callback, () => { throw sentinel; });
  expect(failed.trace).toEqual(called.trace);
  expect(failed.result).toEqual({ kind: "thrown", value: sentinel });
  expect(thrownValue(failed.result)).toBe(sentinel);
  const absent = handlerBoundary(source, () => callback, () => undefined);
  expect(absent.trace).toEqual(called.trace);
  expect(absent.result.kind).toBe("thrown");
  if (absent.result.kind !== "thrown") throw new Error("Expected the original missing-handler failure");
  expect(field(absent.result.value, "name")).toBe("TypeError");
  boundaryEvidence.handler = { reads: absent.trace, missingSecond: { name: field(absent.result.value, "name"), message: field(absent.result.value, "message") }, getterThrowPreserved: failed.result.kind === "thrown" && failed.result.value === sentinel };
});

function thrownValue(outcome: BoundaryOutcome): unknown {
  if (outcome.kind !== "thrown") throw new Error("Expected a thrown value");
  return outcome.value;
}

function frameFailure(source: string, failure: unknown) {
  const writes: number[][] = [];
  const trace: string[] = [];
  class FailureConnection extends Connection {
    write(bytes: Uint8Array) { writes.push(Array.from(bytes)); trace.push("write"); }
    end() { trace.push("end"); }
  }
  const connection = new FailureConnection();
  const active = server(source, connection, () => ({ message() { throw failure; } }));
  const result = boundaryOutcome(() => call(active, "activate", [new Uint8Array([0x81, 0x81, 0, 0, 0, 0, 120])]));
  return { trace, writes, result };
}

test("WebSocket boundary caught code retains truthy strings and repeated coercions", () => {
  const source = emittedSource();
  const stringCode = frameFailure(source, { code: "1005" });
  expect(stringCode.result.kind).toBe("returned");
  expect(stringCode.writes).toEqual([[0x88, 2, 3, 237]]);
  const trace: string[] = [];
  const code = { valueOf() { trace.push("coerce"); return 1009; } };
  const objectCode = frameFailure(source, { get code() { trace.push("get code"); return code; } });
  expect(objectCode.result.kind).toBe("returned");
  expect(objectCode.writes).toEqual([[0x88, 2, 3, 241]]);
  expect(trace).toEqual(["get code", "coerce", "coerce", "coerce", "coerce"]);
  boundaryEvidence.code = { string1005: stringCode, object1009: { trace, writes: objectCode.writes, result: objectCode.result.kind } };
});

test("WebSocket boundary caught code propagates nullish and getter errors without writing", () => {
  const source = emittedSource();
  const sentinel = new Error("code getter threw");
  const getter = frameFailure(source, { get code() { throw sentinel; } });
  expect(getter.result).toEqual({ kind: "thrown", value: sentinel });
  expect(thrownValue(getter.result)).toBe(sentinel);
  expect(getter.writes).toEqual([]);
  expect(getter.trace).toEqual([]);
  const nullish: unknown[] = [null, undefined];
  for (const failure of nullish) {
    const observed = frameFailure(source, failure);
    expect(observed.result.kind).toBe("thrown");
    expect(field(thrownValue(observed.result), "name")).toBe("TypeError");
    expect(observed.trace).toEqual([]);
    expect(observed.writes).toEqual([]);
  }
  for (const failure of [0, false, "primitive", 1n, Symbol("primitive")]) {
    const observed = frameFailure(source, failure);
    expect(observed.result.kind).toBe("returned");
    expect(observed.writes).toEqual([[0x88, 2, 3, 234]]);
  }
  boundaryEvidence.codeFailures = { nullishThrowBeforeWrites: true, exactGetterErrorPreserved: true, primitivesWithoutCode: 1002 };
});

function clientFailure(source: string, makeError: (trace: unknown[], socket: unknown) => unknown, observeRealm?: (realm: unknown) => void) {
  const socket = client(source, undefined, observeRealm);
  const trace: unknown[] = [];
  const events: unknown[] = [];
  setField(socket, "_conn", { destroy() { trace.push(["destroy", field(socket, "_state")]); } });
  setField(socket, "dispatchEvent", (event: unknown) => { events.push(event); trace.push(["event", field(event, "type")]); return true; });
  const error = makeError(trace, socket);
  const result = boundaryOutcome(() => call(socket, "_fail", [error]));
  return { trace, events, result, error, socket };
}

test("WebSocket boundary caught message reads after closed state and destroy without normalization", () => {
  const source = emittedSource();
  const rawMessage = { custom: "truthy non-string message" };
  const object = clientFailure(source, (trace, socket) => ({ get message() { trace.push(["get message", field(socket, "_state")]); return rawMessage; } }));
  expect(object.result.kind).toBe("returned");
  expect(object.trace).toEqual([["destroy", 3], ["get message", 3], ["event", "error"], ["event", "close"]]);
  expect(field(object.events[0], "message")).toBe(rawMessage);
  expect(field(object.events[0], "error")).toBe(object.error);
  const sentinel = new Error("message getter threw");
  const getter = clientFailure(source, trace => ({ get message() { trace.push("get message"); throw sentinel; } }));
  expect(getter.result).toEqual({ kind: "thrown", value: sentinel });
  expect(thrownValue(getter.result)).toBe(sentinel);
  expect(getter.trace).toEqual([["destroy", 3], "get message"]);
  expect(getter.events).toEqual([]);
  for (const failure of [null, undefined]) {
    const observed = clientFailure(source, () => failure);
    expect(observed.result.kind).toBe("thrown");
    expect(field(thrownValue(observed.result), "name")).toBe("TypeError");
    expect(observed.trace).toEqual([["destroy", 3]]);
    expect(observed.events).toEqual([]);
  }
  boundaryEvidence.message = { rawValueForwarded: true, trace: object.trace, getterThrowTrace: getter.trace, nullish: "closed/destroy then TypeError; no events" };
});

test("WebSocket boundary primitive message getter keeps its original primitive receiver", () => {
  const source = emittedSource();
  const receivers: unknown[] = [];
  const sentinel = new Error("primitive getter threw");
  const observed = clientFailure(source, () => 7, realm => {
    const prototype = field(realm, "numberPrototype");
    if (prototype === null || typeof prototype !== "object") throw new TypeError("Expected the VM number prototype");
    Object.defineProperty(prototype, "message", { get(this: unknown) { receivers.push(this); throw sentinel; } });
  });
  expect(receivers).toEqual([7]);
  expect(observed.trace).toEqual([["destroy", 3]]);
  expect(observed.result).toEqual({ kind: "thrown", value: sentinel });
  expect(thrownValue(observed.result)).toBe(sentinel);
  expect(observed.events).toEqual([]);
  boundaryEvidence.primitiveMessage = { receivers, trace: observed.trace, exactGetterErrorPreserved: observed.result.kind === "thrown" && observed.result.value === sentinel };
});
