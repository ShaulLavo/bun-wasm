import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/html_rewriter.ts", import.meta.url), "utf8");
const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.HTMLRewriter = (${source})(internal).HTMLRewriter`);
const empty = new Uint8Array();

type Session = { bytes: Uint8Array };
function adapter() {
  const sessions = new Map<number, Session>();
  let next = 0;
  const native = {
    htmlValidateSelector() {},
    htmlCreate() { const id = ++next; sessions.set(id, { bytes: empty }); return id; },
    htmlClose(id: number) { sessions.delete(id); },
    htmlStep(id: number, action: string, bytes: Uint8Array) {
      const session = sessions.get(id);
      if (!session) throw new Error("HTML session already closed");
      if (action === "write") {
        session.bytes = bytes;
        return { output: empty, event: { handler: 0, kind: "element" } };
      }
      return { output: action === "resume" ? session.bytes : empty };
    },
  };
  const context = {
    HTMLRewriter, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    Response, Headers, ReadableStream, Promise, FinalizationRegistry, Error, TypeError,
    internal: { native, isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: () => void, rejected: (error: unknown) => void) => Promise.prototype.then.call(value, fulfilled, rejected),
      web: { Response: { _setUrl() {} } } },
  };
  runInNewContext(emitted, context);
  const rewrite = (value: unknown) => new context.HTMLRewriter().on("p", { element: () => value }).transform(new Response("<p>x</p>"));
  return { rewrite, sessions, HTMLRewriter: context.HTMLRewriter };
}

test("a returned native Promise reads its then getter once and preserves thrown identity", async () => {
  const { rewrite, sessions } = adapter();
  const failure = { marker: "then getter" };
  let reads = 0;
  const value = Promise.resolve();
  Object.defineProperty(value, "then", { get() { reads++; throw failure; } });
  await expect(rewrite(value).text()).rejects.toBe(failure);
  expect(reads).toBe(1);
  expect(sessions.size).toBe(0);
});

test("a returned native Promise calls an overridden then with its original receiver", async () => {
  const { rewrite, sessions } = adapter();
  const failure = { marker: "then call" };
  const value = Promise.resolve();
  let receiver: unknown;
  Object.defineProperty(value, "then", { value: function (this: unknown) { receiver = this; throw failure; } });
  await expect(rewrite(value).text()).rejects.toBe(failure);
  expect(receiver).toBe(value);
  expect(sessions.size).toBe(0);
});

test("a native Promise with non-callable then does not park the rewrite", async () => {
  const { rewrite, sessions } = adapter();
  const value = new Promise<void>(() => {});
  Object.defineProperty(value, "then", { value: null });
  const response = rewrite(value);
  const reader = response.body!.getReader();
  const result = await Promise.race([reader.read().then(chunk => ({ kind: "read", chunk })), new Promise(resolve => setTimeout(resolve, 10)).then(() => ({ kind: "waiting" }))]);
  await reader.cancel();
  expect(result.kind).toBe("read");
  expect(sessions.size).toBe(0);
});

test("thenable fulfillment values are ignored and rejection values pass through", async () => {
  const { rewrite, sessions } = adapter();
  const ignored = { get then() { throw new Error("fulfillment value was assimilated"); } };
  const failure = { marker: "thenable rejection" };
  expect(await rewrite({ then(resolve: (value: unknown) => void) { resolve(ignored); } }).text()).toBe("<p>x</p>");
  await expect(rewrite({ then(_resolve: () => void, reject: (error: unknown) => void) { reject(failure); } }).text()).rejects.toBe(failure);
  expect(sessions.size).toBe(0);
});

test("native Promise fulfillment and rejection preserve the adapter contract", async () => {
  const { rewrite, sessions } = adapter();
  const ignored = new Error("returned fulfillment values are ignored");
  const failure = { marker: "native rejection" };
  expect(await rewrite(Promise.resolve(ignored)).text()).toBe("<p>x</p>");
  await expect(rewrite(Promise.reject(failure)).text()).rejects.toBe(failure);
  expect(sessions.size).toBe(0);
});

test("reader cancellation inside and outside a handler closes once before settlement", async () => {
  for (const inside of [false, true]) await cancelRewrite(inside);
});

async function cancelRewrite(inside: boolean) {
  const { HTMLRewriter: Rewriter, sessions } = adapter();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const input = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const reason = { marker: "cancel" };
  const reasons: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({ start: input.resolve, cancel(value) { reasons.push(value); } });
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let cancellation: Promise<void> | undefined;
  const response = new Rewriter().on("p", { element() {
    if (inside) cancellation = reader.cancel(reason);
    entered.resolve();
    return pending.promise;
  } }).transform(new Response(stream));
  reader = response.body!.getReader();
  const read = reader.read();
  (await input.promise).enqueue(new TextEncoder().encode("<p>x</p>"));
  await entered.promise;
  if (!inside) cancellation = reader.cancel(reason);
  await cancellation;
  expect((await read).done).toBe(true);
  expect(sessions.size).toBe(0);
  expect(reasons).toEqual([reason]);
  pending.resolve();
}

test("a native Promise constructor getter keeps its original error identity", async () => {
  const { rewrite, sessions } = adapter();
  const failure = { marker: "constructor getter" };
  let reads = 0;
  const value = Promise.resolve();
  Object.defineProperty(value, "constructor", { get() { reads++; throw failure; } });
  await expect(rewrite(value).text()).rejects.toBe(failure);
  expect(reads).toBe(1);
  expect(sessions.size).toBe(0);
});
