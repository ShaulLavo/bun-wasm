import assert from "node:assert/strict";
import type NativeEventEmitter from "node:events";

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function captureCases(EventEmitter: typeof NativeEventEmitter) {
  const emitter = new EventEmitter({ captureRejections: true });
  const failure = new Error("constructor");
  const failures: unknown[] = [];
  const calls: unknown[] = [];
  const monitored: unknown[] = [];
  emitter.on(EventEmitter.errorMonitor, error => monitored.push(error));
  emitter.on("error", error => failures.push(error));
  emitter.on("event", async function (this: NativeEventEmitter, value: unknown) { calls.push([this === emitter, value]); throw failure; });
  emitter.once("event", async () => { throw failure; });
  assert.equal(emitter.emit("event", 42), true);
  assert.deepEqual(failures.slice(), []);
  await turn();
  assert.deepEqual(failures.slice(), [failure, failure]);
  assert.deepEqual(monitored.slice(), [failure, failure]);
  assert.deepEqual(calls.slice(), [[true, 42]]);
  assert.equal(emitter.listenerCount("event"), 1);

  const custom = new EventEmitter({ captureRejections: true });
  const name = Symbol("event");
  const payload = { value: 42 };
  custom[EventEmitter.captureRejectionSymbol] = function (error, event, ...args) {
    calls.push([this === custom, error, event, args]);
  };
  custom.on("error", () => assert.fail("custom handler must replace error emission"));
  custom.prependOnceListener(name, async () => { throw failure; });
  custom.emit(name, payload, "tail");
  await turn();
  assert.deepEqual(calls[1], [true, failure, name, [payload, "tail"]]);
  assert.equal(custom.listenerCount(name), 0);
  console.log("constructor, listeners, once and custom rejection arguments");

  const original = EventEmitter.captureRejections;
  const staticFailures: unknown[] = [];
  let untouched = 0;
  try {
    EventEmitter.captureRejections = false;
    const before = new EventEmitter();
    EventEmitter.captureRejections = true;
    const enabled = new EventEmitter();
    const inherited = new EventEmitter({ captureRejections: false });
    EventEmitter.captureRejections = false;
    const after = new EventEmitter({ captureRejections: false });
    for (const target of [enabled, inherited]) {
      target.on("error", error => staticFailures.push(error));
      target.on("event", async () => { throw failure; });
      target.emit("event");
    }
    for (const target of [before, after]) {
      target.on("event", () => ({ get then() { untouched++; throw failure; } }));
      target.emit("event");
      target.on("sync", () => { throw failure; });
      assert.throws(() => target.emit("sync"), error => error === failure);
    }
    await turn();
    assert.deepEqual(staticFailures.slice(), [failure, failure]);
    assert.equal(untouched, 0);
  } finally {
    EventEmitter.captureRejections = original;
  }
  console.log("static default snapshots and disabled capture");

  let thenCalls = 0;
  emitter.on("error", () => ({ then() { thenCalls++; } }));
  emitter.emit("event", "again");
  await turn();
  assert.equal(thenCalls, 0);
  emitter.removeAllListeners("error");
  emitter.on("error", error => failures.push(error));
  emitter.emit("event", "restored");
  await turn();
  assert.equal(failures.length, 4);

  const sync = new Error("synchronous");
  let later = false;
  emitter.on("sync", () => { throw sync; });
  emitter.on("sync", () => { later = true; });
  assert.throws(() => emitter.emit("sync"), error => error === sync);
  assert.equal(later, false);
  assert.equal(emitter.emit("absent"), false);
  console.log("synchronous throws and capture suppression during error delivery");
}

export async function thenableCases(EventEmitter: typeof NativeEventEmitter) {
  const emitter = new EventEmitter({ captureRejections: true });
  const failure = new Error("thenable");
  const seen: unknown[] = [];
  let reads = 0;
  let thenReceiver: unknown;
  const result = {
    get then() {
      reads++;
      return function (this: unknown, fulfilled: unknown, rejected: (error: unknown) => void) {
        thenReceiver = this;
        assert.equal(fulfilled, undefined);
        rejected(failure);
      };
    },
  };
  emitter.on("error", error => seen.push(error));
  emitter.on("event", () => result);
  emitter.emit("event");
  assert.equal(reads, 1);
  assert.equal(thenReceiver, result);
  assert.deepEqual(seen.slice(), []);
  await turn();
  assert.deepEqual(seen.slice(), [failure]);

  const getterError = new Error("then getter");
  const callError = new Error("then call");
  emitter.on("getter", () => ({ get then() { throw getterError; } }));
  emitter.on("call", () => ({ then() { throw callError; } }));
  emitter.emit("getter");
  emitter.emit("call");
  assert.deepEqual(seen.slice(), [failure, getterError, callError]);
  emitter.on("plain", () => null).on("plain", () => undefined).on("plain", () => 42);
  emitter.on("plain", () => ({ then: 42 })).on("plain", () => Promise.resolve("fulfilled"));
  emitter.emit("plain");
  await turn();
  assert.equal(seen.length, 3);
  console.log("thenable receiver, single getter read, deferred rejection and throwing then");
}
