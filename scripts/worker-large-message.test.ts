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

async function connection() {
  const { client } = brokerClients(cleanup, { lanes: true });
  const sender = client(), receiver = client();
  await Promise.all([sender.service.ready, receiver.service.ready]);
  const channel = new sender.runtime.MessageChannel();
  cleanup.add(() => channel.port1.close());
  const target = await restore(sender.runtime.codec.encode(channel.port2, [channel.port2]), receiver);
  return { sender, receiver, source: channel.port1, target };
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
