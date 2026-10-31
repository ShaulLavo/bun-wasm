import { afterEach, expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import { bindSharedObjectHost } from "../web/src/shared-objects/host";
import { sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";
import { createSharedMailbox } from "../web/src/shared-objects/mailbox";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

const cleanup: (() => void)[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 8));
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) close(); await tick(); });
type Packet = Parameters<Parameters<typeof createSharedObjects>[1]["postMessage"]>[0];
function setup(observe: (packet: Packet) => void = () => {}) {
  const broker = createSharedObjectBroker();
  cleanup.push(broker.dispose);
  function client() {
    const lease = broker.register(), channel = new MessageChannel();
    lease.attach(channel.port2);
    const service = createSharedObjects(lease.id, {
      postMessage(packet) { observe(packet); channel.port1.postMessage(packet); },
      start: () => channel.port1.start(), close: () => channel.port1.close(),
      addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
    });
    // Without channel lanes: this covers the broker route that lanes fall back to.
    const sharedObjects = bindSharedObjectHost({ ...service, lanes: undefined }, { active: () => true, pending() {}, wake() {} });
    const runtime = sourcePorts({ sharedObjects });
    cleanup.push(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
    return { service, sharedObjects, runtime };
  }
  return { broker, client };
}
function own(port: SourcePort) { cleanup.push(() => port.close()); return port; }
function restore(value: unknown, runtime: ReturnType<typeof sourcePorts>) {
  if (!(value instanceof runtime.MessagePort)) throw new Error("Missing actual restored port");
  return own(value);
}
function connection(env: ReturnType<typeof setup>) {
  const sender = env.client(), receiver = env.client(), channel = new sender.runtime.MessageChannel();
  own(channel.port1);
  const target = restore(receiver.runtime.codec.decode(sender.runtime.codec.encode(channel.port2, [channel.port2])), receiver.runtime);
  return { sender, receiver, source: channel.port1, target };
}
function receivedTransfer(value: unknown, runtime: ReturnType<typeof sourcePorts>) {
  if (!value || typeof value !== "object" || !("buffer" in value) || !(value.buffer instanceof ArrayBuffer) || !("port" in value)) throw new Error("Missing actual transferred payload");
  return { buffer: value.buffer, port: restore(value.port, runtime) };
}

test("watch observes publication during ready before rearm with real Atomics", async () => {
  const box = createSharedMailbox(), first = Promise.withResolvers<void>(), values: number[] = [];
  cleanup.push(box.close);
  let callbacks = 0, secondAccepted = false;
  const stop = box.watch(() => {
    callbacks++;
    box.drain(bytes => { values.push(bytes[0] ?? -1); });
    if (callbacks === 1) { secondAccepted = box.write(Uint8Array.of(2)); first.resolve(); }
  });
  cleanup.push(stop);
  expect(box.write(Uint8Array.of(1))).toBe(true);
  await first.promise; await nextTurn();
  expect(secondAccepted).toBe(true);
  expect(values).toEqual([1, 2]); expect(box.inspect().queued).toBe(0);
  expect(callbacks).toBeLessThanOrEqual(3);
  const settled = callbacks;
  await nextTurn(); expect(callbacks).toBe(settled);
});

test("watch's own drain signal permits one bounded recheck and then stays quiescent", async () => {
  const box = createSharedMailbox(), first = Promise.withResolvers<void>();
  cleanup.push(box.close);
  let callbacks = 0, drained = 0;
  const stop = box.watch(() => { callbacks++; drained += box.drain(() => {}); first.resolve(); });
  cleanup.push(stop);
  box.write(Uint8Array.of(1)); await first.promise; await nextTurn();
  expect(drained).toBe(1); expect(callbacks).toBe(2);
  await nextTurn(); expect(callbacks).toBe(2);
  stop(); stop(); box.wake(); await nextTurn(); expect(callbacks).toBe(2);
});

for (const mode of ["unwatch", "close"] as const) {
  test(`watch ${mode} inside ready prevents rearm and further callbacks`, async () => {
    const box = createSharedMailbox(), first = Promise.withResolvers<void>(), values: number[] = [];
    cleanup.push(box.close);
    let callbacks = 0, stop = () => {};
    stop = box.watch(() => {
      callbacks++; box.drain(bytes => { values.push(bytes[0] ?? -1); });
      if (mode === "unwatch") stop(); else box.close();
      first.resolve();
    });
    cleanup.push(stop);
    box.write(Uint8Array.of(1)); await first.promise;
    const accepted = box.write(Uint8Array.of(2)); box.wake(); await nextTurn(); await nextTurn();
    expect(values).toEqual([1]); expect(callbacks).toBe(1);
    expect(accepted).toBe(mode === "unwatch");
    expect(box.inspect().closed).toBe(mode === "close");
  });
}

async function nativeWakeProducer() {
  const { parentPort, workerData } = await import("node:worker_threads");
  const input: unknown = workerData;
  if (!parentPort || !input || typeof input !== "object" || !("module" in input) || typeof input.module !== "string"
    || !("buffer" in input) || !(input.buffer instanceof SharedArrayBuffer) || !("control" in input) || !(input.control instanceof SharedArrayBuffer)
    || !("total" in input) || typeof input.total !== "number" || !Number.isSafeInteger(input.total) || input.total < 1) throw new Error("Invalid native wake request");
  const source: typeof import("../web/src/shared-objects/mailbox") = await import(input.module);
  const box = source.createSharedMailbox(input.buffer), control = new Int32Array(input.control);
  const bytes = new Uint8Array(4), view = new DataView(bytes.buffer);
  parentPort.postMessage("ready");
  for (let value = 1; value <= input.total; value++) {
    Atomics.wait(control, 0, value - 1);
    if (Atomics.load(control, 2)) break;
    if (Atomics.load(control, 0) !== value) throw new Error("Native wake request is out of order");
    view.setUint32(0, value, true);
    if (!box.write(bytes)) throw new Error("Native producer unexpectedly lost mailbox credit");
    Atomics.store(control, 1, value); Atomics.notify(control, 1);
  }
  parentPort.close();
}

test("native producer publishes during ready across 512 real atomic handshakes", async () => {
  const box = createSharedMailbox(), control = new Int32Array(new SharedArrayBuffer(12)), values: number[] = [];
  const ready = Promise.withResolvers<void>(), done = Promise.withResolvers<void>(), timeout = Promise.withResolvers<never>();
  const total = 512;
  const worker = new Worker(`(${nativeWakeProducer.toString()})()`, { eval: true, workerData: {
    module: new URL("../web/src/shared-objects/mailbox.ts", import.meta.url).href, buffer: box.buffer, control: control.buffer, total,
  } });
  const exit = once(worker, "exit");
  void exit.catch(done.reject);
  worker.on("error", error => { ready.reject(error); done.reject(error); });
  worker.on("message", value => { if (value === "ready") ready.resolve(); });
  const deadline = setTimeout(() => timeout.reject(new Error("Native atomic wake fixture exceeded 5 seconds")), 5000);
  let callbacks = 0, stop = () => {};
  function request(value: number) {
    Atomics.store(control, 0, value); Atomics.notify(control, 0);
  }
  try {
    await Promise.race([ready.promise, timeout.promise]);
    stop = box.watch(() => {
      try { receive(); } catch (error) { done.reject(error); }
    });
    request(1);
    await Promise.race([done.promise, timeout.promise]);
    stop(); const stopped = callbacks;
    box.wake(); await nextTurn();
    expect(callbacks).toBe(stopped);
    expect(values).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(callbacks).toBeGreaterThanOrEqual(total); expect(callbacks).toBeLessThanOrEqual(total + 1);
    expect(box.inspect().queued).toBe(0);
    expect(await Promise.race([exit, timeout.promise])).toEqual([0]);
  } finally {
    clearTimeout(deadline); stop(); box.close();
    Atomics.store(control, 2, 1); Atomics.notify(control, 0);
    await worker.terminate();
  }
  function receive() {
    callbacks++;
    box.drain(bytes => { values.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)); });
    publication(values.length);
    if (values.length === total) { done.resolve(); return; }
    const next = values.length + 1;
    request(next);
    publication(next);
  }
  function publication(value: number) {
    const observed = Atomics.load(control, 1);
    if (observed === value) return;
    if (Atomics.wait(control, 1, observed, 1000) === "timed-out" || Atomics.load(control, 1) !== value) throw new Error("Native producer did not publish during ready");
  }
}, 7000);

test("review 1 receiver full outbox retains transfer and sequence until real credit", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env);
  const transfer = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8), errors: unknown[] = [];
  own(transfer.port1); target.on("messageerror", error => errors.push(error));
  await tick();
  source.postMessage({ buffer, port: transfer.port2 }, [buffer, transfer.port2]);
  await tick();
  expect(receiver.service.mailbox?.inspect().queued).toBe(1);
  for (let index = 0; index < 8; index++) target.postMessage(index);
  expect(receiver.service.inspectRoutes().outbound).toBe(8);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  await tick(); source.postMessage("following payload"); await tick();
  const received = receivedTransfer(receiver.runtime.receiveMessageOnPort(target)?.message, receiver.runtime);
  expect(buffer.byteLength).toBe(0); expect(received.buffer.byteLength).toBe(8);
  expect(errors).toEqual([]);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "following payload" });
  received.port.postMessage("restored reply"); await tick();
  expect(sender.runtime.receiveMessageOnPort(transfer.port1)).toEqual({ message: "restored reply" });
  await tick(); expect(env.broker.inspectDeliveries().receipts).toBe(0);
});

test("review 2 three owners preserve unread input and subsequent traffic through handoff", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env), next = env.client();
  await tick(); source.postMessage("before move"); await tick();
  expect(receiver.service.mailbox?.inspect().queued).toBe(1);
  const moved = restore(next.runtime.codec.decode(receiver.runtime.codec.encode(target, [target])), next.runtime);
  await tick(); receiver.runtime.pump(); await tick();
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "before move" });
  source.postMessage("after move"); await tick();
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "after move" });
  expect(receiver.service.inspect().closed).toBe(false);
  expect(sender.service.inspect().closed).toBe(false);
  expect(next.runtime.receiveMessageOnPort(moved)).toBeUndefined();
  await tick(); expect(env.broker.inspectDeliveries().receipts).toBe(0);
});

test("review 3 only one precommit notification exists and accepted bytes wake atomically", async () => {
  let armed = false, notifications = 0;
  const env = setup(packet => { if (armed && packet.kind === "route-ready" && ++notifications === 2) throw new Error("second notification failure"); });
  const { sender, receiver, source, target } = connection(env), transfer = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  own(transfer.port1); await tick(); armed = true;
  try { source.postMessage({ buffer, port: transfer.port2 }, [buffer, transfer.port2]); }
  finally { armed = false; }
  await tick();
  const received = receivedTransfer(receiver.runtime.receiveMessageOnPort(target)?.message, receiver.runtime);
  expect(notifications).toBe(1); expect(buffer.byteLength).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
  received.port.postMessage("notification reply"); await tick();
  expect(sender.runtime.receiveMessageOnPort(transfer.port1)).toEqual({ message: "notification reply" });
});

test("review 4 multiple port commits use private ref state without calling public unref", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env);
  const first = new sender.runtime.MessageChannel(), second = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  own(first.port1); own(first.port2); own(second.port1); own(second.port2);
  const firstUnref = first.port2.unref, secondUnref = second.port2.unref;
  cleanup.push(() => { first.port2.unref = firstUnref; second.port2.unref = secondUnref; });
  first.port2.ref(); second.port2.ref();
  first.port2.unref = () => { throw new Error("first public callback"); };
  second.port2.unref = () => { throw new Error("later public callback"); };
  await tick();
  expect(() => source.postMessage({ buffer, port: first.port2, other: second.port2 }, [buffer, first.port2, second.port2])).not.toThrow();
  expect(buffer.byteLength).toBe(0); expect(sender.runtime.internal.messagePortRefs).toBe(0);
  await tick();
  const message = receiver.runtime.receiveMessageOnPort(target)?.message;
  const received = receivedTransfer(message, receiver.runtime);
  if (!message || typeof message !== "object" || !("other" in message)) throw new Error("Missing second transferred port");
  const other = restore(message.other, receiver.runtime);
  received.port.postMessage("first"); other.postMessage("second"); await tick();
  expect(sender.runtime.receiveMessageOnPort(first.port1)).toEqual({ message: "first" });
  expect(sender.runtime.receiveMessageOnPort(second.port1)).toEqual({ message: "second" });
});

test("review 5 full endpoint capacity lets a later close release blocked registration", async () => {
  const env = setup(), sender = env.client(), channels = [];
  for (let index = 0; index < 512; index++) {
    const channel = new sender.runtime.MessageChannel(); channels.push(channel);
    own(channel.port1); own(channel.port2);
    if (index % 8 === 7) await tick();
  }
  await tick(); expect(env.broker.inspectRoutes().endpoints).toBe(1024);
  const extra = new sender.runtime.MessageChannel(); own(extra.port1); own(extra.port2);
  await tick();
  const first = channels[0];
  if (!first) throw new Error("Missing existing channel");
  first.port1.close(); first.port2.close();
  await tick(); await tick(); sender.sharedObjects.routes?.credit(); await tick();
  expect(env.broker.inspectRoutes().endpoints).toBe(1024);
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  expect(env.broker.inspectDeliveries().deferred).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
  extra.port1.postMessage("capacity released");
  expect(sender.runtime.receiveMessageOnPort(extra.port2)).toEqual({ message: "capacity released" });
});

test("multiple transfers keep all ownership and refs on full outbox and native rejection", async () => {
  const env = setup(), { sender, source } = connection(env);
  const first = new sender.runtime.MessageChannel(), second = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  own(first.port1); own(first.port2); own(second.port1); own(second.port2);
  first.port2.ref(); second.port2.ref(); await tick();
  for (let index = 0; index < 8; index++) source.postMessage(index);
  expect(() => source.postMessage({ buffer, port: first.port2, other: second.port2 }, [buffer, first.port2, second.port2])).toThrow("mailbox is full");
  expect(buffer.byteLength).toBe(8); expect(first.port2.hasRef()).toBe(true); expect(second.port2.hasRef()).toBe(true);
  await tick();
  const locked = new WebAssembly.Memory({ initial: 0 }).buffer;
  expect(() => source.postMessage({ buffer, locked, port: first.port2, other: second.port2 }, [buffer, locked, first.port2, second.port2])).toThrow();
  expect(buffer.byteLength).toBe(8); expect(sender.runtime.internal.messagePortRefs).toBe(2);
  first.port2.postMessage("first remains owned"); second.port2.postMessage("second remains owned");
  expect(sender.runtime.receiveMessageOnPort(first.port1)).toEqual({ message: "first remains owned" });
  expect(sender.runtime.receiveMessageOnPort(second.port1)).toEqual({ message: "second remains owned" });
});

test("priority capacity release preserves data and close order on a live remote port", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env);
  await tick();
  for (let index = 0; index < 511; index++) {
    const channel = new sender.runtime.MessageChannel(); own(channel.port1); own(channel.port2);
    if (index % 8 === 7) await tick();
  }
  await tick(); expect(env.broker.inspectRoutes().endpoints).toBe(1024);
  const extra = new sender.runtime.MessageChannel(); own(extra.port1); own(extra.port2);
  await tick(); source.postMessage("accepted before close"); source.close();
  await tick();
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "accepted before close" });
  await tick(); receiver.runtime.pump(); await tick();
  expect(env.broker.inspectRoutes().endpoints).toBe(1024);
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  expect(env.broker.inspectDeliveries()).toEqual({ receipts: 0, deferred: 0 });
  expect(sender.service.inspect().closed).toBe(false);
});

test("a close releases capacity while preserving earlier deferred data source authorization", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env);
  await tick();
  for (let index = 0; index < 511; index++) {
    const channel = new sender.runtime.MessageChannel(); own(channel.port1); own(channel.port2);
    if (index % 8 === 7) await tick();
  }
  await tick();
  const transfer = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8); own(transfer.port1);
  source.postMessage({ buffer, port: transfer.port2 }, [buffer, transfer.port2]);
  source.close(); await tick();
  const received = receivedTransfer(receiver.runtime.receiveMessageOnPort(target)?.message, receiver.runtime);
  expect(received.buffer.byteLength).toBe(8); expect(buffer.byteLength).toBe(0);
  await tick();
  received.port.postMessage("deferred original owner"); await tick();
  expect(sender.runtime.receiveMessageOnPort(transfer.port1)).toEqual({ message: "deferred original owner" });
  expect(sender.service.inspect().closed).toBe(false);
  expect(receiver.service.inspect().closed).toBe(false);
  await tick(); expect(env.broker.inspectDeliveries()).toEqual({ receipts: 0, deferred: 0 });
});

test("receipt ownership rejects a different client without consuming the live delivery", async () => {
  const env = setup(), { receiver, source, target } = connection(env), other = env.client();
  await tick(); source.postMessage("receipt owner"); await tick();
  let receipt: string | undefined;
  receiver.service.mailbox?.drain(bytes => {
    const frame: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (frame && typeof frame === "object" && "receipt" in frame && typeof frame.receipt === "string") receipt = frame.receipt;
    return false;
  });
  if (!receipt) throw new Error("Missing broker-owned receipt");
  expect(other.sharedObjects.routes?.send({ kind: "received", receipt })).toBe(true);
  await tick(); expect(other.service.inspect().closed).toBe(true);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "receipt owner" });
  await tick(); expect(env.broker.inspectDeliveries().receipts).toBe(0);
});

test("handoff with more than one inbox preserves per-port order and drains every receipt", async () => {
  const env = setup(), { receiver, source, target } = connection(env), next = env.client();
  await tick();
  for (let index = 0; index < 20; index++) { source.postMessage(index); await tick(); }
  const moved = restore(next.runtime.codec.decode(receiver.runtime.codec.encode(target, [target])), next.runtime);
  await tick(); receiver.runtime.pump();
  const received: unknown[] = [];
  for (let pass = 0; pass < 5; pass++) {
    let packet: ReturnType<typeof next.runtime.receiveMessageOnPort>;
    while ((packet = next.runtime.receiveMessageOnPort(moved))) received.push(packet.message);
    await tick();
  }
  expect(received).toEqual(Array.from({ length: 20 }, (_, index) => index));
  expect(env.broker.inspectDeliveries()).toEqual({ receipts: 0, deferred: 0 });
  expect(env.broker.inspectRoutes().pending).toBe(0);
  expect(receiver.service.inspect().closed).toBe(false);
});

test("closing a receiver during activation backpressure releases its transferred ownership", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env), transfer = new sender.runtime.MessageChannel();
  own(transfer.port1); await tick();
  source.postMessage({ buffer: new ArrayBuffer(8), port: transfer.port2 }, [transfer.port2]);
  await tick();
  for (let index = 0; index < 8; index++) target.postMessage(index);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  target.close(); await tick(); await tick();
  sender.runtime.pump(); await tick(); receiver.runtime.pump(); await tick();
  for (let index = 0; index < 8; index++) expect(sender.runtime.receiveMessageOnPort(source)).toEqual({ message: index });
  await tick();
  expect(env.broker.inspectDeliveries()).toEqual({ receipts: 0, deferred: 0 });
  expect(env.broker.inspectRoutes().endpoints).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
  expect(receiver.service.inspect().closed).toBe(false);
});

test("terminal capacity release stays live when both endpoint and global pending budgets are full", async () => {
  const env = setup(), sender = env.client(), channels = [];
  for (let index = 0; index < 512; index++) {
    const channel = new sender.runtime.MessageChannel(); channels.push(channel); own(channel.port1); own(channel.port2);
    if (index % 8 === 7) await tick();
  }
  const pending = channels[0], released = channels[1];
  if (!pending || !released) throw new Error("Missing capacity fixture channels");
  sender.runtime.codec.encode(pending.port2, [pending.port2]); await tick();
  for (let block = 0; block < 128; block++) {
    for (let index = 0; index < 8; index++) pending.port1.postMessage(block * 8 + index);
    await tick();
  }
  expect(env.broker.inspectRoutes().pending).toBe(1024);
  const extra = new sender.runtime.MessageChannel(); own(extra.port1); own(extra.port2);
  await tick(); released.port1.close(); released.port2.close(); await tick(); await tick();
  expect(env.broker.inspectRoutes().endpoints).toBe(1024);
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
});

test("full budgets preserve an accepted transferred message before the close that releases capacity", async () => {
  const env = setup(), { sender, receiver, source, target } = connection(env), channels = [];
  await tick();
  for (let index = 0; index < 511; index++) {
    const channel = new sender.runtime.MessageChannel(); channels.push(channel); own(channel.port1); own(channel.port2);
    if (index % 8 === 7) await tick();
  }
  const pending = channels[0];
  if (!pending) throw new Error("Missing global pending source");
  sender.runtime.codec.encode(pending.port2, [pending.port2]); await tick();
  for (let block = 0; block < 128; block++) {
    for (let index = 0; index < 8; index++) pending.port1.postMessage(index);
    await tick();
  }
  const transfer = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8); own(transfer.port1);
  source.postMessage({ buffer, port: transfer.port2 }, [buffer, transfer.port2]); source.close();
  await tick(); await tick();
  const received = receivedTransfer(receiver.runtime.receiveMessageOnPort(target)?.message, receiver.runtime);
  expect(received.buffer.byteLength).toBe(8); expect(buffer.byteLength).toBe(0);
  await tick(); received.port.postMessage("full budget reply"); await tick();
  expect(sender.runtime.receiveMessageOnPort(transfer.port1)).toEqual({ message: "full budget reply" });
  await tick();
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  expect(env.broker.inspectDeliveries().deferred).toBe(0);
  expect(env.broker.inspectRoutes().pending).toBe(1024);
});
