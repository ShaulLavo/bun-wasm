import { afterEach, expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects, exportSharedObjects } from "../web/src/shared-objects/service";
import type { SharedPort, SharedRequest, SharedResponse } from "../web/src/shared-objects/protocol";
import { sourceCodec, sourcePorts } from "./fixtures/shared-objects/source-runtime";

const cleanup = new Set<() => void>();
afterEach(() => { for (const close of cleanup) close(); cleanup.clear(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function setup() {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  function client(wrap: (port: MessagePort) => SharedPort = port => port) {
    const lease = broker.register();
    const channel = new MessageChannel();
    cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
    lease.attach(channel.port2);
    const service = createSharedObjects(lease.id, wrap(channel.port1));
    cleanup.add(service.close);
    return { lease, service };
  }
  return { broker, client };
}
function intercept(port: SharedPort, send: (packet: SharedRequest | SharedResponse) => void): SharedPort {
  return { postMessage: send, start: () => port.start(), close: () => port.close(),
    addEventListener: (type, listener) => port.addEventListener(type, listener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener) };
}

test("publication is staged, abortable and absent-service SAB stays rejected", async () => {
  const { broker, client } = setup();
  const { service } = client();
  const codec = sourceCodec(service);
  const sab = new SharedArrayBuffer(16);
  expect(() => sourceCodec().encode(sab)).toThrow();
  expect(() => sourceCodec().decode({ root: 0, nodes: [["shared", "owner/id", 16]] })).toThrow();
  const plan = codec.prepare({ sab, alias: sab, view: new Int32Array(sab, 4, 2) });
  expect(service.inspect().staged).toBe(1);
  expect(broker.inspect().objects).toBe(0);
  plan.abort();
  expect(service.inspect().staged).toBe(0);
  expect(() => codec.prepare({ sab, bad() {} })).toThrow();
  expect(service.inspect().staged).toBe(0);
  await tick();
  expect(broker.inspect().objects).toBe(0);
});

test("native port preserves backing aliases, views and identity across messages", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client();
  const sab = new SharedArrayBuffer(16);
  const first = sourceCodec(sender.service).encode({ sab, alias: sab, view: new Int32Array(sab, 4, 2) });
  const codec = sourceCodec(receiver.service);
  await new Promise<void>(resolve => codec.wait(first, resolve));
  const value = codec.decode(first);
  if (!value || typeof value !== "object" || !("sab" in value) || !(value.sab instanceof SharedArrayBuffer)
    || !("alias" in value) || !(value.alias instanceof SharedArrayBuffer) || !("view" in value) || !(value.view instanceof Int32Array)) throw new Error("Invalid shared graph result");
  expect(value.sab).toBe(value.alias);
  expect(value.view.buffer).toBe(value.sab);
  expect(value.view.byteOffset).toBe(4);
  Atomics.store(value.view, 0, 42);
  expect(Atomics.load(new Int32Array(sab), 1)).toBe(42);
  const second = sourceCodec(sender.service).encode(sab);
  expect(codec.wait(second, () => { throw new Error("Already attached"); })).toBeNull();
  expect(codec.decode(second)).toBe(value.sab);
  expect(broker.inspect().objects).toBe(1);
  sender.service.close(); receiver.service.close();
  await tick();
  expect(broker.inspect().objects).toBe(0);
  expect(Atomics.load(value.view, 0)).toBe(42);
});

test("publication and delivery failure leave transfers attached and staged refs zero", async () => {
  const { broker, client } = setup();
  const sender = client(port => intercept(port, packet => {
    if (packet.kind === "publish") throw new Error("publish failed");
    port.postMessage(packet);
  }));
  const codec = sourceCodec(sender.service);
  const buffer = new ArrayBuffer(8), sab = new SharedArrayBuffer(8);
  expect(() => codec.prepare({ buffer, sab }, [buffer]).commit()).toThrow("publish failed");
  expect(buffer.byteLength).toBe(8);
  expect(sender.service.inspect().staged).toBe(0);
  const other = client();
  expect(() => sourceCodec(other.service).prepare({ sab, buffer }, [buffer]).commit(() => { throw new Error("send failed"); })).toThrow("send failed");
  expect(buffer.byteLength).toBe(8);
  expect(other.service.inspect()).toMatchObject({ staged: 0, buffers: 0 });
  await tick();
  expect(broker.inspect().objects).toBe(0);
});

test("failed transaction does not revoke an earlier committed identity", async () => {
  const { broker, client } = setup();
  const { service } = client();
  const codec = sourceCodec(service), sab = new SharedArrayBuffer(8);
  const first = codec.encode(sab);
  expect(() => codec.prepare(sab).commit(() => { throw new Error("send failed"); })).toThrow();
  expect(codec.decode(first)).toBe(sab);
  await tick();
  expect(broker.inspect().objects).toBe(1);
});

test("ready/missing/ready source-port queue drains exactly once in order", async () => {
  const { client } = setup();
  const { service } = client();
  const runtime = sourcePorts({ sharedObjects: service });
  const { port1, port2 } = new runtime.MessageChannel();
  cleanup.add(() => { port1.close(); port2.close(); });
  const external = client();
  const sab = new SharedArrayBuffer(8);
  const plan = sourceCodec(external.service).prepare({ data: sab, ports: [] });
  const graph = plan.graph;
  const received: unknown[] = [];
  port2.on("message", value => received.push(value));
  runtime.__fixturePacket(port2, 0, runtime.codec.encode({ data: "first", ports: [] }));
  runtime.__fixturePacket(port2, 1, graph);
  runtime.__fixturePacket(port2, 2, runtime.codec.encode({ data: "third", ports: [] }));
  await tick();
  expect(received).toEqual(["first"]);
  plan.commit();
  await tick(); await tick();
  expect(received[0]).toBe("first");
  expect(received[1]).toBeInstanceOf(SharedArrayBuffer);
  expect(received[2]).toBe("third");
  expect(received.length).toBe(3);
  expect(service.inspect().pending).toBe(0);
});

test("service and broker close cancel waits once and release all owned references", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client();
  const staged = sender.service.begin();
  const reference = staged.reference(new SharedArrayBuffer(8));
  let wakeups = 0;
  receiver.service.wait([reference], () => wakeups++);
  await tick();
  expect(broker.inspect().waiting).toBe(1);
  sender.lease.close();
  await tick();
  expect(wakeups).toBe(1);
  expect(() => receiver.service.read(reference)).toThrow();
  receiver.service.close(); broker.dispose(); broker.dispose();
  expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(receiver.service.inspect()).toEqual({ buffers: 0, pending: 0, staged: 0, closed: true });
});

test("own native host exports its live port and closes failed export", () => {
  let received: MessagePort | undefined;
  const service = exportSharedObjects("owner", { postMessage(message, transfer) {
    expect(transfer).toEqual([message.port]); received = message.port;
  } });
  cleanup.add(service.close); cleanup.add(() => received?.close());
  expect(received).toBeDefined();
  expect(() => exportSharedObjects("owner", { postMessage() { throw new Error("export failed"); } })).toThrow("export failed");
});

test("local source-port transfer retains the new endpoint and detached sender semantics", async () => {
  const { client } = setup();
  const { service } = client();
  const runtime = sourcePorts({ sharedObjects: service });
  const transport = new runtime.MessageChannel(), reply = new runtime.MessageChannel();
  cleanup.add(() => { transport.port1.close(); transport.port2.close(); reply.port1.close(); reply.port2.close(); });
  transport.port1.postMessage({ port: reply.port2 }, [reply.port2]);
  const received = runtime.receiveMessageOnPort(transport.port2)?.message;
  if (!received || typeof received !== "object" || !("port" in received)) throw new Error("Missing transferred port");
  reply.port2.postMessage("detached");
  expect(runtime.receiveMessageOnPort(reply.port1)).toBeUndefined();
  const port = received.port as typeof reply.port2;
  cleanup.add(() => port.close());
  port.postMessage("answer");
  expect(runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "answer" });
  reply.port1.postMessage("second");
  expect(runtime.receiveMessageOnPort(port)).toEqual({ message: "second" });
  await tick();
});

test("exact esbuild source call wakes across real native workers after 80ms backing delay", async () => {
  const { Worker, MessagePort: NativeMessagePort } = await import("node:worker_threads");
  const { PipeController } = await import("../node_modules/waffle/proc/pipes.ts");
  const { readFileSync } = await import("node:fs");
  const { once } = await import("node:events");
  const { broker } = setup();
  const first = new PipeController({ capacity: 65536 }), second = new PipeController({ capacity: 65536 });
  const endpoints = [first.retain(1, "write"), first.retain(2, "read"), second.retain(2, "write"), second.retain(1, "read")] as const;
  const workers: InstanceType<typeof Worker>[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const nativePorts = new Set<import("node:worker_threads").MessagePort>();
  const states: unknown[] = [];
  let decoded = 0;
  const { promise: done, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  let receiver: InstanceType<typeof Worker> | undefined;
  function attach(lease: ReturnType<typeof broker.register>, port: import("node:worker_threads").MessagePort, delay: boolean) {
    nativePorts.add(port);
    lease.attach(intercept(port, packet => {
      if (packet.kind !== "attached" || !delay) { port.postMessage(packet); return; }
      const timer = setTimeout(() => { timers.delete(timer); port.postMessage(packet); }, 80);
      timers.add(timer);
    }));
  }
  function message(lease: ReturnType<typeof broker.register>, role: string, value: Record<string, unknown>) {
    if (value.type === "bun-shared-connect") {
      if (value.owner !== lease.id || !(value.port instanceof NativeMessagePort)) throw new Error("Invalid exported native port");
      attach(lease, value.port, role === "receiver"); return;
    }
    if (value.kind === "initial") { receiver!.postMessage(value); return; }
    if (value.kind === "ready") {
      const sender = workers[1];
      if (!sender) throw new Error("Missing sender");
      sender.postMessage({ kind: "run" }); return;
    }
    if (value.kind === "result") { resolve(value); return; }
    if (value.kind === "cleanup") { states.push(value.state); return; }
    if (value.kind !== "decoded") throw new Error("Unknown fixture message");
    decoded++;
  }
  const timeout = Promise.withResolvers<never>();
  const deadline = setTimeout(() => timeout.reject(new Error("Source atomic fixture exceeded 5 seconds")), 5000);
  try {
    const exact = readFileSync(new URL("./fixtures/shared-objects/esbuild-run-call-sync.txt", import.meta.url), "utf8");
    for (const role of ["receiver", "sender"]) {
      const lease = broker.register();
      const worker = new Worker(new URL("./fixtures/shared-objects/atomic-worker.ts", import.meta.url), { workerData: {
        owner: lease.id, role, exact, input: endpoints[role === "sender" ? 3 : 1].handle(), output: endpoints[role === "sender" ? 0 : 2].handle(),
      } });
      workers.push(worker);
      if (role === "receiver") receiver = worker;
      worker.on("error", reject);
      worker.on("message", value => { try { message(lease, role, value); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); } });
      worker.once("exit", () => lease.close());
    }
    const result = await Promise.race([done, timeout.promise]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(75);
    expect(result.exactValue).toBe(42);
    expect(result.aliasValue).toBe(73);
    expect(result.senderTimer).toBe(false);
    expect(result.callbacksWhileBlocked).toBe(0);
    const exits = workers.map(worker => once(worker, "exit"));
    for (const worker of workers) worker.postMessage({ kind: "stop" });
    expect(await Promise.race([Promise.all(exits), timeout.promise])).toEqual([[0], [0]]);
    expect(states).toEqual([{ buffers: 0, pending: 0, staged: 0, closed: true }, { buffers: 0, pending: 0, staged: 0, closed: true }]);
    expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    expect(decoded).toBe(2);
    console.info(JSON.stringify({ sourceAtomic: result, decoded, cleanup: broker.inspect() }));
  } finally {
    clearTimeout(deadline);
    for (const timer of timers) clearTimeout(timer);
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const port of nativePorts) port.close();
    for (const endpoint of endpoints) endpoint.close();
    first.dispose(); second.dispose(); broker.dispose();
  }
}, 7000);

test("closing a source receiver cancels only its missing attachment subscription", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client();
  const runtime = sourcePorts({ sharedObjects: receiver.service });
  const { port1, port2 } = new runtime.MessageChannel();
  cleanup.add(() => { port1.close(); port2.close(); });
  const plan = sourceCodec(sender.service).prepare({ data: new SharedArrayBuffer(8), ports: [] });
  const messages: unknown[] = [];
  port2.on("message", value => messages.push(value));
  runtime.__fixturePacket(port2, 0, plan.graph);
  await tick();
  expect(broker.inspect().waiting).toBe(1);
  port2.close();
  await tick();
  expect(receiver.service.inspect().pending).toBe(0);
  expect(broker.inspect().waiting).toBe(0);
  plan.commit();
  await tick();
  expect(messages).toEqual([]);
  expect(receiver.service.inspect().buffers).toBe(0);
});

test("transfer validation keeps SAB, port and ArrayBuffer attached on rejected graphs and native publication", async () => {
  const { broker, client } = setup();
  const { service } = client(port => intercept(port, packet => {
    if (packet.kind === "publish") throw new Error("native publication failed");
    port.postMessage(packet);
  }));
  const runtime = sourcePorts({ sharedObjects: service });
  const transport = new runtime.MessageChannel(), reply = new runtime.MessageChannel();
  cleanup.add(() => { transport.port1.close(); transport.port2.close(); reply.port1.close(); reply.port2.close(); });
  const sab = new SharedArrayBuffer(8), buffer = new ArrayBuffer(8);
  expect(() => transport.port1.postMessage({ sab, port: reply.port2, buffer }, [reply.port2, buffer, buffer])).toThrow("duplicate");
  expect(() => transport.port1.postMessage({ sab, port: reply.port2, bad() {} }, [reply.port2, buffer])).toThrow();
  expect(() => transport.port1.postMessage({ sab, port: reply.port2, buffer }, [reply.port2, buffer])).toThrow("native publication failed");
  expect(buffer.byteLength).toBe(8);
  expect(runtime.receiveMessageOnPort(transport.port2)).toBeUndefined();
  reply.port2.postMessage("still attached");
  expect(runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "still attached" });
  expect(service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
  await tick();
  expect(broker.inspect().objects).toBe(0);
});

test("a missing shared backing rejects decoding before any port restoration", () => {
  const { client } = setup();
  const { service } = client();
  let restored = 0;
  const codec = sourceCodec(service, { isPort: () => false, prepare() { throw new Error("Unexpected transfer"); },
    restore() { restored++; }, activate() {} });
  const snapshot = { id: "a", peer: "b", version: 1, sent: 0, received: 0, pending: [], closing: null, closed: false };
  expect(() => codec.decode({ root: 0, nodes: [["array", 2, [["0", 1], ["1", 2]]], ["port", snapshot, 3], ["shared", "unknown/id", 8], ["array", 0, []]] })).toThrow("not attached");
  expect(restored).toBe(0);
});

test("aborted publication cannot be acquired again but delivered native aliases remain live", async () => {
  const { broker, client } = setup();
  const sender = client(), receiver = client(), late = client();
  const publication = sender.service.begin(), sab = new SharedArrayBuffer(8);
  const reference = publication.reference(sab);
  publication.publish();
  await new Promise<void>(resolve => receiver.service.wait([reference], resolve));
  const delivered = receiver.service.read(reference);
  publication.abort();
  await tick();
  await new Promise<void>(resolve => late.service.wait([reference], resolve));
  expect(() => late.service.read(reference)).toThrow("released");
  Atomics.store(new Int32Array(delivered), 0, 42);
  expect(Atomics.load(new Int32Array(sab), 0)).toBe(42);
  expect(broker.inspect().objects).toBe(1);
  receiver.service.close(); await tick();
  expect(broker.inspect().objects).toBe(0);
});

test("concurrent reservation of the same backing rejects without corrupting an earlier plan", async () => {
  const { client } = setup();
  const { service } = client();
  const codec = sourceCodec(service), sab = new SharedArrayBuffer(8);
  const first = codec.prepare(sab);
  expect(() => codec.prepare(sab)).toThrow("pending publication");
  expect(service.inspect().staged).toBe(1);
  first.commit();
  expect(codec.decode(first.graph)).toBe(sab);
  await tick();
});

test("a thrown source delivery aborts publication without detaching port or buffer", async () => {
  const { broker, client } = setup();
  const { service } = client();
  const runtime = sourcePorts({ sharedObjects: service });
  const control = new runtime.MessageChannel(), reply = new runtime.MessageChannel();
  cleanup.add(() => { control.port1.close(); control.port2.close(); reply.port1.close(); reply.port2.close(); });
  const graph = runtime.codec.encode(control.port2, [control.port2]);
  const transferred = graph.nodes.find(node => node[0] === "port");
  if (!transferred || transferred[0] !== "port") throw new Error("Missing port snapshot");
  let bound = false, failSend = true;
  runtime.__fixtureChild({ send() { if (failSend) throw new Error("byte graph send failed"); },
    pump(receive) {
      if (bound) return false;
      bound = true;
      receive({ kind: "up", body: { kind: "bind", snapshot: transferred[1], owner: [0] } });
      return true;
    }, subscriptions: () => new Uint8Array(), drain() {}, close() {}, waitReadable() {}, pending: false, ended: false }, graph);
  runtime.pump();
  const sab = new SharedArrayBuffer(8), buffer = new ArrayBuffer(8);
  expect(() => control.port1.postMessage({ sab, buffer, port: reply.port2 }, [buffer, reply.port2])).toThrow("byte graph send failed");
  failSend = false;
  expect(buffer.byteLength).toBe(8);
  reply.port2.postMessage("still attached");
  expect(runtime.receiveMessageOnPort(reply.port1)).toEqual({ message: "still attached" });
  expect(service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
  await tick();
  expect(broker.inspect().objects).toBe(0);
});
