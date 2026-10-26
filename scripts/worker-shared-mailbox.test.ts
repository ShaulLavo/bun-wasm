import { afterEach, expect, test } from "bun:test";
import { createSharedMailbox } from "../web/src/shared-objects/mailbox";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import type { SharedPort, SharedRequest, SharedResponse } from "../web/src/shared-objects/protocol";
const cleanup = new Set<() => void>();
afterEach(() => { for (const close of Array.from(cleanup).reverse()) close(); cleanup.clear(); });
function client(broker: ReturnType<typeof createSharedObjectBroker>) {
  const lease = broker.register();
  const channel = new MessageChannel();
  const port: SharedPort = { postMessage(packet: SharedRequest | SharedResponse) { channel.port2.postMessage(packet); }, start: () => channel.port2.start(), close: () => channel.port2.close(),
    addEventListener: (type, listener) => channel.port2.addEventListener(type, listener), removeEventListener: (type, listener) => channel.port2.removeEventListener(type, listener) };
  lease.attach(port);
  const service = createSharedObjects(lease.id, channel.port1);
  cleanup.add(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
  return service;
}

test("mailbox carries source-shaped port bytes before notification", () => {
  const mailbox = createSharedMailbox();
  cleanup.add(mailbox.close);
  const packet = { kind: "port-data", id: "[]:1", from: "mailbox", sequence: 0, graph: { root: 0, nodes: [["object", [["answer", 1]]], ["number", "42"]] } };
  expect(mailbox.write(new TextEncoder().encode(JSON.stringify(packet)))).toBe(true);
  const received: unknown[] = [];
  expect(mailbox.drain(bytes => received.push(JSON.parse(new TextDecoder().decode(bytes))))).toBe(1);
  expect(received).toEqual([packet]);
});

test("broker registers a stable endpoint and commits route bytes before drain", async () => {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  const sender = client(broker), receiver = client(broker);
  sender.routes?.enable(); receiver.routes?.enable();
  receiver.routes?.send({ kind: "bind", snapshot: { id: "receiver:1", peer: null, version: 0, sent: 0 } });
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const packet = { kind: "port-data", id: "receiver:1", from: "sender:1", sequence: 0, graph: { root: 0, nodes: [["object", [["answer", 1]]], ["number", "42"]] } };
  sender.routes?.send(packet);
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const received: unknown[] = [];
  expect(receiver.mailbox?.drain(bytes => received.push(JSON.parse(new TextDecoder().decode(bytes))))).toBe(1);
  expect(received).toEqual([packet]);
  expect(broker.inspect()).toEqual({ clients: 2, objects: 0, waiting: 0 });
  receiver.close();
  expect(receiver.mailbox?.inspect()).toEqual({ queued: 0, closed: true });
});

test("mailbox applies bounded backpressure and closes without replacing its buffer", () => {
  const mailbox = createSharedMailbox();
  cleanup.add(mailbox.close);
  const buffer = mailbox.buffer;
  const frame = new Uint8Array(8 * 1024 - 4);
  let accepted = 0;
  while (mailbox.write(frame)) accepted++;
  expect(accepted).toBe(8);
  expect(mailbox.write(frame)).toBe(false);
  expect(mailbox.inspect()).toEqual({ queued: 8, closed: false });
  let drained = 0;
  expect(mailbox.drain(() => { drained++; })).toBe(8);
  expect(drained).toBe(8);
  mailbox.close();
  expect(mailbox.buffer).toBe(buffer);
  expect(mailbox.write(frame)).toBe(false);
  expect(mailbox.inspect()).toEqual({ queued: 0, closed: true });
});
