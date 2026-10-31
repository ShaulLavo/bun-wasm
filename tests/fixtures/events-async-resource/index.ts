import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import EventEmitter, { EventEmitterAsyncResource } from "node:events";

const storage = new AsyncLocalStorage<string>();
const emitter = storage.run("creation", () => new EventEmitterAsyncResource({ name: "fixture" }));
assert.equal(require("node:events").EventEmitterAsyncResource, EventEmitterAsyncResource);
assert.equal(emitter instanceof EventEmitter, true);
assert.equal(emitter.asyncResource.eventEmitter, emitter);
assert.equal(emitter.asyncId, emitter.asyncResource.asyncId());
assert.equal(emitter.triggerAsyncId, emitter.asyncResource.triggerAsyncId());
let completion: Promise<void> | undefined;
emitter.on("event", function (this: unknown, value: number) {
  assert.equal(this, emitter);
  assert.equal(value, 42);
  assert.equal(storage.getStore(), "creation");
  completion = Promise.resolve().then(() => { assert.equal(storage.getStore(), "creation"); });
});
storage.run("caller", () => {
  assert.equal(emitter.emit("event", 42), true);
  assert.equal(storage.getStore(), "caller");
});
await completion;
assert.equal(storage.getStore(), undefined);
assert.equal(emitter.emit("missing"), false);
const sentinel = new Error("listener");
emitter.once("failure", () => { throw sentinel; });
assert.throws(() => emitter.emit("failure"), error => error === sentinel);
assert.equal(storage.getStore(), undefined);
class Derived extends EventEmitterAsyncResource {}
assert.equal(new Derived() instanceof EventEmitterAsyncResource, true);
assert.throws(() => new EventEmitterAsyncResource(), { code: "ERR_INVALID_ARG_TYPE" });
assert.equal(emitter.emitDestroy(), undefined);
console.log("async emitter context, identity, errors and restoration");
