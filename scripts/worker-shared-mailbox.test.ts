import { expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedMailbox } from "../web/src/shared-objects/mailbox";
import { once } from "node:events";
import { Worker, MessagePort as NativeMessagePort } from "node:worker_threads";
import { sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";
import { brokerClients, testCleanup, tick } from "./fixtures/shared-objects/broker-clients";

const cleanup = testCleanup();
// Without channel lanes: these cover the broker route that lanes fall back to.
const setup = () => brokerClients(cleanup, { lanes: false });
function restoredPort(value: unknown, runtime: ReturnType<typeof sourcePorts>): SourcePort {
  if (!(value instanceof runtime.MessagePort)) throw new Error("Missing restored source port");
  return value;
}
function connection() {
  const { broker, client } = setup(), sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  const port = restoredPort(receiver.runtime.codec.decode(sender.runtime.codec.encode(channel.port2, [channel.port2])), receiver.runtime);
  cleanup.add(() => { channel.port1.close(); port.close(); });
  return { broker, sender, receiver, source: channel.port1, target: port };
}
test("source factory routes through host wrapper broker mailbox to a genuinely restored port", async () => {
  const { client } = setup();
  const sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  cleanup.add(() => channel.port1.close());
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  const restored = restoredPort(receiver.runtime.codec.decode(graph), receiver.runtime);
  cleanup.add(() => restored.close());
  await tick();
  channel.port1.postMessage({ answer: "42 λ 😀" });
  await tick();
  expect(receiver.service.mailbox?.inspect().queued).toBe(1);
  expect(receiver.runtime.receiveMessageOnPort(restored)).toEqual({ message: { answer: "42 λ 😀" } });
  restored.postMessage("reply");
  await tick();
  expect(sender.runtime.receiveMessageOnPort(channel.port1)).toEqual({ message: "reply" });
});

test("destination credit resumes ordered pending packets without rebinding", async () => {
  const { broker, sender, receiver, source, target } = connection();
  await tick();
  for (let sequence = 0; sequence < 12; sequence++) { source.postMessage(sequence); await tick(); }
  expect(receiver.service.mailbox?.inspect().queued).toBe(8);
  expect(broker.inspectRoutes().pending).toBe(4);
  const received: unknown[] = [];
  for (let index = 0; index < 8; index++) received.push(receiver.runtime.receiveMessageOnPort(target)?.message);
  await tick();
  for (let index = 0; index < 4; index++) received.push(receiver.runtime.receiveMessageOnPort(target)?.message);
  expect(received).toEqual(Array.from({ length: 12 }, (_, index) => index));
  expect(broker.inspectRoutes().pending).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
});

test("full outbound reservation aborts real transfers before buffer detachment", async () => {
  const { sender, receiver, source, target } = connection();
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick();
  for (let index = 0; index < 8; index++) source.postMessage(index);
  expect(() => source.postMessage({ buffer, shared, port: reply.port2 }, [buffer, reply.port2])).toThrow("mailbox is full");
  expect(buffer.byteLength).toBe(8);
  reply.port2.postMessage("still attached");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "still attached" });
  await tick();
  const received = Array.from({ length: 8 }, () => receiver.runtime.receiveMessageOnPort(target)?.message);
  expect(received).toEqual(Array.from({ length: 8 }, (_, index) => index));
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("close remains bounded and ordered behind a full outbound ring", async () => {
  const { broker, sender, receiver, source, target } = connection();
  await tick();
  for (let index = 0; index < 8; index++) source.postMessage(index);
  source.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(sender.service.inspectRoutes().terminals).toBeLessThanOrEqual(2);
  await tick();
  const received = Array.from({ length: 8 }, () => receiver.runtime.receiveMessageOnPort(target)?.message);
  expect(received).toEqual(Array.from({ length: 8 }, (_, index) => index));
  await tick();
  receiver.runtime.receiveMessageOnPort(target);
  await tick();
  expect(sender.service.inspectRoutes()).toEqual({ outbound: 0, terminals: 0, enabled: true });
  expect(broker.inspectRoutes().pending).toBe(0);
  expect(sender.service.inspect().closed).toBe(false);
});

test("local transfer reserves moving and restored ownership together in the final outbox slot", async () => {
  const { sender, source } = connection();
  const control = new sender.runtime.MessageChannel(), reply = new sender.runtime.MessageChannel();
  cleanup.add(() => { control.port1.close(); control.port2.close(); reply.port1.close(); reply.port2.close(); });
  await tick();
  for (let index = 0; index < 7; index++) source.postMessage(index);
  const buffer = new ArrayBuffer(8);
  control.port1.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2]);
  expect(buffer.byteLength).toBe(0);
  const value = sender.runtime.receiveMessageOnPort(control.port2)?.message;
  if (!value || typeof value !== "object" || !("port" in value)) throw new Error("Missing local transferred port");
  const restored = restoredPort(value.port, sender.runtime);
  cleanup.add(() => restored.close());
  restored.postMessage("restored in final slot");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "restored in final slot" });
});

test("closed owner rejects acceptance without changing transferred source objects", async () => {
  const { sender, source } = connection();
  await tick();
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  sender.service.close();
  expect(() => source.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow();
  expect(buffer.byteLength).toBe(8);
  expect(() => sender.runtime.codec.prepare(reply.port2, [reply.port2])).not.toThrow();
});

test("inactive host refuses delivery and transfers while terminal cleanup stays harmless", async () => {
  let active = true;
  const { client } = setup(), sender = client({ active: () => active });
  const channel = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  await tick();
  active = false;
  const plan = sender.runtime.codec.prepare({ buffer, port: channel.port2 }, [buffer, channel.port2]);
  expect(() => plan.commit()).toThrow("engine host is closed");
  expect(buffer.byteLength).toBe(8);
  expect(sender.sharedObjects.mailbox?.drain(() => { throw new Error("late delivery"); })).toBe(0);
  channel.port1.close(); channel.port2.close();
  await tick();
  expect(sender.service.inspect().closed).toBe(false);
});

test("destination owner close rejects later transfers and purges routed state", async () => {
  const { broker, sender, receiver, source } = connection();
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick();
  receiver.service.close();
  await tick(); await tick();
  expect(() => source.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow();
  expect(buffer.byteLength).toBe(8);
  reply.port2.postMessage("still attached");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "still attached" });
  expect(broker.inspectRoutes().pending).toBe(0);
});

test("global pending budget leaves accepted frames in bounded outboxes and rejects excess transfers", async () => {
  const { broker, client } = setup(), sender = client(), receiver = client();
  const liveSender = client(), liveChannel = new liveSender.runtime.MessageChannel();
  const livePort = restoredPort(receiver.runtime.codec.decode(liveSender.runtime.codec.encode(liveChannel.port2, [liveChannel.port2])), receiver.runtime);
  cleanup.add(() => { liveChannel.port1.close(); livePort.close(); });
  const channel = new sender.runtime.MessageChannel(), reply = new sender.runtime.MessageChannel();
  cleanup.add(() => { channel.port1.close(); reply.port1.close(); reply.port2.close(); });
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  await tick();
  for (let block = 0; block < 128; block++) {
    for (let index = 0; index < 8; index++) channel.port1.postMessage(block * 8 + index);
    await tick();
  }
  expect(broker.inspectRoutes().pending).toBe(1024);
  liveChannel.port1.postMessage("unrelated live destination");
  await tick();
  expect(receiver.runtime.receiveMessageOnPort(livePort)).toEqual({ message: "unrelated live destination" });
  for (let index = 0; index < 8; index++) channel.port1.postMessage(1024 + index);
  await tick();
  expect(sender.service.inspectRoutes().outbound).toBe(8);
  const buffer = new ArrayBuffer(8);
  expect(() => channel.port1.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow("mailbox is full");
  expect(buffer.byteLength).toBe(8);
  expect(broker.inspectRoutes().pending).toBe(1024);
  reply.port2.postMessage("attached");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "attached" });
  const restored = restoredPort(receiver.runtime.codec.decode(graph), receiver.runtime);
  cleanup.add(() => restored.close());
  await tick();
  const received: unknown[] = [];
  for (let block = 0; block < 129; block++) {
    for (let index = 0; index < 8; index++) received.push(receiver.runtime.receiveMessageOnPort(restored)?.message);
    await tick();
  }
  expect(received).toEqual(Array.from({ length: 1032 }, (_, index) => index));
  expect(broker.inspectRoutes().pending).toBe(0);
});

test("sender close cancels pending packets before another owner restores the endpoint", async () => {
  const { broker, client } = setup(), sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  cleanup.add(() => channel.port1.close());
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  channel.port1.postMessage("orphan");
  await tick();
  expect(broker.inspectRoutes().pending).toBe(1);
  sender.service.close();
  await tick();
  expect(broker.inspectRoutes().pending).toBe(0);
  const restored = restoredPort(receiver.runtime.codec.decode(graph), receiver.runtime);
  cleanup.add(() => restored.close());
  await tick();
  expect(receiver.runtime.receiveMessageOnPort(restored)).toBeUndefined();
  receiver.service.close();
  await tick();
  expect(broker.inspectRoutes()).toEqual({ endpoints: 0, pending: 0, registrations: 0 });
});

test("delivery callback exception aborts staged moving records and shared publications", async () => {
  const { client } = setup(), sender = client();
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick();
  const plan = sender.runtime.codec.prepare({ buffer, shared, port: reply.port2 }, [buffer, reply.port2]);
  expect(() => plan.commit(() => { throw new Error("delivery rejected"); })).toThrow("delivery rejected");
  expect(buffer.byteLength).toBe(8);
  reply.port2.postMessage("attached");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "attached" });
  expect(sender.service.inspect().staged).toBe(0);
});

test("publish delivery detach and local commit occur once in order before ring publication", async () => {
  const events: string[] = [];
  let observe = false;
  const { client } = setup();
  const sender = client({
    observe(packet) { if (observe && packet.kind === "publish") events.push("publish"); },
    beforeDetach() {
      if (!observe) return;
      events.push("detach");
      expect(sender.service.inspectRoutes().outbound).toBe(0);
    },
  });
  const receiver = client(), reply = new sender.runtime.MessageChannel();
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick();
  const buffer = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
  const plan = sender.runtime.codec.prepare({ buffer, shared, port: reply.port2 }, [buffer, reply.port2]);
  observe = true;
  plan.commit(() => { events.push("delivery"); expect(buffer.byteLength).toBe(8); });
  observe = false;
  expect(events).toEqual(["publish", "delivery", "detach"]);
  expect(buffer.byteLength).toBe(0);
  expect(() => sender.runtime.codec.prepare(reply.port2, [reply.port2])).toThrow("detached");
  expect(sender.service.inspectRoutes().outbound).toBe(1);
  expect(() => plan.commit()).toThrow("no longer prepared");
  expect(events).toEqual(["publish", "delivery", "detach"]);
  const value = receiver.runtime.codec;
  await new Promise<void>(resolve => value.wait(plan.graph, resolve));
  const result = value.decode(plan.graph);
  if (!result || typeof result !== "object" || !("port" in result)) throw new Error("Missing transfer result");
  const restored = restoredPort(result.port, receiver.runtime);
  cleanup.add(() => restored.close());
  await tick();
  restored.postMessage("local commit completed");
  await tick();
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "local commit completed" });
});

test("native detach exception aborts an invisible reservation and leaves source objects owned", async () => {
  let fail = false;
  const { client } = setup(), sender = client({ beforeDetach() { if (fail) throw new Error("native detach failed"); } });
  const channel = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  await tick();
  const plan = sender.runtime.codec.prepare({ buffer, port: channel.port2 }, [buffer, channel.port2]);
  fail = true;
  expect(() => plan.commit()).toThrow("ArrayBuffer is not detachable");
  fail = false;
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  channel.port2.postMessage("attached");
  expect(sender.runtime.receiveMessageOnPort(channel.port1)).toEqual({ message: "attached" });
});

test("notification exception rejects reservation before real transfers detach", async () => {
  let fail = false;
  const { client } = setup(), sender = client({ observe(packet) { if (fail && packet.kind === "route-ready") throw new Error("route notification rejected"); } });
  const channel = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  await tick();
  const plan = sender.runtime.codec.prepare({ buffer, port: channel.port2 }, [buffer, channel.port2]);
  fail = true;
  expect(() => plan.commit()).toThrow("route notification rejected");
  fail = false;
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspectRoutes().outbound).toBe(0);
  expect(() => sender.runtime.codec.prepare(channel.port2, [channel.port2])).not.toThrow();
});

test("cursor wrap is unsigned and malformed frames terminally close the mailbox", () => {
  for (const start of [0x7fffffff, 0xffffffff]) {
    const mailbox = createSharedMailbox(); cleanup.add(mailbox.close);
    const header = new Int32Array(mailbox.buffer, 0, 4);
    header[0] = start; header[1] = start;
    expect(mailbox.write(new Uint8Array([42]))).toBe(true);
    expect(mailbox.inspect().queued).toBe(1);
    expect(mailbox.drain(bytes => { expect(bytes).toEqual(new Uint8Array([42])); })).toBe(1);
    expect(mailbox.inspect().queued).toBe(0);
    mailbox.write(new Uint8Array([1]));
    expect(() => mailbox.drain(() => { throw new Error("malformed"); })).toThrow("malformed");
    expect(mailbox.inspect()).toEqual({ queued: 0, closed: true });
    expect(mailbox.drain(() => { throw new Error("retried malformed frame"); })).toBe(0);
  }
});

test("a reserved frame is invisible until commit and abort returns its capacity", () => {
  const mailbox = createSharedMailbox(); cleanup.add(mailbox.close);
  const reservation = mailbox.reserve(new Uint8Array([1]));
  expect(reservation).not.toBeNull();
  expect(mailbox.inspect().queued).toBe(0);
  expect(mailbox.reserve(new Uint8Array([2]))).toBeNull();
  reservation?.abort();
  expect(mailbox.write(new Uint8Array([3]))).toBe(true);
  expect(mailbox.drain(bytes => { expect(bytes[0]).toBe(3); })).toBe(1);
});

test("native workers execute source factories and host wrappers through the real broker", async () => {
  const broker = createSharedObjectBroker();
  const workers: Worker[] = [], ports: NativeMessagePort[] = [], states: unknown[] = [];
  const done = Promise.withResolvers<void>();
  const timeout = Promise.withResolvers<never>();
  const deadline = setTimeout(() => timeout.reject(new Error("Native mailbox fixture exceeded 5 seconds")), 5000);
  let received = 0, sent = 0;
  try {
    const receiverLease = broker.register(), senderLease = broker.register();
    const receiver = new Worker(new URL("./fixtures/shared-objects/mailbox-worker.ts", import.meta.url), { workerData: { owner: receiverLease.id, role: "receiver" } });
    const sender = new Worker(new URL("./fixtures/shared-objects/mailbox-worker.ts", import.meta.url), { workerData: { owner: senderLease.id, role: "sender" } });
    workers.push(receiver, sender);
    function message(lease: typeof senderLease, value: Record<string, unknown>) {
      if (value.type === "bun-shared-connect") {
        if (value.owner !== lease.id || !(value.port instanceof NativeMessagePort)) throw new Error("Invalid native mailbox attachment");
        ports.push(value.port); lease.attach(value.port); return;
      }
      if (value.kind === "initial") { receiver.postMessage({ kind: "restore", graph: value.graph }); return; }
      if (value.kind === "ready") { sender.postMessage({ kind: "send" }); return; }
      if (value.kind === "sent") { sent++; return; }
      if (value.kind === "received") { received++; return; }
      if (value.kind === "cleanup") { states.push(value.state); return; }
      if (value.kind === "replied") {
        expect(value.callbacksWhileBlocked).toBe(0); expect(value.timerFired).toBe(false);
        done.resolve(); return;
      }
      throw new Error("Unknown native mailbox response");
    }
    for (const [worker, lease] of [[receiver, receiverLease], [sender, senderLease]] as const) {
      worker.on("message", value => { try { message(lease, value); } catch (error) { done.reject(error); } });
      worker.on("error", done.reject);
      worker.once("exit", () => lease.close());
    }
    await Promise.race([done.promise, timeout.promise]);
    expect({ received, sent }).toEqual({ received: 1, sent: 1 });
    const exits = workers.map(worker => once(worker, "exit"));
    for (const worker of workers) worker.postMessage({ kind: "stop" });
    expect(await Promise.race([Promise.all(exits), timeout.promise])).toEqual([[0], [0]]);
    // Frames committed before a close stay in the outbox for the broker, which drains them on exit.
    const closed = { outbound: expect.any(Number), terminals: 0, enabled: true };
    expect(states).toEqual([closed, closed]);
    expect(broker.inspectRoutes()).toEqual({ endpoints: 0, pending: 0, registrations: 0 });
    expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  } finally {
    clearTimeout(deadline);
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const port of ports) port.close();
    broker.dispose();
  }
}, 7000);
