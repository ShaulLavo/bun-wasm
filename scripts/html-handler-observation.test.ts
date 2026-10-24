import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { runInNewContext } from "node:vm";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-html-observation-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const destination = join(scratch, "html_rewriter.js");
const emission = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
  new URL("../crates/bunwasm-runtime/src/js/html_rewriter.ts", import.meta.url).pathname, destination]);
if (emission.exitCode !== 0) throw new Error(emission.stderr.toString());
const emitted = `globalThis.HTMLRewriter = (${readFileSync(destination, "utf8")})(internal).HTMLRewriter`;
const empty = new Uint8Array();

type Session = { bytes: Uint8Array };
type Rewriter = { on(selector: string, handlers: object): Rewriter; transform(input: Response): Response };
type RewriterConstructor = new () => Rewriter;
const browserPromiseHasInstance: (value: unknown) => boolean = Function.prototype.call.bind(Function.prototype[Symbol.hasInstance], Promise);
function adapter(isPromise: (value: unknown) => boolean = browserPromiseHasInstance) {
  const sessions = new Map<number, Session>();
  let next = 0;
  let closes = 0;
  let resumes = 0;
  const native = {
    htmlValidateSelector() {},
    htmlCreate() { const id = ++next; sessions.set(id, { bytes: empty }); return id; },
    htmlClose(id: number) { closes++; sessions.delete(id); },
    htmlStep(id: number, action: string, bytes: Uint8Array) {
      const session = sessions.get(id);
      if (!session) throw new Error("HTML session already closed");
      if (action === "write") {
        session.bytes = bytes;
        return { output: empty, event: { handler: 0, kind: "element" } };
      }
      if (action === "resume") resumes++;
      return { output: action === "resume" ? session.bytes : empty };
    },
  };
  const initial: RewriterConstructor = HTMLRewriter;
  const context = {
    HTMLRewriter: initial, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    Response, Headers, ReadableStream, Promise, FinalizationRegistry, Error, TypeError,
    internal: { native, isPromise,
      web: { Response: { _setUrl() {} } } },
  };
  runInNewContext(emitted, context);
  const rewrite = (value: unknown) => new context.HTMLRewriter().on("p", { element: () => value }).transform(new Response("<p>x</p>"));
  return { rewrite, sessions, HTMLRewriter: context.HTMLRewriter, closes: () => closes, resumes: () => resumes };
}

test("the browser Promise hook adds no prototype query before calling a custom then", async () => {
  const state = adapter();
  const failure = { marker: "unexpected second getPrototypeOf" };
  let prototypes = 0;
  let reads = 0;
  const receivers: unknown[] = [];
  const value = new Proxy({ get then() {
    reads++;
    return function (this: unknown, resolve: () => void) { receivers.push(this); resolve(); };
  } }, {
    getPrototypeOf() {
      prototypes++;
      if (prototypes > 1) throw failure;
      return null;
    },
  });
  const result = await state.rewrite(value).text().then(text => ({ text }), error => ({ error }));
  expect(result).toEqual({ text: "<p>x</p>" });
  expect(prototypes).toBe(1);
  expect(reads).toBe(1);
  expect(receivers).toEqual([value]);
  expect(state.sessions.size).toBe(0);
  expect(state.closes()).toBe(1);
});

test("the browser Promise hook preserves the intrinsic receiver error for a non-Promise with intrinsic then", async () => {
  const state = adapter();
  const failure = { marker: "unexpected second getPrototypeOf" };
  let prototypes = 0;
  let reads = 0;
  const value = new Proxy({ get then() { reads++; return Promise.prototype.then; } }, {
    getPrototypeOf() {
      prototypes++;
      if (prototypes > 1) throw failure;
      return null;
    },
  });
  const error = await state.rewrite(value).text().then(() => undefined, error => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toBe(failure);
  expect(prototypes).toBe(1);
  expect(reads).toBe(1);
  expect(state.sessions.size).toBe(0);
  expect(state.closes()).toBe(1);
});

test("a genuine brand hook control also observes a custom thenable prototype only once", async () => {
  const state = adapter(types.isPromise);
  let prototypes = 0;
  const value = new Proxy({ then(resolve: () => void) { resolve(); } }, {
    getPrototypeOf() { prototypes++; return null; },
  });
  expect(await state.rewrite(value).text()).toBe("<p>x</p>");
  expect(prototypes).toBe(1);
  expect(state.closes()).toBe(1);
});

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
  const receivers: unknown[] = [];
  Object.defineProperty(value, "then", { value: function (this: unknown) { receivers.push(this); throw failure; } });
  await expect(rewrite(value).text()).rejects.toBe(failure);
  expect(receivers).toEqual([value]);
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
  const cases = [await cancelRewrite(false), await cancelRewrite(true)];
  await collected(() => cases.every(item => item.input.deref() === undefined));
  for (const item of cases) item.pending.resolve();
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
  return { pending, input: new WeakRef(stream), response, reader };
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

async function neverSettles() { await new Promise<void>(() => {}); }
function parkedHandler(outcome: { error?: unknown; pending?: WeakRef<object> }) {
  return { element() {
    const pending = neverSettles();
    outcome.pending = new WeakRef(pending);
    return pending;
  } };
}
function parkedRewrite(Rewriter: RewriterConstructor) {
  const outcome: { error?: unknown; pending?: WeakRef<object> } = {};
  const response = new Rewriter().on("p", parkedHandler(outcome)).transform(new Response("<p>x</p>"));
  const reader = response.body!.getReader();
  void reader.read().catch(error => { outcome.error = error; });
  return { reader, outcome };
}

test("the adapter closes abandoned sessions while output readers remain reachable", async () => {
  const { HTMLRewriter: Rewriter, sessions } = adapter();
  const parked = Array.from({ length: 8 }, () => parkedRewrite(Rewriter));
  await collected(() => sessions.size === 0);
  expect(sessions.size).toBe(0);
  expect(parked.every(item => item.outcome.pending?.deref() === undefined)).toBe(true);
  expect(parked.every(item => String(item.outcome.error).includes("will never settle"))).toBe(true);
  for (const item of parked) await expect(item.reader.read()).rejects.toBe(item.outcome.error);
});

async function collected(check: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    Bun.gc(true);
    await new Promise(resolve => setTimeout(resolve, 1));
    if (check()) return;
  }
  expect(check()).toBe(true);
}
