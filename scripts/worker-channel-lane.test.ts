import { afterEach, expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import { bindSharedObjectHost } from "../web/src/shared-objects/host";
import { createSharedLaneBuffer, openSharedLane } from "../web/src/shared-objects/lane";
import { sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";
import type { Graph } from "./fixtures/shared-objects/runtime-types";

const cleanup = new Set<() => void>();
afterEach(async () => {
  for (const close of Array.from(cleanup).reverse()) close();
  cleanup.clear();
  await new Promise<void>(resolve => setImmediate(resolve));
});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function setup() {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  function client() {
    const lease = broker.register(), channel = new MessageChannel();
    lease.attach(channel.port2);
    const service = createSharedObjects(lease.id, {
      postMessage: packet => channel.port1.postMessage(packet),
      start: () => channel.port1.start(), close: () => channel.port1.close(),
      addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
    });
    const sharedObjects = bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} });
    const runtime = sourcePorts({ sharedObjects });
    cleanup.add(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
    return { service, runtime };
  }
  return { broker, client };
}
type Client = ReturnType<ReturnType<typeof setup>["client"]>;
/** Restores a transferred port once its shared backings are attached, as worker startup and receive do. */
async function restore(graph: Graph, into: Client): Promise<SourcePort> {
  await new Promise<void>(resolve => { if (!into.runtime.codec.wait(graph, resolve)) resolve(); });
  const port = into.runtime.codec.decode(graph);
  if (!(port instanceof into.runtime.MessagePort)) throw new Error("Missing restored port");
  return port;
}
async function connection() {
  const { broker, client } = setup(), sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), receiver);
  cleanup.add(() => { channel.port1.close(); target.close(); });
  return { broker, client, sender, receiver, source: channel.port1, target };
}

test("a packet is readable by the peer's owner as soon as postMessage returns", async () => {
  const { broker, sender, receiver, source, target } = await connection();
  await tick();
  source.postMessage({ answer: "42 λ 😀" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: { answer: "42 λ 😀" } });
  target.postMessage("reply");
  expect(sender.runtime.receiveMessageOnPort(source)).toEqual({ message: "reply" });
  expect(receiver.service.mailbox?.inspect().queued).toBe(0);
  expect(broker.inspectRoutes().pending).toBe(0);
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

test("a full lane falls back to the broker without reordering", async () => {
  const { receiver, source, target } = await connection();
  const fill = "a".repeat(1024 * 1024 - 2048), overflow = "b".repeat(4096);
  source.postMessage(fill); source.postMessage(overflow); source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)?.message).toBe(fill);
  // The overflow took the broker, so "after" waits behind it on the receiving side.
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  for (let attempt = 0; attempt < 100 && !receiver.service.mailbox?.inspect().queued; attempt++) await tick();
  const rest = Array.from({ length: 2 }, () => receiver.runtime.receiveMessageOnPort(target)?.message);
  expect(rest).toEqual([overflow, "after"]);
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
});
