import assert from "node:assert/strict";
import NativeEventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { captureCases, thenableCases } from "../../tests/fixtures/events-capture-rejections/cases.ts";

const mode = process.argv[2];
async function createEvents(nextTick: (callback: () => void) => void = process.nextTick): Promise<typeof NativeEventEmitter> {
  if (mode === "native") return NativeEventEmitter;
  assert.equal(mode, "factory");
  const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/events.ts", import.meta.url), "utf8");
  const { stripTypeScriptTypes } = await import("node:module");
  return runInNewContext(stripTypeScriptTypes(source))({ nextTick });
}

const EventEmitter = await createEvents();
await captureCases(EventEmitter);
// Native Bun currently checks real promises only. Node and the guest accept thenables.
if (mode === "factory" || !process.versions.bun) await thenableCases(EventEmitter);

const expected = new Set<unknown>();
const unhandled: unknown[] = [];
const original = EventEmitter.captureRejections;
const observe = (error: unknown) => {
  assert.ok(expected.has(error), "unexpected unhandled rejection");
  unhandled.push(error);
};
const baseline = process.listenerCount("unhandledRejection");
process.on("unhandledRejection", observe);
try {
  EventEmitter.captureRejections = false;
  const disabled = new EventEmitter({ captureRejections: false });
  const failure = new Error("disabled");
  expected.add(failure);
  disabled.on("error", () => assert.fail("capture is disabled"));
  disabled.on("event", async () => { throw failure; });
  disabled.emit("event");

  const enabled = new EventEmitter({ captureRejections: true });
  const handlerFailure = new Error("error handler");
  const listenerFailure = new Error("listener");
  expected.add(handlerFailure);
  let errorCalls = 0;
  enabled.on("error", async error => {
    errorCalls++;
    assert.equal(error, listenerFailure);
    throw handlerFailure;
  });
  enabled.on("event", async () => { throw listenerFailure; });
  enabled.emit("event");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, [failure, handlerFailure]);
  assert.equal(errorCalls, 1);
  console.log("disabled rejection and rejected error handler reach the bounded observer once");
} finally {
  EventEmitter.captureRejections = original;
  process.off("unhandledRejection", observe);
}
assert.equal(process.listenerCount("unhandledRejection"), baseline);
console.log("observer teardown restored its original listener count");

if (mode === "factory") {
  const ticks: (() => void)[] = [];
  const ControlledEvents = await createEvents(callback => { ticks.push(callback); });
  const emitter = new ControlledEvents({ captureRejections: true });
  const failure = new Error("dispatch failure");
  emitter.on("event", () => ({ then(_fulfilled: unknown, reject: (error: unknown) => void) { reject(failure); } }));
  emitter.on("error", () => { throw failure; });
  emitter.emit("event");
  const tick = ticks.shift();
  assert.ok(tick);
  assert.throws(tick, error => error === failure);
  const recovered: unknown[] = [];
  emitter.removeAllListeners("error").on("error", error => recovered.push(error));
  emitter.emit("event");
  const next = ticks.shift();
  assert.ok(next);
  next();
  assert.deepEqual(recovered, [failure]);
  assert.equal(ticks.length, 0);
  console.log("throwing error delivery escapes the scheduled callback and restores capture");
}
