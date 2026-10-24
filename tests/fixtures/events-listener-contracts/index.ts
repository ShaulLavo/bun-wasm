import assert from "node:assert/strict";
import EventEmitter, { errorMonitor, once, on, addAbortListener } from "node:events";

const emitter = new EventEmitter();
const symbol = Symbol("event");
const calls: string[] = [];
function regular(this: EventEmitter, value: number) {
  assert.equal(this, emitter);
  calls.push(`regular:${value}`);
}
function single(this: EventEmitter, value: number) {
  assert.equal(this, emitter);
  calls.push(`single:${value}`);
}
emitter.on(symbol, regular).prependOnceListener(symbol, single);
const raw = emitter.rawListeners(symbol);
assert.equal(raw[0].listener, single);
assert.equal(raw[1], regular);
assert.deepEqual(emitter.listeners(symbol), [single, regular]);
assert.equal(emitter.listenerCount(symbol, single), 1);
assert.deepEqual(emitter.eventNames(), [symbol]);
emitter.emit(symbol, 1);
emitter.emit(symbol, 2);
assert.deepEqual(calls, ["single:1", "regular:1", "regular:2"]);
assert.equal(emitter.listenerCount(symbol, single), 0);
assert.equal(emitter.listeners(symbol)[0], regular);
emitter.once(symbol, single).off(symbol, single);
assert.equal(emitter.listenerCount(symbol), 1);
console.log("once, prepend, receiver, symbols and listener identity");

const mutation = new EventEmitter();
const order: string[] = [];
function later() { order.push("later"); }
mutation.on("event", () => { order.push("first"); mutation.off("event", later); });
mutation.on("event", later);
mutation.emit("event");
assert.deepEqual(order, ["first", "later"]);
const removals: unknown[] = [];
mutation.on("removeListener", (name, listener) => removals.push([name, listener]));
mutation.on("other", regular).once("other", single);
mutation.removeAllListeners("other");
assert.deepEqual(removals, [["other", single], ["other", regular]]);
assert.equal(mutation.emit("absent"), false);
console.log("emit snapshot and remove-all LIFO identity");

const failure = new Error("sentinel");
const observed: unknown[] = [];
emitter.on(errorMonitor, error => observed.push(error));
assert.throws(() => emitter.emit("error", failure), error => error === failure);
assert.deepEqual(observed, [failure]);
const context = { detail: 7 };
assert.throws(() => emitter.emit("error", context), error => {
  assert.equal(error.code, "ERR_UNHANDLED_ERROR");
  assert.equal(error.context, context);
  return true;
});
assert.throws(() => emitter.on("invalid", null), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => emitter.setMaxListeners(-1), { code: "ERR_OUT_OF_RANGE" });
console.log("error monitor, error identity and validation");

const warned = new EventEmitter().setMaxListeners(1);
const warnings: unknown[] = [];
const emitWarning = process.emitWarning;
process.emitWarning = warning => { warnings.push(warning); };
try {
  warned.on("leak", regular).on("leak", single).on("leak", () => {});
  assert.equal(warnings.length, 1);
  const warning = warnings[0];
  assert.equal(warning.name, "MaxListenersExceededWarning");
  assert.equal(warning.emitter, warned);
  assert.equal(warning.type, "leak");
  assert.equal(warning.count, 2);
} finally {
  process.emitWarning = emitWarning;
}
console.log("one leak warning with emitter, event and count");

const pending = once(emitter, "ready");
emitter.emit("ready", 42, "ok");
assert.deepEqual(await pending, [42, "ok"]);
const controller = new AbortController();
let aborted = 0;
const disposable = addAbortListener(controller.signal, () => { aborted++; });
controller.abort("reason");
assert.equal(aborted, 1);
disposable[Symbol.dispose]();
const iterator = on(emitter, "item", { close: ["done"] });
emitter.emit("item", "queued");
emitter.emit("done");
assert.deepEqual(await iterator.next(), { value: ["queued"], done: false });
assert.deepEqual(await iterator.next(), { value: undefined, done: true });
assert.equal(emitter.listenerCount("item"), 0);
console.log("promise once, abort listener and queued iterator close");

const waitingEmitter = new EventEmitter();
const waiting = on(waitingEmitter, "item", { close: ["done"] });
const firstWaiting = waiting.next();
const secondWaiting = waiting.next();
waitingEmitter.emit("item", 1, 2);
waitingEmitter.emit("done");
assert.deepEqual(await firstWaiting, { value: [1, 2], done: false });
const closed = await secondWaiting;
assert.equal(closed.value, undefined);
assert.equal(closed.done, true);
assert.deepEqual(await waiting.next(), { value: undefined, done: true });
const failedEmitter = new EventEmitter();
const failed = on(failedEmitter, "item");
const rejected = failed.next();
const ended = failed.next();
failedEmitter.emit("error", failure);
await assert.rejects(rejected, error => error === failure);
assert.deepEqual(await ended, { value: undefined, done: true });
assert.deepEqual(failedEmitter.eventNames(), []);
const queuedError = on(failedEmitter, "item");
failedEmitter.emit("item", "before error");
failedEmitter.emit("error", failure);
assert.deepEqual(await queuedError.next(), { value: ["before error"], done: false });
await assert.rejects(queuedError.next(), error => error === failure);
assert.deepEqual(await queuedError.next(), { value: undefined, done: true });
console.log("FIFO pending, queued, close and error iterator settlement");
