import assert from "node:assert/strict";
import * as threads from "node:worker_threads";

const { MessageChannel, MessagePort, BroadcastChannel, receiveMessageOnPort,
  markAsUntransferable, isMarkedAsUntransferable, setEnvironmentData, getEnvironmentData } = threads;

assert.equal(threads.isMainThread, true);
assert.equal(threads.threadId, 0);
assert.equal(threads.parentPort, null);
assert.equal(threads.workerData, null);
assert.deepEqual(threads.resourceLimits, {});
assert.equal(threads.SHARE_ENV, Symbol.for("nodejs.worker_threads.SHARE_ENV"));
assert.equal(MessageChannel, globalThis.MessageChannel);
assert.equal(MessagePort, globalThis.MessagePort);
assert.equal(BroadcastChannel, globalThis.BroadcastChannel);
assert.throws(() => new MessagePort(), TypeError);
console.log("main thread exports");

const key = {};
const data = { nested: [1] };
setEnvironmentData(key, data);
assert.equal(getEnvironmentData(key), data);
assert.equal(getEnvironmentData({}), undefined);
setEnvironmentData(key, undefined);
assert.equal(getEnvironmentData(key), undefined);
console.log("environment data");

const channel = new MessageChannel();
assert.throws(() => channel.port1.postMessage(), { code: "ERR_MISSING_ARGS" });
assert.throws(() => channel.port1.postMessage(1, false), { code: "ERR_INVALID_ARG_TYPE" });
const cycle: Record<string, unknown> = { data: [1] };
cycle.self = cycle;
channel.port1.postMessage(cycle);
cycle.data = [2];
const received = receiveMessageOnPort(channel.port2)?.message;
assert.notEqual(received, cycle);
assert.equal(received.self, received);
assert.deepEqual(received.data, [1]);
channel.port1.postMessage(undefined);
assert.deepEqual(receiveMessageOnPort(channel.port2), { message: undefined });
assert.equal(receiveMessageOnPort(channel.port2), undefined);
assert.throws(() => receiveMessageOnPort({}), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => channel.port1.postMessage(() => {}), { name: "DataCloneError" });
console.log("synchronous receive and clone");

const buffer = new ArrayBuffer(4);
new Uint8Array(buffer)[0] = 42;
markAsUntransferable(buffer);
assert.equal(isMarkedAsUntransferable(buffer), true);
assert.equal(isMarkedAsUntransferable({}), false);
markAsUntransferable(1);
assert.equal(isMarkedAsUntransferable(1), false);
assert.throws(() => channel.port1.postMessage(buffer, [buffer]), { name: "DataCloneError" });
assert.throws(() => structuredClone(buffer, { transfer: [buffer] }), { name: "DataCloneError" });
assert.equal(buffer.byteLength, 4);
channel.port1.postMessage(buffer);
assert.equal(new Uint8Array(receiveMessageOnPort(channel.port2)?.message)[0], 42);
const transferable = new ArrayBuffer(3);
new Uint8Array(transferable)[0] = 17;
channel.port1.postMessage({ transferable }, [transferable]);
assert.equal(transferable.byteLength, 0);
assert.equal(new Uint8Array(receiveMessageOnPort(channel.port2)?.message.transferable)[0], 17);
console.log("transfer markers and array buffers");

async function messages() {
  const values: unknown[] = [];
  channel.port1.postMessage("first");
  channel.port1.postMessage("second");
  await new Promise<void>((resolve) => {
    channel.port2.once("message", function(value) {
      assert.equal(this, channel.port2);
      values.push(value);
    });
    channel.port2.on("message", (value) => {
      values.push(value);
      if (value === "second") resolve();
    });
  });
  assert.deepEqual(values, ["first", "first", "second"]);
  assert.equal(channel.port2.listenerCount("message"), 1);
  channel.port2.removeAllListeners("message");
  channel.port2.unref();
  assert.equal(channel.port2.hasRef(), false);
  channel.port2.ref();
  assert.equal(channel.port2.hasRef(), true);
  channel.port2.unref();
  assert.equal(channel.port2.hasRef(), false);
  console.log("queued events and ref state");

  channel.port1.postMessage("web");
  await new Promise<void>((resolve) => {
    channel.port2.onmessage = (event) => {
      assert.equal(event.data, "web");
      assert.equal(event.target, channel.port2);
      resolve();
    };
  });
  channel.port2.onmessage = null;
  channel.port1.postMessage(undefined);
  await new Promise<void>((resolve) => {
    channel.port2.addEventListener("message", (event) => {
      assert.equal(event.data, null);
      resolve();
    }, { once: true });
  });
  console.log("web message handler");

  const sender = new BroadcastChannel("test");
  const receiver = new BroadcastChannel("test");
  const isolated = new BroadcastChannel("other");
  assert.throws(() => receiveMessageOnPort(receiver), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => receiveMessageOnPort(sender), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => receiveMessageOnPort(isolated), { code: "ERR_INVALID_ARG_TYPE" });
  await new Promise<void>((resolve) => {
    receiver.onmessage = (event) => { assert.deepEqual(event.data, { value: 3 }); resolve(); };
    sender.postMessage({ value: 3 });
  });
  await new Promise<void>((resolve) => {
    receiver.onmessage = (event) => { assert.equal(event.data, 4); resolve(); };
    sender.postMessage(4);
  });
  receiver.close();
  sender.close();
  isolated.close();
  assert.throws(() => sender.postMessage(5), { name: "InvalidStateError" });
  console.log("broadcast channels");

  await new Promise<void>((resolve) => channel.port1.close(resolve));
  assert.equal(channel.port1.hasRef(), false);
  channel.port1.postMessage("closed");
  assert.equal(receiveMessageOnPort(channel.port2), undefined);
  const queuedClose = new MessageChannel();
  queuedClose.port1.postMessage(1);
  queuedClose.port1.close();
  assert.deepEqual(receiveMessageOnPort(queuedClose.port2), { message: 1 });
  const drainingClose = new MessageChannel();
  const drained: unknown[] = [];
  drainingClose.port2.on("message", (value) => drained.push(value));
  drainingClose.port1.postMessage(2);
  drainingClose.port1.postMessage(3);
  await new Promise<void>((resolve) => {
    drainingClose.port2.once("close", resolve);
    drainingClose.port1.close();
  });
  assert.deepEqual(drained, [2, 3]);
  const timerPort = new MessageChannel();
  timerPort.port1.ref();
  const started = performance.now();
  await new Promise<void>((resolve) => {
    setTimeout(() => { timerPort.port1.close(); resolve(); }, 1).unref();
  });
  assert.ok(performance.now() - started < 750, "a referenced port must not delay unref timers by the idle polling interval");
  console.log("close");
}
await messages();
