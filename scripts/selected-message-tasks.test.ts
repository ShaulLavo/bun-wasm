import { expect, test } from "bun:test";
import { bootstrapTimers } from "./fixtures/bootstrap-timer-runtime";
import { sourcePorts } from "./fixtures/shared-objects/source-runtime";

function finish(runtime: ReturnType<typeof bootstrapTimers>["runtime"]) {
  for (let turn = 0; turn < 64; turn++) if (runtime.runTimers() === -1) return;
  throw new Error("timer queue did not become idle");
}

test("production deque keeps front and tail order across a large backlog and drained reuse", () => {
  const Queue = bootstrapTimers().runtime.require("immediate_queue");
  const queue = new Queue<number>();
  for (let value = 0; value < 10_000; value++) queue.push(value);
  queue.pushFront(-1); queue.pushFront(-2);
  expect(queue.shift()).toBe(-2); expect(queue.shift()).toBe(-1);
  for (let value = 0; value < 10_000; value++) if (queue.shift() !== value) throw new Error("Deque reordered backlog");
  expect(queue.length).toBe(0); expect(queue.shift()).toBeUndefined();
  queue.pushFront(1); queue.push(2);
  expect(queue.shift()).toBe(1); expect(queue.shift()).toBe(2); expect(queue.length).toBe(0);
});

test("ordinary immediate batch keeps appended work behind an already due timeout", () => {
  const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [];
  runtime.realTimers.setImmediate(() => { order.push("A"); runtime.realTimers.setImmediate(() => order.push("C")); });
  runtime.realTimers.setImmediate(() => order.push("B"));
  runtime.realTimers.setTimeout(() => order.push("due"), 1);
  clock.now(1);
  finish(runtime);
  expect(order).toEqual(["A", "B", "due", "C"]);
  expect(runtime.loopState().immediates).toBe(0);
});

for (const quota of ["null", "positive", "zero"]) {
  test(`selected recovery reserves exactly one task at ${quota} quota`, () => {
    const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [];
    if (quota !== "null") runtime.realTimers.setImmediate(() => order.push("first"));
    if (quota !== "zero") runtime.realTimers.setImmediate(() => order.push("gate"));
    runtime.realTimers.setTimeout(() => order.push("due"), 1);
    clock.now(1);
    if (quota !== "null") runtime.runTimers();
    if (quota === "zero") runtime.realTimers.setImmediate(() => order.push("gate"));
    let owed = true;
    runtime.workerPump = () => {
      if (!owed) return false;
      runtime.realTimers.queueSelectedTask(() => { owed = false; order.push("selected"); });
      return true;
    };
    finish(runtime);
    expect(order).toEqual(quota === "null" ? ["selected", "gate", "due"] : quota === "zero" ? ["first", "selected", "due", "gate"] : ["first", "selected", "gate", "due"]);
    expect(runtime.loopState().immediates).toBe(0);
  });
}

for (const quota of ["null", "positive", "zero"]) {
  test(`cancelled selected and ordinary entries preserve ${quota} quota`, () => {
    const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [];
    if (quota !== "null") runtime.realTimers.setImmediate(() => order.push("first"));
    if (quota !== "zero") cancelOrdinary(runtime, order);
    if (quota !== "zero") runtime.realTimers.setImmediate(() => order.push("gate"));
    runtime.realTimers.setTimeout(() => order.push("due"), 1);
    clock.now(1);
    if (quota !== "null") runtime.runTimers();
    if (quota === "zero") {
      cancelOrdinary(runtime, order);
      runtime.realTimers.setImmediate(() => order.push("gate"));
    }
    const selected = runtime.realTimers.queueSelectedTask(() => order.push("cancelled selected"));
    runtime.realTimers.clearImmediate(selected);
    finish(runtime);
    expect(order).toEqual(quota === "null" ? ["gate", "due"] : quota === "positive" ? ["first", "gate", "due"] : ["first", "due", "gate"]);
    expect(runtime.loopState().immediates).toBe(0);
  });
}
function cancelOrdinary(runtime: ReturnType<typeof bootstrapTimers>["runtime"], order: string[]) {
  const cancelled = runtime.realTimers.setImmediate(() => order.push("cancelled ordinary"));
  runtime.realTimers.clearImmediate(cancelled);
}

for (const quota of ["null", "positive", "zero"]) {
  test(`failed selected publication cannot admit ordinary work into ${quota} quota`, () => {
    const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [];
    if (quota !== "null") runtime.realTimers.setImmediate(() => order.push("first"));
    if (quota !== "zero") runtime.realTimers.setImmediate(() => order.push("gate"));
    runtime.realTimers.setTimeout(() => order.push("due"), 1);
    clock.now(1);
    if (quota !== "null") runtime.runTimers();
    if (quota === "zero") runtime.realTimers.setImmediate(() => order.push("gate"));
    const failure = new Error("wake");
    clock.wakeFault(() => { throw failure; });
    let thrown: unknown;
    try { runtime.realTimers.queueSelectedTask(() => order.push("unreachable")); } catch (error) { thrown = error; }
    clock.wakeFault();
    expect(thrown).toBe(failure);
    finish(runtime);
    expect(order).toEqual(quota === "null" ? ["gate", "due"] : quota === "zero" ? ["first", "due", "gate"] : ["first", "gate", "due"]);
    expect(runtime.loopState().immediates).toBe(0);
  });
}

for (const publication of ["before", "after", "wake"]) {
  test(`repeated selected failure ${publication} publication cannot starve gate or due timer`, () => {
    const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [], errors: unknown[] = [];
    const failure = new Error(publication);
    runtime.realTimers.setImmediate(() => order.push("first"));
    runtime.realTimers.setImmediate(() => order.push("gate"));
    runtime.realTimers.setTimeout(() => order.push("due"), 1);
    clock.now(1); runtime.runTimers();
    const Queue = runtime.require("immediate_queue");
    const descriptor = Object.getOwnPropertyDescriptor(Queue.prototype, "pushFront");
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== "function") throw new Error("Missing queue publication method");
    const refusePublication = function (this: unknown, value: unknown) {
      if (publication === "after") Reflect.apply(original, this, [value]);
      throw failure;
    };
    if (publication === "wake") clock.wakeFault(() => { throw failure; });
    else Object.defineProperty(Queue.prototype, "pushFront", { ...descriptor, value: refusePublication });
    let owed = true;
    const deliver = () => { owed = false; order.push("selected"); };
    runtime.workerPump = () => {
      if (!owed) return false;
      try { runtime.realTimers.queueSelectedTask(deliver); }
      catch (error) { errors.push(error); }
      return true;
    };
    try {
      for (let turn = 0; turn < 8; turn++) runtime.runTimers();
      expect(order).toEqual(["first", "gate", "due"]);
      expect(errors.length).toBe(8);
      for (const error of errors) expect(error).toBe(failure);
    } finally { Object.defineProperty(Queue.prototype, "pushFront", descriptor); clock.wakeFault(); }
    finish(runtime);
    expect(order).toEqual(["first", "gate", "due", "selected"]);
    expect(runtime.loopState().immediates).toBe(0);
  });
}

test("selected Immediate preserves context, receiver, empty arguments and cancellation methods", () => {
  const clock = bootstrapTimers(), runtime = clock.runtime;
  const captured = {}, current = {}, failure = new Error("callback");
  let receiverMatches = false, args = -1, seen: unknown;
  clock.context(captured);
  const selected = runtime.realTimers.queueSelectedTask(function (this: unknown) {
    receiverMatches = this === selected; args = arguments.length; seen = clock.currentContext(); throw failure;
  });
  expect(receiverMatches).toBe(false);
  clock.context(current);
  let thrown: unknown;
  try { runtime.runTimers(); } catch (error) { thrown = error; }
  expect(thrown).toBe(failure); expect(receiverMatches).toBe(true); expect(args).toBe(0);
  expect(seen).toBe(captured); expect(clock.currentContext()).toBe(current);
  expect(selected !== null && typeof selected === "object").toBe(true);
  if (selected === null || typeof selected !== "object") throw new Error("Expected Immediate");
  const hasRef = Reflect.get(selected, "hasRef"), unref = Reflect.get(selected, "unref"), ref = Reflect.get(selected, "ref");
  expect(Reflect.apply(hasRef, selected, [])).toBe(true);
  expect(Reflect.apply(unref, selected, [])).toBe(selected);
  expect(Reflect.apply(hasRef, selected, [])).toBe(false);
  expect(Reflect.apply(ref, selected, [])).toBe(selected);
  expect(Reflect.apply(hasRef, selected, [])).toBe(true);
  finish(runtime);
});

test("ordinary wake refusal leaves ordinary work active while selected retry captures its new context", () => {
  const clock = bootstrapTimers(), runtime = clock.runtime, order: string[] = [];
  const failure = new Error("wake"), originalContext = {}, retryContext = {};
  clock.wakeFault(() => { throw failure; });
  let ordinaryError: unknown, selectedError: unknown;
  try { runtime.realTimers.setImmediate(() => order.push("ordinary")); } catch (error) { ordinaryError = error; }
  clock.context(originalContext);
  try { runtime.realTimers.queueSelectedTask(() => order.push("cancelled")); } catch (error) { selectedError = error; }
  expect(ordinaryError).toBe(failure); expect(selectedError).toBe(failure);
  clock.wakeFault(); clock.context(retryContext);
  let owed = true, seen: unknown;
  const deliver = () => { owed = false; seen = clock.currentContext(); order.push("retry"); };
  runtime.workerPump = () => {
    if (!owed) return false;
    runtime.realTimers.queueSelectedTask(deliver);
    return true;
  };
  finish(runtime);
  expect(order).toEqual(["retry", "ordinary"]);
  expect(seen).toBe(retryContext); expect(clock.currentContext()).toBe(retryContext);
});

async function channelOrder(syncReceive: boolean, appendFromPromise: boolean) {
  const runtime = sourcePorts({ realLoop: true });
  const { port1, port2 } = new runtime.MessageChannel();
  const sender = new runtime.BroadcastChannel("selected-order"), gate = new runtime.BroadcastChannel("selected-order");
  const order: string[] = [];
  let gateDone: () => void = () => {};
  const gated = new Promise<void>(resolve => { gateDone = resolve; });
  const postNew = () => port1.postMessage("new");
  Reflect.apply(EventTarget.prototype.addEventListener, gate, ["message", () => { order.push("gate"); gateDone(); }]);
  port2.on("message", value => {
    order.push(String(value));
    if (value !== 0) return;
    if (syncReceive) order.push(`sync:${runtime.receiveMessageOnPort(port2)?.message}`);
    if (appendFromPromise) Promise.resolve().then(postNew);
    else postNew();
  });
  try {
    port1.postMessage(0); port1.postMessage(1); port1.postMessage(2); sender.postMessage("continue");
    await gated;
    for (let turn = 0; turn < 8; turn++) { runtime.pumpIo(); await loopTurn(); }
    expect(order).toEqual(syncReceive ? ["0", "sync:1", "2", "gate", "new"] : ["0", "1", "2", "gate", "new"]);
  } finally { sender.close(); gate.close(); port1.close(); port2.close(); runtime.__fixtureShutdown(); }
}
const loopTurn = () => new Promise<void>(resolve => setImmediate(resolve));
for (const syncReceive of [false, true]) {
  for (const promise of [false, true]) {
    test(`selected port batch precedes broadcast and bounds new work (sync ${syncReceive}, promise ${promise})`, () => channelOrder(syncReceive, promise), 30_000);
  }
}

test("started handlerless delivery drops the selected batch before the broadcast gate", async () => {
  const runtime = sourcePorts({ realLoop: true });
  const { port1, port2 } = new runtime.MessageChannel();
  const sender = new runtime.BroadcastChannel("drop-gate"), gate = new runtime.BroadcastChannel("drop-gate");
  const order: string[] = [];
  let installed = false, release: () => void = () => {};
  const gated = new Promise<void>(resolve => { release = resolve; });
  Reflect.apply(EventTarget.prototype.addEventListener, gate, ["message", () => { installed = true; order.push("gate"); release(); }]);
  port2.on("message", value => order.push(`${String(value)}:${installed ? "handled" : "dropped"}`));
  try {
    port1.postMessage(0); port1.postMessage(1); port1.postMessage(2); sender.postMessage("continue");
    await gated;
    expect(order).toEqual(["0:dropped", "1:dropped", "2:dropped", "gate"]);
  } finally {
    sender.close(); gate.close(); port1.close(); port2.close();
    await settleSourceTasks(runtime);
    runtime.__fixtureShutdown();
  }
}, 30_000);

async function settleSourceTasks(runtime: ReturnType<typeof sourcePorts>) {
  for (let step = 0; step < 64 && runtime.pendingImmediateCallbacks(); step++) { runtime.pumpIo(); await loopTurn(); }
  expect(runtime.pendingImmediateCallbacks()).toBe(0);
  expect(runtime.queuedImmediateTasks()).toBe(0);
  expect(runtime.internal.messagePortRefs.size).toBe(0);
  expect(runtime.__fixtureOwners()).toEqual([]);
}

async function consumeDeep(wait: (port: ReturnType<typeof sourcePorts>["parentPort"], name: string) => Promise<unknown[]>, port: ReturnType<typeof sourcePorts>["parentPort"], depth: number, received: unknown[]) {
  for (let index = 0; index < 3; index++) {
    received.push((await wait(port, "message"))[0]);
    for (let hop = 0; hop < depth; hop++) await Promise.resolve();
  }
}
for (const depth of [0, 1, 17, 64]) {
  test(`selected deliveries wait for complete async once Promise depth ${depth}`, async () => {
    const runtime = sourcePorts({ realLoop: true });
    const { port1, port2 } = new runtime.MessageChannel();
    const source = await Bun.file(new URL("../crates/bunwasm-runtime/src/js/events.ts", import.meta.url)).text();
    const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.eventsFactory = ${source}`);
    const { runInNewContext } = await import("node:vm");
    const events = runInNewContext(emitted)({});
    const received: unknown[] = [];
    try {
      port1.postMessage(1); port1.postMessage(2); port1.postMessage(3);
      await consumeDeep(events.once, port2, depth, received);
      expect(received).toEqual([1, 2, 3]);
    } finally { port1.close(); port2.close(); await settleSourceTasks(runtime); runtime.__fixtureShutdown(); }
  }, 30_000);
}
