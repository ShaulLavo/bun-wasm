import assert from "node:assert/strict";
import EventEmitter from "node:events";

function withHook<T>(hook: string, run: () => T): T {
  const target = hook === "iterator" ? Array.prototype : Array;
  const key = hook === "iterator" ? Symbol.iterator : Symbol.species;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) throw new Error("missing array intrinsic");
  Object.defineProperty(target, key, {
    configurable: true,
    get() { throw new Error("unexpected array hook"); },
  });
  try { return run(); }
  finally { Object.defineProperty(target, key, descriptor); }
}

const monitored = new EventEmitter();
const calls: unknown[] = [];
monitored.on(EventEmitter.errorMonitor, value => calls.push(["monitor", value]));
monitored.on("error", value => calls.push(["error", value]));
withHook("iterator", () => monitored.emit("error", 42));
assert.deepEqual(calls, [["monitor", 42], ["error", 42]]);
console.log("error monitor retains delivery without array iteration");

for (const hook of ["iterator", "species"]) {
  const emitter = new EventEmitter();
  const pending = EventEmitter.on(emitter, "value");
  const first = pending.next();
  withHook(hook, () => emitter.emit("value", 42));
  assert.deepEqual(await first, { value: [42], done: false });
  await pending.return();
  const queued = EventEmitter.on(emitter, "value", { close: ["close"] });
  emitter.emit("value", 43);
  const result = withHook(hook, () => queued.next());
  assert.ok(result instanceof Promise);
  assert.deepEqual(await result, { value: [43], done: false });
  emitter.emit("close");
  assert.deepEqual(await withHook(hook, () => queued.next()), { value: undefined, done: true });
  await queued.return();
  assert.deepEqual(emitter.eventNames(), []);
  console.log(`${hook} hooks do not intercept pending events or queued next`);
}

const controller = new AbortController();
let count = 0;
const disposable = EventEmitter.addAbortListener(controller.signal, () => { count++; });
const keys = Reflect.ownKeys(disposable);
assert.equal(keys.length, 1);
const key = keys[0];
assert.equal(typeof key, "symbol");
assert.throws(() => disposable[Symbol("never")](), TypeError);
assert.equal(typeof disposable[key], "function");
disposable[key]();
controller.abort();
assert.equal(count, 0);
const already = EventEmitter.addAbortListener(controller.signal, () => { count++; });
already[Reflect.ownKeys(already)[0]]();
await Promise.resolve();
assert.equal(count, 1);
console.log("sparse disposal key, detach and already-aborted microtask");
