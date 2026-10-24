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

function originalSyntax(text: string) {
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

test("WebSocket syntax differs only by checked dispatch, not other runtime operations", () => {
  expect(originalSyntax(emittedSource())).toBe(originalHash);
});

test("WebSocket syntax proof rejects a wrong handler or reordered failure", () => {
  const emitted = emittedSource();
  expect(() => originalSyntax(emitted.replace('current.pong?.(socket, invocation[1])', 'current.ping?.(socket, invocation[1])'))).toThrow();
  expect(originalSyntax(emitted.replace('this._state = 3;', 'this._state = 2;'))).not.toBe(originalHash);
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
  // The pinned inverse proves this source is the original JS except for the dispatch implementation.
  const emitted = emittedSource();
  expect(originalSyntax(emitted)).toBe(originalHash);
  const original = emitted.replace(/const callHandler = [\s\S]*?(?=    const invokeError)/, originalInvoke + "\n");
  const expected = await dispatchTrace(original);
  expect(await dispatchTrace(emitted)).toEqual(expected);
  expect(expected).toContainEqual(["message", true, "x"]);
  expect(expected).toContainEqual(["error", true, true]);
  expect(before).toContain("const unhandled: never = invocation");
});
