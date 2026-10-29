import { expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import type { SharedResponse } from "../web/src/shared-objects/protocol";
import { testCleanup, tick } from "./fixtures/shared-objects/broker-clients";

const cleanup = testCleanup();
function setup() {
  const broker = createSharedObjectBroker(); cleanup.add(broker.dispose);
  function client(hold = false) {
    const lease = broker.register(), channel = new MessageChannel();
    const replies: Extract<SharedResponse, { kind: "attached" }>[] = [];
    lease.attach({
      postMessage(packet) {
        if (hold && packet.kind === "attached") { replies.push(packet); return; }
        channel.port2.postMessage(packet);
      },
      addEventListener: (type, listener) => channel.port2.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port2.removeEventListener(type, listener),
      start: () => channel.port2.start(), close: () => channel.port2.close(),
    });
    const service = createSharedObjects(lease.id, channel.port1);
    cleanup.add(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
    return { lease, service, replies, deliver(packet: SharedResponse) { channel.port2.postMessage(packet); } };
  }
  return { broker, client };
}
const makers = {
  sab: () => new SharedArrayBuffer(8),
  module: () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
  memory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
};
for (const [kind, make] of Object.entries(makers)) {
  test(`${kind}: port discard releases a delivered but unaccepted pin while receiver stays alive`, async () => {
    const { broker, client } = setup();
    const sender = client(), receiver = client(true), publication = sender.service.begin();
    const value = make();
    const reference = value instanceof SharedArrayBuffer ? publication.reference(value) : publication.referenceWasm?.(value);
    if (!reference) throw new Error("Missing native capability");
    publication.publish();
    let ready = 0;
    const cancel = receiver.service.wait([reference], () => ready++);
    await tick();
    expect(receiver.replies).toHaveLength(1);
    cancel?.(); cancel?.();
    sender.lease.close(); await tick();
    expect(broker.inspect().objects).toBe(0);
    expect(broker.inspectTransfers()).toEqual({ pins: 0, attaching: 0 });
    receiver.deliver(receiver.replies[0]!); await tick();
    expect(ready).toBe(0);
    expect(receiver.service.inspect()).toMatchObject({ buffers: 0, pending: 0 });
    expect(broker.inspect().clients).toBe(1);
  });
}

test("stale attachment cannot satisfy a new message wait or cancel its accepted alias", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client(true), publication = sender.service.begin();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const reference = publication.referenceWasm?.(memory);
  if (!reference) throw new Error("Missing native capability");
  publication.publish();
  let first = 0, second = 0;
  const cancel = receiver.service.wait([reference], () => first++);
  await tick(); cancel?.(); await tick();
  receiver.service.wait([reference], () => second++); await tick();
  expect(receiver.replies).toHaveLength(2);
  receiver.deliver(receiver.replies[0]!); await tick();
  expect(second).toBe(0);
  expect(receiver.service.inspect().pending).toBe(1);
  receiver.deliver(receiver.replies[1]!); await tick();
  expect(first).toBe(0); expect(second).toBe(1);
  expect(broker.inspectTransfers()).toEqual({ pins: 0, attaching: 0 });
  cancel?.(); sender.lease.close(); await tick();
  const alias = receiver.service.readWasm?.(reference);
  if (!(alias instanceof WebAssembly.Memory)) throw new Error("Missing native memory");
  Atomics.store(new Int32Array(alias.buffer), 0, 42);
  expect(Atomics.load(new Int32Array(memory.buffer), 0)).toBe(42);
  receiver.lease.close(); await tick();
  expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
});

test("receiver exit reaps in-flight attachment pins without waiting for broker disposal", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client(true), publication = sender.service.begin();
  const reference = publication.reference(new SharedArrayBuffer(8));
  publication.publish(); receiver.service.wait([reference], () => {});
  await tick(); sender.lease.close(); await tick();
  expect(broker.inspectTransfers()).toEqual({ pins: 1, attaching: 1 });
  receiver.lease.close(); receiver.lease.close();
  const replacement = client();
  expect(broker.inspect()).toEqual({ clients: 1, objects: 0, waiting: 0 });
  expect(broker.inspectTransfers()).toEqual({ pins: 0, attaching: 0 });
  expect(replacement.lease.id).not.toBe(receiver.lease.id);
});

test("publication rollback and duplicate cancellation release the same in-flight attachment once", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client(true), publication = sender.service.begin();
  const reference = publication.reference(new SharedArrayBuffer(8));
  publication.publish();
  const cancel = receiver.service.wait([reference], () => {});
  await tick(); publication.abort(); publication.abort(); await tick();
  cancel?.(); cancel?.(); await tick();
  expect(broker.inspect().objects).toBe(0);
  expect(broker.inspectTransfers()).toEqual({ pins: 0, attaching: 0 });
  expect(broker.inspect().clients).toBe(2);
});
