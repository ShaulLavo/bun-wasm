import assert from "node:assert/strict";
import EventEmitter from "node:events";

assert.equal(EventEmitter.EventEmitter, EventEmitter);
assert.equal(EventEmitter.name, "EventEmitter");
assert.equal(EventEmitter.length, 1);
assert.equal(EventEmitter.prototype.constructor, EventEmitter);
assert.equal(EventEmitter.prototype._events, undefined);
assert.equal(EventEmitter.prototype._eventsCount, 0);
assert.throws(() => EventEmitter.prototype._events.never, TypeError);
const first = new EventEmitter();
const second = new EventEmitter({ captureRejections: false });
assert.equal(Object.getPrototypeOf(first), EventEmitter.prototype);
assert.equal(Object.getPrototypeOf(first._events), null);
assert.notEqual(first._events, second._events);
assert.equal(first._eventsCount, 0);
const receiver = {};
assert.equal(EventEmitter.call(receiver), undefined);
assert.equal(Object.getPrototypeOf(receiver._events), null);
assert.equal(receiver._eventsCount, 0);
assert.equal(Reflect.apply(EventEmitter, receiver, []), undefined);
assert.throws(() => Reflect.apply(EventEmitter, undefined, []), TypeError);
assert.throws(() => new EventEmitter({ captureRejections: "invalid" }), { code: "ERR_INVALID_ARG_TYPE" });
class Derived extends EventEmitter {}
const derived = new Derived();
assert.equal(Object.getPrototypeOf(derived), Derived.prototype);
assert.ok(derived instanceof EventEmitter);
assert.notEqual(derived._events, first._events);
console.log("call, new, subclass, absent prototype storage and fresh instance storage");

for (const name of ["defaultMaxListeners", "captureRejections"]) {
  const descriptor = Object.getOwnPropertyDescriptor(EventEmitter, name);
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, false);
  assert.equal(typeof descriptor.get, "function");
  assert.equal(typeof descriptor.set, "function");
}
assert.equal(EventEmitter.prototype.removeAllListeners.length, 1);
const originalLimit = EventEmitter.defaultMaxListeners;
const originalCapture = EventEmitter.captureRejections;
try {
  EventEmitter.defaultMaxListeners = 7;
  assert.equal(first.getMaxListeners(), 7);
  EventEmitter.captureRejections = true;
  assert.equal(EventEmitter.captureRejections, true);
  assert.throws(() => { EventEmitter.defaultMaxListeners = -1; }, { code: "ERR_OUT_OF_RANGE" });
  assert.throws(() => { EventEmitter.captureRejections = "invalid"; }, { code: "ERR_INVALID_ARG_TYPE" });
} finally {
  EventEmitter.defaultMaxListeners = originalLimit;
  EventEmitter.captureRejections = originalCapture;
}
assert.equal(EventEmitter.prototype.on, EventEmitter.prototype.addListener);
assert.equal(EventEmitter.prototype.off, EventEmitter.prototype.removeListener);
console.log("static accessors, validation, function arity and prototype aliases");

const emitter = new EventEmitter();
function listener() {}
emitter.once("value", listener);
const wrapper = emitter.rawListeners("value")[0];
assert.equal(wrapper.length, 0);
assert.equal(wrapper.listener, listener);
assert.equal(Object.getOwnPropertyDescriptor(wrapper, "listener").enumerable, true);
const removals: unknown[] = [];
emitter.on("removeListener", (name, removed) => removals.push([name, removed]));
emitter.on("undefined", listener).on("keep", listener);
emitter.removeAllListeners(undefined);
assert.deepEqual(removals, [[undefined, listener]]);
assert.equal(emitter.listenerCount("keep"), 1);
emitter.removeAllListeners();
assert.deepEqual(emitter.eventNames(), []);
console.log("bound once descriptor and omitted versus explicit undefined removal");
