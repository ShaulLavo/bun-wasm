import { expect, test } from "bun:test";
import { createSharedLaneBuffer, openSharedLane } from "../web/src/shared-objects/lane";
import type { SourcePort } from "./fixtures/shared-objects/source-runtime";
import { brokerClients, testCleanup, tick } from "./fixtures/shared-objects/broker-clients";
import type { Graph } from "./fixtures/shared-objects/runtime-types";

const cleanup = testCleanup();
const setup = (lanes = true) => brokerClients(cleanup, { lanes });
type Client = ReturnType<ReturnType<typeof setup>["client"]>;
/** Restores a transferred port once its shared backings are attached, as worker startup and receive do. */
async function restore(graph: Graph, into: Client): Promise<SourcePort> {
  await new Promise<void>(resolve => { if (!into.runtime.codec.wait(graph, resolve)) resolve(); });
  const port = into.runtime.codec.decode(graph);
  if (!(port instanceof into.runtime.MessagePort)) throw new Error("Missing restored port");
  return port;
}
async function connection(lanes = true) {
  const { broker, client } = setup(lanes), sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), receiver);
  cleanup.add(() => { channel.port1.close(); target.close(); });
  return { broker, client, sender, receiver, source: channel.port1, target };
}

test("a complete packet is visible to the peer's owner as soon as postMessage returns", async () => {
  const { broker, sender, receiver, source, target } = await connection();
  await tick();
  source.postMessage({ answer: "42 λ 😀" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: { answer: "42 λ 😀" } });
  target.postMessage("reply");
  expect(sender.runtime.receiveMessageOnPort(source)).toEqual({ message: "reply" });
  expect(receiver.service.mailbox?.inspect().queued).toBe(0);
  expect(broker.inspectRoutes().pending).toBe(0);
});

// Limitation, not parity: a SharedArrayBuffer published with the packet attaches through the
// receiver's event loop, so the complete frame is visible at once but decodes only after that.
test("limitation: a fresh SharedArrayBuffer decodes after it attaches, in order and exactly once", async () => {
  const { sender, receiver, source, target } = await connection();
  await tick();
  const shared = new SharedArrayBuffer(8);
  Atomics.store(new Int32Array(shared), 0, 7);
  source.postMessage("before"); source.postMessage({ shared, alias: shared }); source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "before" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  let received: { message: unknown } | undefined;
  for (let attempt = 0; attempt < 100 && !received; attempt++) { await tick(); received = receiver.runtime.receiveMessageOnPort(target); }
  const value = received?.message;
  if (!value || typeof value !== "object" || !("shared" in value) || !(value.shared instanceof SharedArrayBuffer)) throw new Error("Missing shared message");
  expect("alias" in value && value.alias).toBe(value.shared);
  const cells = new Int32Array(value.shared);
  expect(Atomics.load(cells, 0)).toBe(7);
  Atomics.store(cells, 1, 9);
  expect(Atomics.load(new Int32Array(shared), 1)).toBe(9);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "after" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  expect(sender.runtime.receiveMessageOnPort(source)).toBeUndefined();
});

test("handing off the reading end keeps unread lane packets and later ones in order", async () => {
  const { client, sender, receiver, source, target } = await connection();
  const next = client();
  source.postMessage(0); source.postMessage(1);
  const graph = receiver.runtime.codec.encode(target, [target]);
  source.postMessage(2);
  const moved = await restore(graph, next);
  cleanup.add(() => moved.close());
  source.postMessage(3);
  const received = Array.from({ length: 4 }, () => next.runtime.receiveMessageOnPort(moved)?.message);
  expect(received).toEqual([0, 1, 2, 3]);
  moved.postMessage("back");
  expect(sender.runtime.receiveMessageOnPort(source)).toEqual({ message: "back" });
});

test("a full lane rejects a message before anything detaches", async () => {
  const { receiver, source, target } = await connection();
  const fill = "a".repeat(1024 * 1024 - 2048), buffer = new ArrayBuffer(8);
  source.postMessage(fill);
  expect(() => source.postMessage({ text: "b".repeat(4096), buffer }, [buffer])).toThrow("lane is full");
  expect(buffer.byteLength).toBe(8);
  expect(receiver.runtime.receiveMessageOnPort(target)?.message).toBe(fill);
  source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "after" });
});

test("a message larger than the lane is rejected before anything detaches", async () => {
  const { receiver, source, target } = await connection();
  const buffer = new ArrayBuffer(8);
  expect(() => source.postMessage({ text: "x".repeat(1024 * 1024), buffer }, [buffer])).toThrow("byte limit between processes");
  expect(buffer.byteLength).toBe(8);
  source.postMessage("still open");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "still open" });
});

test("a close after lane data arrives behind it", async () => {
  const { receiver, source, target } = await connection();
  const closed = new Promise<void>(resolve => target.on("close", () => resolve()));
  source.postMessage("a"); source.postMessage("b"); source.close();
  await tick();
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "a" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "b" });
  await closed;
});

test("a sender's exit cannot close the peer before the lane data it committed", async () => {
  const { sender, receiver, source, target } = await connection();
  source.postMessage("last words");
  sender.service.close();
  for (let attempt = 0; attempt < 100 && !receiver.service.mailbox?.inspect().queued; attempt++) await tick();
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "last words" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

for (const lanes of [true, false]) test(`a retired destination rejects a transfer before detachment, lanes=${lanes}`, async () => {
  const { sender, receiver, source } = await connection(lanes);
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick(); receiver.service.close(); await tick(); await tick();
  expect(() => source.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow();
  expect(buffer.byteLength).toBe(8);
});

test("a refused send to a retired peer releases its staged shared backing for a live channel", async () => {
  const { client, sender, receiver, source } = await connection();
  const live = client(), channel = new sender.runtime.MessageChannel();
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), live);
  cleanup.add(() => { channel.port1.close(); target.close(); });
  const reply = new sender.runtime.MessageChannel(), shared = new SharedArrayBuffer(8), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick(); receiver.service.close(); await tick(); await tick();
  const staged = sender.service.inspect().staged;
  expect(() => source.postMessage({ shared, buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow("peer is closed");
  expect(sender.service.inspect().staged).toBe(staged);
  expect(buffer.byteLength).toBe(8);
  channel.port1.postMessage({ shared, port: reply.port2 }, [reply.port2]);
  let received: { message: unknown } | undefined;
  for (let attempt = 0; attempt < 100 && !received; attempt++) { await tick(); received = live.runtime.receiveMessageOnPort(target); }
  const value = received?.message;
  if (!value || typeof value !== "object" || !("shared" in value) || !(value.shared instanceof SharedArrayBuffer)) throw new Error("Missing shared message");
  if (!("port" in value) || !(value.port instanceof live.runtime.MessagePort)) throw new Error("Missing transferred port");
  const moved = value.port;
  cleanup.add(() => moved.close());
  Atomics.store(new Int32Array(value.shared), 0, 5);
  expect(Atomics.load(new Int32Array(shared), 0)).toBe(5);
  moved.postMessage("from the live channel");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "from the live channel" });
});

test("a closed destination port never takes a transfer", async () => {
  const { sender, receiver, source, target } = await connection();
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  target.close(); await tick();
  // Rejected over the closed lane, or dropped by a source that already saw the close: never detached.
  try { source.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2]); } catch (error) { expect(String(error)).toContain("peer is closed"); }
  expect(buffer.byteLength).toBe(8);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

for (const lanes of [true, false]) test(`closing a port releases transfers it never read, lanes=${lanes}`, async () => {
  const { broker, sender, receiver, source, target } = await connection(lanes);
  const reply = new sender.runtime.MessageChannel();
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick();
  source.postMessage({ port: reply.port2 }, [reply.port2]);
  target.close();
  await tick(); await tick(); sender.runtime.pump(); receiver.runtime.pump(); await tick();
  reply.port1.close(); source.close();
  await tick(); await tick();
  expect(broker.inspectRoutes()).toEqual({ endpoints: 0, pending: 0, registrations: 0 });
});

test("a native detach failure leaves the lane empty and the transfers usable", async () => {
  const { client } = setup();
  let reject = false;
  const sender = client({ beforeDetach() { if (reject) throw new Error("injected native rejection"); } }), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), receiver);
  cleanup.add(() => { channel.port1.close(); target.close(); });
  const reply = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  await tick(); reject = true;
  expect(() => channel.port1.postMessage({ buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow();
  reject = false;
  expect(buffer.byteLength).toBe(8);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  reply.port2.postMessage("still attached");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "still attached" });
  channel.port1.postMessage("next");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "next" });
});

test("a sender's exit keeps a port it sent over the lane for the receiver", async () => {
  const { broker, sender, receiver, source, target } = await connection();
  const third = new receiver.runtime.MessageChannel();
  cleanup.add(() => third.port1.close());
  const atSender = await restore(receiver.runtime.codec.encode(third.port2, [third.port2]), sender);
  await tick();
  source.postMessage(atSender, [atSender]);
  sender.service.close(); await tick(); await tick();
  const moved = receiver.runtime.receiveMessageOnPort(target)?.message;
  if (!(moved instanceof receiver.runtime.MessagePort)) throw new Error("Missing returned endpoint");
  cleanup.add(() => moved.close());
  moved.postMessage("still authorized");
  expect(receiver.runtime.receiveMessageOnPort(third.port1)).toEqual({ message: "still authorized" });
  await tick();
  expect(broker.inspectRoutes().registrations).toBe(0);
});

test("an unrelated broker sender cannot inject into a lane channel", async () => {
  const { client } = setup(), sender = client(), receiver = client(), unrelated = client();
  const channel = new sender.runtime.MessageChannel();
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  const target = await restore(graph, receiver);
  cleanup.add(() => { channel.port1.close(); target.close(); });
  await tick();
  const node = graph.nodes.find(node => node[0] === "port");
  if (!node || node[0] !== "port") throw new Error("Missing transferred endpoint snapshot");
  unrelated.service.routes?.send({ kind: "port-data", id: node[1].id, from: node[1].peer, sequence: 0, graph: unrelated.runtime.codec.encode({ data: "unrelated", ports: [] }) });
  await tick(); await tick();
  expect(unrelated.service.inspect().closed).toBe(true);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  channel.port1.postMessage("authorized");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "authorized" });
});

test("lane frames stay invisible until commit and wrap around the ring", () => {
  const buffer = createSharedLaneBuffer();
  const left = openSharedLane(buffer, 0), right = openSharedLane(buffer, 1);
  const read = () => { const texts: string[] = []; right.drain(text => texts.push(text)); return texts; };
  const pending = left.reserve("hidden");
  expect(pending).not.toBeNull();
  expect(left.reserve("second")).toBeNull();
  expect(read()).toEqual([]);
  pending?.abort();
  left.reserve("shown")?.commit();
  expect(read()).toEqual(["shown"]);
  const chunk = "x".repeat(200 * 1024 + 3);
  for (let round = 0; round < 12; round++) {
    left.reserve(`${round}${chunk}`)?.commit(); left.reserve(`${round}λ`)?.commit();
    expect(read()).toEqual([`${round}${chunk}`, `${round}λ`]);
  }
  let filled = 0;
  for (let frame = left.reserve(chunk); frame; frame = left.reserve(chunk)) { frame.commit(); filled++; }
  expect(filled).toBe(5);
  expect(read()).toHaveLength(5);
  expect(() => left.reserve("x".repeat(1024 * 1024))).toThrow("byte limit between processes");
  expect(left.peerClosed()).toBe(false);
  right.close();
  expect(left.peerClosed()).toBe(true);
  expect(() => left.reserve("late")).toThrow("peer is closed");
});
