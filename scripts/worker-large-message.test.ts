import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brokerClients, testCleanup } from "./fixtures/shared-objects/broker-clients";
import type { Graph } from "./fixtures/shared-objects/runtime-types";
import type { SourcePort } from "./fixtures/shared-objects/source-runtime";

const cleanup = testCleanup();
type Client = ReturnType<ReturnType<typeof brokerClients>["client"]>;

async function restore(graph: Graph, receiver: Client): Promise<SourcePort> {
  await new Promise<void>(resolve => { if (!receiver.runtime.codec.wait(graph, resolve)) resolve(); });
  const port = receiver.runtime.codec.decode(graph);
  if (!(port instanceof receiver.runtime.MessagePort)) throw new Error("Missing restored port");
  cleanup.add(() => port.close());
  return port;
}

async function connection(options: Parameters<ReturnType<typeof brokerClients>["client"]>[0] = {}) {
  const { client } = brokerClients(cleanup, { lanes: true });
  const sender = client(options), receiver = client(options);
  await Promise.all([sender.service.ready, receiver.service.ready]);
  const channel = new sender.runtime.MessageChannel();
  cleanup.add(() => channel.port1.close());
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), receiver);
  await Promise.all([sender.settleRoutes(), receiver.settleRoutes()]);
  return { client, sender, receiver, source: channel.port1, target };
}

test("large text crosses a runtime lane once, between its preceding and following messages", async () => {
  const { receiver, source, target } = await connection();
  const text = "x".repeat(2 * 1024 * 1024);
  source.postMessage("before");
  source.postMessage(text);
  source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "before" });
  expect(receiver.runtime.receiveMessageOnPort(target)?.message).toBe(text);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "after" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("large text preserves transferred buffer bytes and port ownership", async () => {
  const { sender, receiver, source, target } = await connection();
  const reply = new sender.runtime.MessageChannel();
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  const buffer = new Uint8Array([2, 3, 5, 7]).buffer;
  const text = "λ".repeat(1024 * 1024);
  source.postMessage({ text, buffer, port: reply.port2 }, [buffer, reply.port2]);
  expect(buffer.byteLength).toBe(0);
  const received = receiver.runtime.receiveMessageOnPort(target)?.message;
  if (!received || typeof received !== "object") throw new Error("Missing large message");
  if (!("buffer" in received) || !(received.buffer instanceof ArrayBuffer)) throw new Error("Missing transferred buffer");
  if (!("port" in received) || !(received.port instanceof receiver.runtime.MessagePort)) throw new Error("Missing transferred port");
  const moved = received.port;
  cleanup.add(() => moved.close());
  expect("text" in received && received.text).toBe(text);
  expect(Array.from(new Uint8Array(received.buffer))).toEqual([2, 3, 5, 7]);
  moved.postMessage("reply from new owner");
  expect(sender.runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "reply from new owner" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("large ArrayBuffer crosses the codec's base64 wire expansion boundary", async () => {
  const { receiver, source, target } = await connection();
  const buffer = new ArrayBuffer(800 * 1024);
  new Uint8Array(buffer).fill(23);
  source.postMessage(buffer, [buffer]);
  expect(buffer.byteLength).toBe(0);
  const received = receiver.runtime.receiveMessageOnPort(target)?.message;
  if (!(received instanceof ArrayBuffer)) throw new Error("Missing transferred buffer");
  expect(received.byteLength).toBe(800 * 1024);
  expect(new Uint8Array(received).every(value => value === 23)).toBe(true);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

const nativeControls: readonly [string, string][] = [["Node", "node"], ["Bun", process.execPath]];
for (const [name, executable] of nativeControls) {
  test(`${name} positive control: real workers receive the same large messages after an atomic wake`, () => {
    const file = fileURLToPath(new URL("./fixtures/shared-objects/large-message-native.ts", import.meta.url));
    const output = execFileSync(executable, [file], { encoding: "utf8", timeout: 10000 });
    expect(output.trim().split("\n")).toHaveLength(3);
    expect(output).toContain('"synchronousAfterWake":true');
  });
}

test("busy overflow rejects before detachment, then copies and reuses the same direction", async () => {
  const { sender, receiver, source, target } = await connection();
  const carried = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8), text = "λ".repeat(600000);
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  source.postMessage("before"); source.postMessage(text); source.postMessage("after");
  expect(() => source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("slot is busy");
  expect(buffer.byteLength).toBe(8);
  carried.port2.postMessage("still owned");
  expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  expect(sender.service.inspect().staged).toBe(0);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "before" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "after" });
  source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2]);
  expect(buffer.byteLength).toBe(0);
  const delivered = receiver.runtime.receiveMessageOnPort(target)?.message;
  expect(delivered).toMatchObject({ text });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("unavailable overflow rejects without staged references, detachment or a sequence hole", async () => {
  const { sender, receiver, source, target } = await connection({ grant: grant => ({ ...grant, overflow: null }) });
  const buffer = new ArrayBuffer(8), carried = new sender.runtime.MessageChannel();
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  expect(() => source.postMessage({ text: "x".repeat(1100000), buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("overflow is unavailable");
  expect(buffer.byteLength).toBe(8);
  carried.port2.postMessage("still owned");
  expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  expect(sender.service.inspect().staged).toBe(0);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  source.postMessage("next"); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "next" });
});

test("a failed native detach aborts large bytes but retains successful capacity growth", async () => {
  let reject = false;
  let grant: import("../web/src/shared-objects/protocol").SharedPoolGrant | undefined;
  const { sender, receiver, source, target } = await connection({ beforeDetach() { if (reject) throw new Error("detach rejected"); }, grant(value) { grant = value; return value; } });
  const buffer = new ArrayBuffer(8), carried = new sender.runtime.MessageChannel();
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  const text = "x".repeat(1100000);
  reject = true;
  expect(() => source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("ArrayBuffer is not detachable");
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspect().staged).toBe(0);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  if (!grant) throw new Error("Missing grant");
  const control = new Int32Array(grant.control), charge = Atomics.load(control, 27);
  expect(charge).toBeGreaterThan(1100000);
  reject = false;
  carried.port2.postMessage("still owned"); expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  source.postMessage(text); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  expect(Atomics.load(control, 27)).toBe(charge);
});

test("unread A moves without returning credit, the new owner copies it before B reuses the slot", async () => {
  const { client, sender, receiver, source, target } = await connection();
  const next = client(); await next.service.ready;
  const a = "A".repeat(1100000), b = "B".repeat(1100000);
  source.postMessage("before"); source.postMessage(a); source.postMessage("after");
  const moved = await restore(receiver.runtime.codec.encode(target, [target]), next);
  expect(() => source.postMessage(b)).toThrow("slot is busy");
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "before" });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: a });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "after" });
  source.postMessage(b); expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: b });
  expect(next.runtime.receiveMessageOnPort(moved)).toBeUndefined();
  await Promise.all([sender.settleRoutes(), receiver.settleRoutes(), next.settleRoutes()]);
  let closes = 0; moved.on("close", () => closes++); source.close();
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  next.runtime.pump(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(closes).toBe(1);
});

test("route-outbox rejection after growth keeps the charge and aborts bytes before detachment", async () => {
  let grant: import("../web/src/shared-objects/protocol").SharedPoolGrant | undefined;
  const { sender, receiver, source, target } = await connection({ grant(value) { grant = value; return value; } });
  const carried = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  await sender.settleRoutes();
  for (let index = 0; index < 8; index++) expect(sender.sharedObjects.routes!.send({ kind: "received", receipt: `unused-${index}` })).toBe(true);
  const text = "x".repeat(1100000);
  expect(() => source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("mailbox is full");
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspect().staged).toBe(0);
  if (!grant) throw new Error("Missing grant");
  const control = new Int32Array(grant.control), charge = Atomics.load(control, 27);
  expect(charge).toBeGreaterThan(text.length);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  carried.port2.postMessage("still owned"); expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  await sender.settleRoutes();
  source.postMessage(text); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  expect(Atomics.load(control, 27)).toBe(charge);
});
