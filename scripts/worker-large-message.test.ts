import { sourceLane } from "./fixtures/shared-objects/source-lane";
import { poolChargedWord, overflowBudget, slotWord } from "../web/src/shared-objects/lane-overflow";
import { sharedPoolLaneCursor } from "../web/src/shared-objects/protocol";
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
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  const target = await restore(graph, receiver);
  await Promise.all([sender.settleRoutes(), receiver.settleRoutes()]);
  return { client, sender, receiver, source: channel.port1, target, graph };
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
  let grant: import("../web/src/shared-objects/protocol").SharedPoolGrant | undefined;
  const { client, sender, receiver, source, target, graph } = await connection({ grant(value) { grant = value; return value; } });
  const node = graph.nodes.find(node => node[0] === "port" && node.length === 4);
  if (!grant || !node || node[0] !== "port" || node.length !== 4 || node[1].poolIndex === null) throw new Error("Missing pooled snapshot");
  const control = new Int32Array(grant.control), word = slotWord(node[1].poolIndex, node[1].side);
  const a = "A".repeat(1100000), b = "B".repeat(1100000);
  source.postMessage("before"); source.postMessage(a); source.postMessage("after");
  expect(Atomics.load(control, word) & 3).toBe(2);
  const snapshot = receiver.runtime.codec.encode(target, [target]);
  const next = client(); await next.service.ready;
  const moved = await restore(snapshot, next);
  expect(Atomics.load(control, word) & 3).toBe(2);
  expect(() => source.postMessage(b)).toThrow("slot is busy");
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "before" });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: a });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "after" });
  expect(Atomics.load(control, word) & 3).toBe(0);
  source.postMessage(b); expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: b });
  expect(next.runtime.receiveMessageOnPort(moved)).toBeUndefined();
  await Promise.all([sender.settleRoutes(), receiver.settleRoutes(), next.settleRoutes()]);
  let closes = 0;
  const closed = new Promise<void>(resolve => moved.on("close", () => { closes++; resolve(); }));
  source.close(); await closed;
  source.close(); await new Promise<void>(resolve => setImmediate(resolve));
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

test("the runtime admits exactly the encoded cap and rejects the next byte without a sequence hole", async () => {
  const { sender, receiver, source, target } = await connection();
  const buffer = new ArrayBuffer(8);
  const plan = sender.runtime.codec.prepare({ data: { text: "", buffer }, ports: [] }, [buffer]);
  const overhead = new TextEncoder().encode(JSON.stringify({ kind: "port-data", sequence: 0, graph: plan.graph })).length;
  plan.abort();
  const text = "x".repeat(64 * 1024 * 1024 - overhead);
  source.postMessage({ text, buffer }, [buffer]);
  expect(buffer.byteLength).toBe(0);
  const received = receiver.runtime.receiveMessageOnPort(target)?.message;
  expect(received).toMatchObject({ text });
  const rejected = new ArrayBuffer(8);
  expect(() => source.postMessage({ text: text + "x", buffer: rejected }, [rejected])).toThrow("encoded limit");
  expect(rejected.byteLength).toBe(8);
  expect(sender.service.inspect().staged).toBe(0);
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  source.postMessage("next"); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "next" });
});

test("copied A survives a reader move while B reuses the credited slot", async () => {
  const { client, receiver, source, target } = await connection();
  const a = "A".repeat(1100000), b = "B".repeat(1100000);
  source.postMessage("before"); source.postMessage(a); source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "before" });
  const next = client(); await next.service.ready;
  const graph = receiver.runtime.codec.encode(target, [target]);
  source.postMessage(b);
  const moved = await restore(graph, next);
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: a });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: "after" });
  expect(next.runtime.receiveMessageOnPort(moved)).toEqual({ message: b });
  expect(next.runtime.receiveMessageOnPort(moved)).toBeUndefined();
});

test("a moved writer continues the shared generation and sequence", async () => {
  const { client, sender, receiver, source, target } = await connection();
  const text = "x".repeat(1100000);
  source.postMessage(text); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  const next = client(); await next.service.ready;
  const moved = await restore(sender.runtime.codec.encode(source, [source]), next);
  moved.postMessage(text); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("a large unread carried endpoint outlives the sending service and still replies", async () => {
  const { client, sender, receiver, source, target } = await connection();
  const live = client(); await live.service.ready;
  const reply = new sender.runtime.MessageChannel();
  const counterpart = await restore(sender.runtime.codec.encode(reply.port1, [reply.port1]), live);
  await Promise.all([sender.settleRoutes(), live.settleRoutes()]);
  source.postMessage({ text: "x".repeat(1100000), port: reply.port2 }, [reply.port2]);
  sender.service.close();
  const body = receiver.runtime.receiveMessageOnPort(target)?.message;
  if (!body || typeof body !== "object" || !("port" in body) || !(body.port instanceof receiver.runtime.MessagePort)) throw new Error("Missing carried port");
  const carried = body.port; cleanup.add(() => carried.close());
  body.port.postMessage("reply after sender exit");
  expect(live.runtime.receiveMessageOnPort(counterpart)).toEqual({ message: "reply after sender exit" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
});

test("explicit unread receiver close rejects the next transfer before detachment", async () => {
  const { sender, source, target } = await connection();
  const carried = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8), text = "x".repeat(1100000);
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  source.postMessage(text); target.close();
  expect(() => source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("closed");
  expect(buffer.byteLength).toBe(8);
  carried.port2.postMessage("still owned"); expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  expect(sender.service.inspect().staged).toBe(0);
});

for (const failure of ["unpooled", "budget", "grow", "full-ring"] as const) test(`${failure} admission preserves transfers, sequence and publication state`, async () => {
  const realm = await sourceLane({ grow() { throw new RangeError("native grow rejected"); } });
  const options: Parameters<ReturnType<typeof brokerClients>["client"]>[0] = {};
  if (failure === "unpooled") options.grant = grant => { Atomics.store(new Int32Array(grant.control), sharedPoolLaneCursor, 32); return grant; };
  if (failure === "budget") options.grant = grant => { Atomics.store(new Int32Array(grant.control), poolChargedWord, overflowBudget); return grant; };
  if (failure === "grow") options.lane = (backing, side, grant) => {
    const overflow = backing.poolIndex === null || !grant ? undefined : { control: new Int32Array(grant.control), index: backing.poolIndex, slots: grant.overflow?.slots[backing.poolIndex] ?? null };
    return realm.openSharedLane(backing.buffer, side, overflow);
  };
  const { sender, receiver, source, target } = await connection(options);
  const carried = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  const fill = "f".repeat(1048445);
  if (failure === "full-ring") source.postMessage(fill);
  expect(() => source.postMessage({ text: "x".repeat(1100000), buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow();
  expect(buffer.byteLength).toBe(8);
  carried.port2.postMessage("still owned"); expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  expect(sender.service.inspect().staged).toBe(0);
  if (failure === "full-ring") expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: fill });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  source.postMessage("next"); expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "next" });
});

test("internal JSON consumption failure remains an explicit terminal runtime receive error", async () => {
  const { sender, receiver, source, target, graph } = await connection();
  const node = graph.nodes.find(node => node[0] === "port" && node.length === 4);
  if (!node || node[0] !== "port" || node.length !== 4) throw new Error("Missing lane snapshot");
  const fixed = graph.nodes[node[3]];
  if (!fixed || fixed[0] !== "shared") throw new Error("Missing fixed lane reference");
  const lane = sender.service.lanes!.open({ buffer: sender.service.read({ id: fixed[1], byteLength: fixed[2] }), poolIndex: node[1].poolIndex }, node[1].side === 0 ? 1 : 0);
  lane.reserve("{")!.commit();
  expect(() => receiver.runtime.receiveMessageOnPort(target)).toThrow();
  expect(() => receiver.runtime.receiveMessageOnPort(target)).toThrow();
  const buffer = new ArrayBuffer(8);
  expect(() => source.postMessage(buffer, [buffer])).toThrow("closed");
  expect(buffer.byteLength).toBe(8);
});


for (const fault of ["descriptor-copy", "generation-write"] as const) test(`${fault} preparation failure preserves transfers and permits large reuse`, async () => {
  let reject = false;
  const lane = await sourceLane({
    subarray(length) { if (reject && fault === "descriptor-copy" && length === 12) throw new RangeError("descriptor preparation failed"); },
    write(value) { if (reject && fault === "generation-write" && value === 2) throw new RangeError("descriptor preparation failed"); },
  });
  let grant: import("../web/src/shared-objects/protocol").SharedPoolGrant | undefined;
  const { sender, receiver, source, target, graph } = await connection({
    grant(value) { grant = value; return value; },
    lane(backing, side, pool) {
      const overflow = backing.poolIndex === null || !pool ? undefined : { control: new Int32Array(pool.control), index: backing.poolIndex, slots: pool.overflow?.slots[backing.poolIndex] ?? null };
      return lane.openSharedLane(backing.buffer, side, overflow);
    },
  });
  const node = graph.nodes.find(node => node[0] === "port" && node.length === 4);
  if (!grant || !node || node[0] !== "port" || node.length !== 4 || node[1].poolIndex === null) throw new Error("Missing pooled snapshot");
  const control = new Int32Array(grant.control), word = slotWord(node[1].poolIndex, node[1].side);
  const text = "x".repeat(1100000);
  source.postMessage(text);
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  const charged = Atomics.load(control, poolChargedWord);
  expect(charged).toBeGreaterThan(text.length);
  const carried = new sender.runtime.MessageChannel(), buffer = new ArrayBuffer(8);
  cleanup.add(() => { carried.port1.close(); carried.port2.close(); });
  source.postMessage("before");
  reject = true;
  expect(() => source.postMessage({ text, buffer, port: carried.port2 }, [buffer, carried.port2])).toThrow("descriptor preparation failed");
  reject = false;
  expect(Atomics.load(control, word) & 3).toBe(0);
  expect(Atomics.load(control, word + 2)).toBe(0);
  expect(Atomics.load(control, poolChargedWord)).toBe(charged);
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspect().staged).toBe(0);
  carried.port2.postMessage("still owned");
  expect(sender.runtime.receiveMessageOnPort(carried.port1)).toEqual({ message: "still owned" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "before" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  source.postMessage(text);
  source.postMessage("after");
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: text });
  expect(receiver.runtime.receiveMessageOnPort(target)).toEqual({ message: "after" });
  expect(receiver.runtime.receiveMessageOnPort(target)).toBeUndefined();
  expect(Atomics.load(control, word) & 3).toBe(0);
  expect(Atomics.load(control, poolChargedWord)).toBe(charged);
});
