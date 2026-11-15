import assert from "node:assert/strict";
import EventEmitter, { getMaxListeners, listenerCount, on, once, setMaxListeners } from "node:events";

function invalidArgument(error: unknown) {
  return error instanceof TypeError && Reflect.get(error, "code") === "ERR_INVALID_ARG_TYPE";
}

async function rejectedOptions() {
  assert.equal(once.constructor.name, "AsyncFunction");
  const emitter = new EventEmitter();
  for (const options of [null, false, 42, "options"]) {
    const promise = Reflect.apply(once, undefined, [emitter, "value", options]);
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, invalidArgument);
  }
  for (const signal of [null, false, 42, "signal", {}]) {
    const promise = Reflect.apply(once, undefined, [emitter, "value", { signal }]);
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, invalidArgument);
  }
  const sentinel = new Error("signal getter");
  const options = Object.defineProperty({}, "signal", { get() { throw sentinel; } });
  await assert.rejects(Reflect.apply(once, undefined, [emitter, "value", options]), error => error === sentinel);
  assert.deepEqual(emitter.eventNames(), []);
  console.log("once rejects invalid options and preserves getter errors asynchronously");
}

async function onceCleanup() {
  const emitter = new EventEmitter();
  const controller = new AbortController();
  const success = once(emitter, "value", { signal: controller.signal });
  emitter.emit("value", 1, 2);
  controller.abort("late");
  assert.deepEqual(await success, [1, 2]);
  assert.deepEqual(emitter.eventNames(), []);
  const failure = once(emitter, "value");
  const sentinel = new Error("emitted error");
  emitter.emit("error", sentinel);
  await assert.rejects(failure, error => error === sentinel);
  assert.deepEqual(emitter.eventNames(), []);
  const aborted = new AbortController();
  const pending = once(emitter, "value", { signal: aborted.signal });
  aborted.abort(sentinel);
  await assert.rejects(pending, { name: "AbortError", code: "ABORT_ERR", cause: sentinel });
  assert.deepEqual(emitter.eventNames(), []);
  console.log("once settles exactly once and removes event, error and abort listeners");
}

async function firstParameter() {
  const emitter = new EventEmitter();
  const options = { [Symbol.for("nodejs.kFirstEventParam")]: true };
  const iterator = Reflect.apply(on, undefined, [emitter, "value", options]);
  emitter.emit("value", 1, 2);
  const array = [3, 4];
  emitter.emit("value", array);
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  assert.equal((await iterator.next()).value, array);
  await iterator.return();
  const ordinary = on(emitter, "value");
  emitter.emit("value", array, 5);
  assert.deepEqual((await ordinary.next()).value, [array, 5]);
  await ordinary.return?.();
  assert.deepEqual(emitter.eventNames(), []);
  console.log("iterator first-parameter mode preserves values and normal mode preserves argument arrays");
}

async function watermarks() {
  const calls: string[] = [];
  const emitter = Object.assign(new EventEmitter(), {
    pause() { calls.push("pause"); },
    resume() { calls.push("resume"); },
  });
  const iterator = on(emitter, "value", { highWaterMark: 2, lowWaterMark: 2, close: ["close"] });
  emitter.emit("value", 0);
  emitter.emit("value", 1);
  assert.deepEqual(calls, []);
  emitter.emit("value", 2);
  emitter.emit("value", 3);
  assert.deepEqual(calls, ["pause"]);
  assert.deepEqual((await iterator.next()).value, [0]);
  assert.deepEqual((await iterator.next()).value, [1]);
  assert.deepEqual(calls, ["pause"]);
  assert.deepEqual((await iterator.next()).value, [2]);
  assert.deepEqual(calls, ["pause", "resume"]);
  emitter.emit("value", 4);
  emitter.emit("value", 5);
  assert.deepEqual(calls, ["pause", "resume", "pause"]);
  emitter.emit("close");
  emitter.emit("value", "ignored");
  const values = [];
  for await (const value of iterator) values.push(value);
  assert.deepEqual(values, [[3], [4], [5]]);
  assert.deepEqual(calls, ["pause", "resume", "pause"]);
  assert.deepEqual(emitter.eventNames(), []);
  console.log("iterator pauses above high, resumes below low and drains close without resuming");
}

function invalidWatermarks() {
  const emitter = new EventEmitter();
  for (const name of ["highWaterMark", "lowWaterMark"]) {
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => Reflect.apply(on, undefined, [emitter, "value", { [name]: value }]), { code: "ERR_OUT_OF_RANGE" });
    }
    assert.throws(() => Reflect.apply(on, undefined, [emitter, "value", { [name]: "2" }]), invalidArgument);
  }
  assert.deepEqual(emitter.eventNames(), []);
  console.log("invalid watermarks reject before registering listeners");
}

function getterErrors() {
  const sentinel = new Error("events getter");
  const receiver = Object.defineProperty({}, "_events", { get() { throw sentinel; } });
  const prototype = Object.getPrototypeOf(process);
  for (const method of ["once", "eventNames", "getMaxListeners"]) {
    assert.throws(() => Reflect.apply(prototype[method], receiver, ["value", () => {}]), error => error === sentinel);
  }
  console.log("borrowed native methods preserve the original events getter exception");
}

function listenerLimits() {
  const emitter = new EventEmitter();
  const target = new EventTarget();
  setMaxListeners(3, emitter, target);
  assert.equal(getMaxListeners(emitter), 3);
  assert.equal(getMaxListeners(target), 3);
  setMaxListeners(0, target);
  assert.equal(getMaxListeners(target), 0);
  for (const value of [null, undefined, {}, 42, Object.create(null)]) {
    assert.throws(() => Reflect.apply(getMaxListeners, undefined, [value]), invalidArgument);
    assert.throws(() => Reflect.apply(listenerCount, undefined, [value, "value"]), invalidArgument);
    assert.throws(() => Reflect.apply(setMaxListeners, undefined, [1, value]), invalidArgument);
  }
  console.log("listener limits support EventTarget and static helpers reject invalid targets");
}

await rejectedOptions();
await onceCleanup();
await firstParameter();
await watermarks();
invalidWatermarks();
getterErrors();
listenerLimits();
