// The pre-attached shared buffer pool and the blocked-receiver boundary, on the actual sources.
// Real worker threads keep the receive truly non-yielding: a guest blocked in Atomics.wait has no
// event loop, so a message it cannot decode must fail by name instead of looking absent.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Worker, MessagePort as NativeMessagePort } from "node:worker_threads";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedLaneBuffer, openSharedLane, sharedLaneBytes } from "../web/src/shared-objects/lane";
import { createSharedObjects } from "../web/src/shared-objects/service";
import { sharedPoolClasses, sharedPoolControlWords, sharedPoolLanes, type SharedPoolGrant, type SharedPort, type SharedResponse } from "../web/src/shared-objects/protocol";
import { sourcePorts } from "./fixtures/shared-objects/source-runtime";
import type { Graph } from "./fixtures/shared-objects/runtime-types";

test("first-party host code allocates only through the captured native constructor", () => {
  // After the guest realm installs its constructor, a bare `new SharedArrayBuffer` in host code
  // would silently spend guest stock. Host allocation goes through shared-objects/native.ts.
  const glob = new Bun.Glob("**/*.{ts,tsx,js}");
  const allowed = ["shared-objects/native.ts", "shared-objects/realm.ts"];
  const bare: string[] = [];
  for (const path of glob.scanSync({ cwd: "web/src" })) {
    if (allowed.includes(path)) continue;
    const text = readFileSync(`web/src/${path}`, "utf8");
    if (/\bnew SharedArrayBuffer\b|globalThis\.SharedArrayBuffer/.test(text)) bare.push(path);
  }
  expect(bare).toEqual([]);
});

const notAttached = "ERR_WORKER_MESSAGE_BACKING_NOT_ATTACHED";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

interface Client { readonly service: ReturnType<typeof createSharedObjects>; close(): void }
function client(broker: ReturnType<typeof createSharedObjectBroker>): Client {
  const lease = broker.register(), channel = new MessageChannel();
  lease.attach(channel.port2);
  const service = createSharedObjects(lease.id, channel.port1);
  return { service, close() { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); } };
}
function pair(grant?: (send: (value: SharedResponse | Record<string, unknown>) => void) => void) {
  const channel = new MessageChannel();
  const port: SharedPort = { postMessage: packet => channel.port1.postMessage(packet), start: () => channel.port1.start(), close: () => channel.port1.close(),
    addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
    removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener) };
  const service = createSharedObjects("member", port);
  grant?.(value => channel.port2.postMessage(value));
  return { service, channel };
}
function validGrant(): SharedPoolGrant {
  return {
    control: new SharedArrayBuffer(sharedPoolControlWords * 4),
    stock: sharedPoolClasses.map(({ bytes, count }) => Array.from({ length: count }, () => new SharedArrayBuffer(bytes))),
    lanes: Array.from({ length: sharedPoolLanes }, createSharedLaneBuffer),
  };
}
async function settled(ready: Promise<void>) {
  return Promise.race([ready.then(() => "resolved", (error: Error) => `rejected: ${error.name}`), new Promise<string>(resolve => setTimeout(() => resolve("pending"), 200))]);
}

test("the pool is a saturating lifetime quota, shared by every member", async () => {
  const broker = createSharedObjectBroker();
  const first = client(broker), second = client(broker);
  await Promise.all([first.service.ready, second.service.ready]);
  const taken = new Set<SharedArrayBuffer>();
  for (let index = 0; index < 32; index++) {
    const buffer = (index % 2 ? first : second).service.claimBuffer(4)!;
    expect(buffer.byteLength).toBe(4);
    expect(buffer.growable).toBe(false);
    taken.add(buffer);
  }
  expect(taken.size).toBe(32);
  expect(first.service.claimBuffer(4)).toBeNull();
  expect(second.service.claimBuffer(4)).toBeNull();
  expect(broker.inspectPool().classes[0]).toBe(32);
  for (let index = 0; index < 16; index++) expect(first.service.claimBuffer(65536)?.byteLength).toBe(65536);
  expect(first.service.claimBuffer(65536)).toBeNull();
  expect(broker.inspectPool().classes.at(-1)).toBe(16);
  expect(first.service.claimBuffer(65537)).toBeNull();
  expect(first.service.claimBuffer(0)).toBeNull();
  expect(first.service.claimBuffer(6)).toBeNull();
  expect(broker.inspectPool().classes.reduce((sum, value) => sum + value)).toBe(48);
  expect(first.service.poolStats()).toEqual({ claims: 16 + 16, refused: 1 + 1 });
  first.close(); second.close(); broker.dispose();
});

test("a late join sees existing claims and shares identity by id", async () => {
  const broker = createSharedObjectBroker();
  const first = client(broker);
  await first.service.ready;
  const buffer = first.service.claimBuffer(8)!;
  const publication = first.service.begin(), reference = publication.reference(buffer);
  publication.publish();
  expect(reference.id).toBe("pool/c1-0");
  const late = client(broker);
  await late.service.ready;
  expect(late.service.claimBuffer(8)).not.toBe(buffer);
  expect(broker.inspectPool().classes[1]).toBe(2);
  // The late member resolves the reference to its own wrapper of the same bytes, with no attachment.
  const attached = late.service.read(reference);
  expect(attached).not.toBe(buffer);
  new Int32Array(buffer)[0] = 41;
  expect(new Int32Array(attached)[0]).toBe(41);
  expect(late.service.wait([reference], () => { throw new Error("A pool reference never waits"); })).toBeNull();
  const forward = late.service.begin();
  expect(forward.reference(attached)).toEqual(reference);
  forward.abort();
  first.close(); late.close(); broker.dispose();
});

test("a native clone alias keeps fixed native semantics, outside pool identity", async () => {
  const broker = createSharedObjectBroker();
  const member = client(broker);
  await member.service.ready;
  const buffer = member.service.claimBuffer(16)!;
  const alias = structuredClone(buffer);
  expect(alias).not.toBe(buffer);
  expect(alias.growable).toBe(false);
  expect(() => (alias as unknown as { grow(n: number): void }).grow(32)).toThrow(TypeError);
  expect(buffer.byteLength).toBe(16);
  new Int32Array(buffer)[1] = 9;
  expect(new Int32Array(alias)[1]).toBe(9);
  const publication = member.service.begin();
  expect(publication.reference(buffer).id).toBe("pool/c3-0");
  expect(publication.reference(alias).id).toMatch(/^member\/|^[\w-]+\/\d+$/);
  publication.abort();
  member.close(); broker.dispose();
});

test("channel lanes are a lifetime quota too: a closed lane is never reused", async () => {
  const broker = createSharedObjectBroker();
  const member = client(broker);
  await member.service.ready;
  const lanes = member.service.lanes!;
  const ids: string[] = [];
  const buffers: SharedArrayBuffer[] = [];
  for (let index = 0; index < sharedPoolLanes; index++) {
    const lane = lanes.create(), publication = member.service.begin();
    ids.push(publication.reference(lane).id); publication.abort();
    buffers.push(lane);
    expect(lane.byteLength).toBe(sharedLaneBytes);
    expect(new Set(buffers).size).toBe(index + 1);
  }
  expect(ids.at(0)).toBe("pool/l0");
  expect(ids.at(-1)).toBe(`pool/l${sharedPoolLanes - 1}`);
  // Both endpoints closing does not return the lane: a queued snapshot could still name it.
  for (const buffer of buffers) { openSharedLane(buffer, 0).close(); openSharedLane(buffer, 1).close(); }
  const overflow = lanes.create(), publication = member.service.begin();
  expect(publication.reference(overflow).id).not.toMatch(/^pool\//);
  publication.abort();
  expect(buffers).not.toContain(overflow);
  expect(broker.inspectPool().lanes).toBe(sharedPoolLanes);
  member.close(); broker.dispose();
});

test("the grant is validated, accepted once, and settles readiness", async () => {
  const good = validGrant();
  const goodStock = good.stock as SharedArrayBuffer[][];
  const cases: { name: string; grant: Partial<SharedPoolGrant> }[] = [
    { name: "control length", grant: { control: new SharedArrayBuffer(4) } },
    { name: "non-shared control", grant: { control: new ArrayBuffer(sharedPoolControlWords * 4) as unknown as SharedArrayBuffer } },
    { name: "growable control", grant: { control: new SharedArrayBuffer(sharedPoolControlWords * 4, { maxByteLength: sharedPoolControlWords * 8 }) } },
    { name: "class count", grant: { stock: good.stock.slice(1) } },
    { name: "class length", grant: { stock: [goodStock[1]!].concat(goodStock.slice(1)) } },
    { name: "growable stock", grant: { stock: [goodStock[0]!.slice(1).concat(new SharedArrayBuffer(4, { maxByteLength: 8 }))].concat(goodStock.slice(1)) } },
    { name: "lane length", grant: { lanes: [new SharedArrayBuffer(4)].concat(good.lanes.slice(1)) } },
    { name: "lane count", grant: { lanes: good.lanes.slice(1) } },
  ];
  for (const { name, grant } of cases) {
    const { service } = pair(send => send({ kind: "pool", grant: { ...good, ...grant } }));
    expect([name, await settled(service.ready)]).toEqual([name, "rejected: DataCloneError"]);
    expect(service.inspect().closed).toBe(true);
    expect(service.claimBuffer(4)).toBeNull();
  }
  const overClaimed = validGrant();
  new Int32Array(overClaimed.control)[0] = 33;
  expect(await settled(pair(send => send({ kind: "pool", grant: overClaimed })).service.ready)).toBe("rejected: DataCloneError");
  const overLane = validGrant();
  new Int32Array(overLane.control)[sharedPoolClasses.length] = sharedPoolLanes + 1;
  expect(await settled(pair(send => send({ kind: "pool", grant: overLane })).service.ready)).toBe("rejected: DataCloneError");
  // Existing claims from a late join are not a validation failure.
  const claimed = validGrant();
  new Int32Array(claimed.control)[0] = 32;
  const late = pair(send => send({ kind: "pool", grant: claimed }));
  expect(await settled(late.service.ready)).toBe("resolved");
  expect(late.service.claimBuffer(4)).toBeNull();
  late.service.close();
  // A second grant ends the service instead of silently changing its table.
  const duplicate = pair(send => { send({ kind: "pool", grant: good }); send({ kind: "pool", grant: good }); });
  await settled(duplicate.service.ready);
  await tick();
  expect(duplicate.service.inspect().closed).toBe(true);
  expect(() => duplicate.service.begin()).toThrow();
});

test("close, messageerror and broker failure reject readiness instead of leaving it pending", async () => {
  const closed = pair();
  closed.service.close();
  expect(await settled(closed.service.ready)).toBe("rejected: DataCloneError");
  expect(closed.service.claimBuffer(4)).toBeNull();
  expect(() => closed.service.begin()).toThrow();

  const remote = pair(send => send({ kind: "closed", message: "Shared-object route is closed" }));
  expect(await settled(remote.service.ready)).toBe("rejected: DataCloneError");

  const channel = new MessageChannel();
  const errored = createSharedObjects("errored", channel.port1);
  channel.port1.dispatchEvent(new MessageEvent("messageerror"));
  expect(await settled(errored.ready)).toBe("rejected: DataCloneError");
  channel.port2.close();

  const broker = createSharedObjectBroker();
  const lease = broker.register();
  lease.attach({ postMessage(packet) { if (packet.kind === "pool") throw new Error("send failed"); }, start() {}, close() {}, addEventListener() {}, removeEventListener() {} });
  expect(broker.inspect().clients).toBe(0);
  broker.dispose();
  expect(broker.inspectPool()).toEqual({ created: false, classes: [], lanes: 0 });
});

test("an invalid wire frame or failed attachment is not the retryable capability error", async () => {
  const broker = createSharedObjectBroker();
  const member = client(broker);
  await member.service.ready;
  const runtime = sourcePorts({ sharedObjects: member.service });
  const { port1, port2 } = new runtime.MessageChannel();
  const failures: unknown[] = [];
  port2.on("messageerror", error => failures.push(error));
  // A structurally invalid frame fails as a message error: no wait is ever armed for it.
  runtime.__fixturePacket(port2, 0, { root: 0, nodes: [["not-a-node"]] } as unknown as Graph);
  await tick();
  expect(runtime.receiveMessageOnPort(port2)).toBeUndefined();
  expect(failures).toHaveLength(1);
  // An unknown publisher: the wait is armed until the broker answers, so a receive before a turn
  // names the capability boundary, and the broker's refusal then lands as a message error.
  runtime.__fixturePacket(port2, 1, { root: 0, nodes: [["shared", "ghost/1", 4]] } as unknown as Graph);
  let code: string | undefined;
  try { runtime.receiveMessageOnPort(port2); } catch (error) { code = (error as { code?: string }).code; }
  expect(code).toBe(notAttached);
  await tick(); await tick();
  expect(runtime.receiveMessageOnPort(port2)).toBeUndefined();
  expect(failures).toHaveLength(2);
  port1.close(); port2.close(); await tick();
  member.close(); broker.dispose();
});

async function runCase(name: string): Promise<Record<string, unknown>> {
  const gate = new SharedArrayBuffer(16), broker = createSharedObjectBroker();
  const workers: Worker[] = [], ports: NativeMessagePort[] = [];
  const result = Promise.withResolvers<Record<string, unknown>>();
  const deadline = setTimeout(() => result.reject(new Error(`${name} timed out`)), 6000);
  const extras: { inner?: unknown; sent?: Record<string, unknown> } = {};
  try {
    const leases = { sender: broker.register(), receiver: broker.register() };
    const file = new URL("./fixtures/shared-objects/pool-receive-worker.ts", import.meta.url);
    const start = (role: "sender" | "receiver") => new Worker(file, { workerData: { owner: leases[role].id, role, gate, name } });
    const sender = start("sender"), receiver = start("receiver");
    workers.push(sender, receiver);
    function onMessage(lease: typeof leases.sender, value: Record<string, unknown>) {
      if (value.type === "bun-shared-connect") { ports.push(value.port as NativeMessagePort); lease.attach(value.port as NativeMessagePort); return; }
      if (value.kind === "initial") { receiver.postMessage({ kind: "restore", graph: value.graph }); return; }
      if (value.kind === "ready") { sender.postMessage({ kind: "run" }); return; }
      if (value.kind === "inner") { extras.inner = value.value; return; }
      if (value.kind === "sent") { extras.sent = value; return; }
      if (value.kind === "sender-may-exit") { void sender.terminate().then(() => { Atomics.store(new Int32Array(gate), 1, 1); Atomics.notify(new Int32Array(gate), 1); }); return; }
      if (value.kind === "result") {
        const resolve = () => result.resolve(value.result as Record<string, unknown>);
        // A reply through a port carried by the frame takes one more sender turn to land.
        if ((value.result as { hasPort?: boolean }).hasPort) setTimeout(resolve, 150); else resolve();
      }
    }
    for (const [worker, lease] of [[sender, leases.sender], [receiver, leases.receiver]] as const) {
      worker.on("message", value => onMessage(lease, value));
      worker.on("error", error => result.reject(error));
    }
    return { ...(await result.promise), ...extras };
  } finally {
    clearTimeout(deadline);
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const port of ports) port.close();
    broker.dispose();
  }
}
const returned = (signal: number) => expect.objectContaining({ outcome: "returned", kind: "message", signal, shared: true });
const named = expect.objectContaining({ outcome: "threw", code: notAttached });

for (const [name, signal] of [["stock4", 4], ["stockCoerced", 8], ["stockOptions", 12], ["stockLast", 65536], ["lastAdmitted", 56], ["preattached", 65537]] as const) {
  test(`${name}: one receive after post-before-notify, no event-loop turn`, async () => {
    expect((await runCase(name)).first).toEqual(returned(signal));
  }, 8000);
}
test("primitive messages stay readable after the receive change", async () => {
  expect((await runCase("primitive")).first).toEqual({ outcome: "returned", kind: "message", v: 7 });
}, 8000);

for (const [name, signal] of [["oversize", 65537], ["native128k", 131072], ["zero", 0], ["growable", 4], ["nativeAlias", 16], ["exhausted", 60]] as const) {
  test(`${name}: the receive fails by name and the frame survives to a later turn`, async () => {
    const result = await runCase(name);
    expect(result.first).toEqual(named);
    expect(result.afterTurn).toEqual(returned(signal));
  }, 8000);
}
test("fresh Memory and Module fail by name, then deliver on a later turn", async () => {
  for (const [name, v] of [["memory", "memory"], ["module", "module"]] as const) {
    const result = await runCase(name);
    expect(result.first).toEqual(named);
    expect(result.afterTurn).toEqual({ outcome: "returned", kind: "message", v });
  }
}, 16000);
test("a frame carrying a transferred port is not partially consumed by the named error", async () => {
  const result = await runCase("transferred");
  expect(result.first).toEqual(named);
  expect(result.afterTurn).toEqual(expect.objectContaining({ kind: "message", v: 9, signal: 131072 }));
  expect(result.hasPort).toBe(true);
  expect(result.inner).toEqual({ v: "viaPort" });
}, 8000);
test("a lane past its quota needs a turn; a port on it still arrives whole and usable", async () => {
  const result = await runCase("laneExhausted");
  expect(result.first).toEqual(named);
  expect(result.afterTurn).toEqual(expect.objectContaining({ kind: "message", v: 33 }));
  expect(result.inner).toEqual({ v: "viaPort" });
}, 8000);
test("a fresh buffer replied on a just-received port is readable in the same turn", async () => {
  const result = await runCase("freshReply");
  expect(result.first).toEqual(expect.objectContaining({ outcome: "returned", kind: "message" }));
  expect(result.reply).toEqual(expect.objectContaining({ kind: "message", v: "reply", signal: 4, shared: true }));
}, 8000);
test("the named error keeps FIFO order around the undeliverable frame", async () => {
  const result = await runCase("fifo");
  expect(result.first).toEqual({ outcome: "returned", kind: "message", v: "before" });
  expect(result.second).toEqual(named);
  expect(result.afterTurn).toEqual(expect.objectContaining({ kind: "message", v: "fresh", signal: 131072 }));
  expect(result.afterTurn2).toEqual({ outcome: "returned", kind: "message", v: "after" });
}, 8000);
test("a stock message outlives its sender exiting before the receive", async () => {
  expect((await runCase("senderExit")).first).toEqual(expect.objectContaining({ kind: "message", v: "survived", signal: 24, shared: true }));
}, 8000);
test("closing the port after a named error makes the next receive plainly empty", async () => {
  const result = await runCase("closeAfterError");
  expect(result.first).toEqual(named);
  expect(result.afterClose).toEqual({ outcome: "returned", kind: "undefined" });
}, 8000);
test("asynchronous delivery of a fresh buffer is unchanged", async () => {
  expect(await runCase("listener")).toEqual(expect.objectContaining({ asyncDelivered: true, signal: 131072 }));
}, 8000);

test("the installed constructor matches native argument order, errors and results", async () => {
  const worker = new Worker(new URL("./fixtures/shared-objects/realm-worker.ts", import.meta.url));
  const result = await new Promise<{ native: Record<string, unknown>; wrapped: Record<string, unknown>; claims: number[]; globalIsWrapper: boolean; globalDescriptor: boolean }>((resolve, reject) => {
    worker.on("message", resolve); worker.on("error", reject);
  });
  await worker.terminate();
  expect(result.wrapped).toEqual(result.native);
  expect(result.globalIsWrapper).toBe(true);
  expect(result.globalDescriptor).toBe(true);
  // Requested-growable and refused lengths never reach the claim; every fixed length does.
  expect(result.claims.filter(length => length === 4).length).toBeGreaterThan(1);
  expect(result.claims).not.toContain(-1);
});
