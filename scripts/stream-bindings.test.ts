import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-stream-bindings-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function emit(name: string): string {
  const source = join(root, "crates/bunwasm-runtime/src/js", `${name}.ts`);
  const output = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", "--no-warnings", join(root, "scripts/transpile-runtime.ts"), source, output], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

test("actual stream factories accept real Node exports and nullish call shapes", () => {
  const directory = join(root, "crates/bunwasm-runtime/src/js");
  const bindings = readFileSync(join(directory, "node_stream_bindings.ts"), "utf8")
    .replace("(function (internal:", "const bindingsFactory = (function (internal:");
  const internals = readFileSync(join(directory, "node_stream_internals.ts"), "utf8")
    .replace("(function (internal:", "const internalsFactory = (function (internal:");
  const probe = join(scratch, "type-probe.ts");
  writeFileSync(probe, `${bindings}\n${internals}\n
import { Readable, Writable, Duplex, finished } from "node:stream";
import { promisify } from "node:util";
declare const bindingsInternal: Parameters<typeof bindingsFactory>[0];
const eos = Object.assign(finished, { kEosNodeSynchronousCallback: Symbol("sync") });
const bundle = {
  Stream: { Readable, Writable, Duplex },
  errors: { codes: { ERR_INVALID_ARG_TYPE: TypeError } },
  validators: { validateBoolean(value: unknown) { return typeof value === "boolean"; } },
  utils: { isDestroyed(node: { destroyed: boolean }) { return node.destroyed; } },
  eos,
  util: { normalizeEncoding: (value: string) => value },
};
const bindings = bindingsFactory(bindingsInternal).create(bundle);
const callback = (error: Error | null | undefined) => { void error; };
bindings.observeTerminalWritable(new Writable());
const wrapped = bindings.withDestroyHook(new Writable(), { destroy: null }, callback);
wrapped(null);
wrapped(undefined);
wrapped();
bindings.withDestroyHook(new Readable({ read() {} }), {}, callback);
bindings.withDestroyHook(new Writable(), { destroy(error, done) { done(error); } }, callback);
bindings.PromisePrototypeThen(Promise.resolve("text"), value => value.length, null);
bindings.PromisePrototypeThen(Promise.resolve("text"), null, undefined);
bindings.PromisePrototypeThen(Promise.resolve("text"), value => value.length);
bindings.PromisePrototypeThen(Promise.resolve("text"));
bindings.PromisePrototypeThen(Promise.resolve("text"), null, (error: Error) => error.message);
bindings.SafePromisePrototypeFinally(Promise.resolve(1), null);
bindings.SafePromisePrototypeFinally(Promise.resolve(1), undefined);
bindings.SafePromisePrototypeFinally(Promise.resolve(1));
promisify(bindings.eos);
bindings.eos(new Writable(), () => undefined);
const ReadableConstructor: typeof Readable = bindings.Readable;
const ErrorConstructor: typeof TypeError = bindings.ERR_INVALID_ARG_TYPE;
const encoding: string = bindings.normalizeEncoding("utf8");
bindings.validateBoolean(true);
bindings.isDestroyed(new Writable());
const resolvers = bindings.PromiseWithResolvers<string>();
resolvers.resolve("done");
resolvers.resolve(Promise.resolve("done"));
resolvers.reject(null);
bindings.SafePromiseAllReturnVoid(new Set([1, 2]), value => value.toString());
bindings.ArrayPrototypeFilter([1, 2], value => value > 1);
bindings.isReadableStream(null);
bindings.isWritableStream(undefined);
bindings.TypedArrayPrototypeGetBuffer(new Uint8Array());
void ReadableConstructor;
void ErrorConstructor;
void encoding;

declare const internalsInternal: Parameters<typeof internalsFactory>[0];
const internals = internalsFactory(internalsInternal);
const adapters = internals.modules["internal/webstreams/adapters"];
type AdapterStream = Parameters<typeof adapters.newReadableStreamFromStreamReadable>[0];
declare const stream: AdapterStream;
adapters.newReadableStreamFromStreamReadable(stream);
adapters.newReadableStreamFromStreamReadable(stream, undefined);
adapters.newReadableStreamFromStreamReadable(stream, null);
internals.modules["internal/webstreams/util"].isPromisePending(Promise.resolve());
const state: unknown = internals.getWebStreamState(stream);
declare const nativeStream: ReadableStream;
internals.getWebStreamState(nativeStream);
adapters.newReadableStreamFromStreamReadable(nativeStream);
void state;
`);
  const config = join(scratch, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
    compilerOptions: { types: ["node"], typeRoots: [join(root, "node_modules/@types")], skipLibCheck: true },
    include: [],
    files: [join(directory, "runtime.d.ts"), probe],
  }));
  const result = Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("stream internals preserve state lookup and adapter forwarding", () => {
  const calls: { stream: unknown; options?: unknown }[] = [];
  const adapt = (stream: unknown, options?: unknown) => { calls.push({ stream, options }); return { stream, options }; };
  const nodeStream = Object.fromEntries(["Readable", "Writable", "Duplex"].map(name => [name, { toWeb: adapt, fromWeb: adapt }]));
  class Readable {}
  class Writable {}
  const factory = runInNewContext(emit("node_stream_internals"));
  const internals = factory({
    require: () => ({ ReadableStream: Readable, WritableStream: Writable }),
    builtin: () => nodeStream,
    native: { promiseState: () => "pending" },
  });
  const own = { _state: "readable", _storedError: null };
  expect(internals.getWebStreamState(own)).toEqual({ state: "readable", storedError: null });
  const state = { state: "writable", storedError: undefined };
  const keyed = { [Symbol("kState")]: state };
  expect(internals.getWebStreamState(keyed)).toBe(state);
  expect(internals.getWebStreamState({})).toBeUndefined();
  const adapters = internals.modules["internal/webstreams/adapters"];
  const stream = new Readable();
  expect(adapters.newReadableStreamFromStreamReadable(stream, null)).toEqual({ stream, options: null });
  adapters.newStreamDuplexFromReadableWritablePair(stream);
  expect(calls).toEqual([{ stream, options: null }, { stream, options: undefined }]);
  expect(internals.modules["internal/webstreams/util"].isPromisePending(Promise.resolve())).toBe(true);
  expect(Object.keys(internals.modules)).toEqual(["internal/webstreams/adapters", "internal/webstreams/util"]);
});

function portableConstructor() {
  class Portable {
    get locked() {
      if (!(this instanceof Portable)) throw new TypeError("Invalid receiver");
      return false;
    }
  }
  return Portable;
}

test("stream bindings preserve portable state, brands, and promise helpers", async () => {
  const Readable = portableConstructor();
  const Writable = portableConstructor();
  const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
  for (const Ctor of [Readable, Writable]) Object.defineProperty(Ctor.prototype, closedKey, { get() { return Promise.resolve(); } });
  const eos = Object.assign(() => {}, { kEosNodeSynchronousCallback: Symbol("sync") });
  const bundle = { Stream: {}, errors: { codes: {} }, validators: {}, utils: {}, eos, util: { normalizeEncoding: (value: string) => value } };
  const factory = runInNewContext(emit("node_stream_bindings"), { process, TextEncoder });
  const bindings = factory({
    require: (name: string) => name === "streams" ? { ReadableStream: Readable, WritableStream: Writable } : { Buffer },
    builtin: (name: string) => name === "node:zlib" ? { constants: { Z_OK: 0 } } : { isAnyArrayBuffer: (value: unknown) => value instanceof ArrayBuffer },
    native: { engine: "quickjs" },
  }).create(bundle);
  const readable = new Readable();
  Reflect.set(readable, "_state", "readable");
  expect(Reflect.get(readable, Symbol.for("nodejs.stream.readable"))).toBe(true);
  expect(bindings.isReadableStream(readable)).toBe(true);
  expect(bindings.isReadableStream(null)).toBe(false);
  expect(bindings.isWritableStream(undefined)).toBe(false);
  expect(bindings.TypedArrayPrototypeGetByteLength(Uint8Array.of(1, 2))).toBe(2);
  expect(bindings.ArrayPrototypeFilter([1, 2, 3], (value: number) => value > 1)).toEqual([2, 3]);
  expect(await bindings.PromisePrototypeThen(Promise.resolve("ok"), null, undefined)).toBe("ok");
  expect(await bindings.SafePromisePrototypeFinally(Promise.resolve("done"), null)).toBe("done");
  const resolvers = bindings.PromiseWithResolvers();
  resolvers.resolve("resolved");
  expect(await resolvers.promise).toBe("resolved");
  expect(await bindings.SafePromiseAllReturnVoid(new Set([1, 2]), (value: number) => value.toString())).toBeUndefined();
});

test("destroy hooks and terminal writable cleanup keep their callback behavior", () => {
  const Readable = portableConstructor();
  const Writable = portableConstructor();
  const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
  for (const Ctor of [Readable, Writable]) Object.defineProperty(Ctor.prototype, closedKey, { value: true });
  const eos = Object.assign(() => {}, { kEosNodeSynchronousCallback: Symbol("sync") });
  const bundle = { Stream: {}, errors: { codes: {} }, validators: {}, utils: {}, eos, util: { normalizeEncoding: String } };
  const factory = runInNewContext(emit("node_stream_bindings"), { process, TextEncoder });
  const bindings = factory({
    require: (name: string) => name === "streams" ? { ReadableStream: Readable, WritableStream: Writable } : { Buffer },
    builtin: () => ({ constants: {}, isAnyArrayBuffer: () => false }),
    native: { engine: "quickjs" },
  }).create(bundle);
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const node = {
    _writableState: { autoDestroy: false },
    destroyed: false,
    writableEnded: true,
    writableFinished: false,
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
      return this;
    },
    once(event: string, listener: (...args: never[]) => void) { return this.on(event, listener); },
    removeListener(event: string, listener: (...args: never[]) => void) { listeners.get(event)?.delete(listener); },
  };
  const seen: unknown[] = [];
  const callback = (error?: unknown) => { seen.push(error); };
  const passthrough = bindings.withDestroyHook(node, { destroy: null }, callback);
  expect(passthrough).toBe(callback);
  const hooked = bindings.withDestroyHook(node, { destroy(error: unknown, done: (error?: unknown) => void) {
    seen.push(this === node, error);
    done(error);
  } }, callback);
  hooked(null);
  expect(seen).toEqual([true, null, null]);
  const failure = { reason: "thrown" };
  bindings.withDestroyHook(node, { destroy() { throw failure; } }, callback)(undefined);
  expect(seen.at(-1)).toBe(failure);
  bindings.observeTerminalWritable(node);
  expect(Array.from(listeners.values(), entries => entries.size)).toEqual([1, 1, 1]);
  for (const listener of listeners.get("finish") ?? []) listener();
  expect(Array.from(listeners.values(), entries => entries.size)).toEqual([0, 0, 0]);
});
