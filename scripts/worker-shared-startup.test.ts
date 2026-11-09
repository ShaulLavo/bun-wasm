import { afterEach, expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import type { SharedPort, SharedRequest, SharedResponse } from "../web/src/shared-objects/protocol";
import { sourceCodec, sourcePorts, sourceV8 } from "./fixtures/shared-objects/source-runtime";
import { startupRuntime } from "./fixtures/shared-objects/startup-runtime";
import type { Channel } from "./fixtures/shared-objects/runtime-types";

const cleanup = new Set<() => void>();
afterEach(() => { for (const close of Array.from(cleanup).reverse()) close(); cleanup.clear(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function setup() {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  return { broker, client: (delay = false) => sharedClient(broker, delay) };
}
function sharedClient(broker: ReturnType<typeof createSharedObjectBroker>, delay = false) {
  const lease = broker.register(), channel = new MessageChannel();
  const packets: (SharedRequest | SharedResponse)[] = [];
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  const port: SharedPort = { postMessage(packet) {
    if (delay && packet.kind === "attached") { packets.push(packet); return; }
    channel.port2.postMessage(packet);
  }, start: () => channel.port2.start(), close: () => channel.port2.close(),
  addEventListener: (type, listener) => channel.port2.addEventListener(type, listener),
  removeEventListener: (type, listener) => channel.port2.removeEventListener(type, listener) };
  lease.attach(port);
  const service = createSharedObjects(lease.id, channel.port1);
  cleanup.add(service.close);
  return { lease, service, deliver() { for (const packet of packets.splice(0)) channel.port2.postMessage(packet); } };
}
function initialGraph(sender: ReturnType<typeof sourcePorts>, data: unknown, environment: unknown[] = []) {
  const parent = new sender.MessageChannel();
  cleanup.add(() => { parent.port1.close(); parent.port2.close(); });
  return sender.codec.prepare([data, environment, parent.port2], [parent.port2]);
}
function start(graph: Parameters<typeof startupRuntime>[0]["graph"], service?: Parameters<typeof startupRuntime>[0]["service"], extra = {}) {
  const value = startupRuntime({ graph, service, ...extra });
  cleanup.add(() => value.host.exit(0));
  value.host.start();
  return value;
}

test("installed service does not grant shared permission to direct codecs, clones, errors or broadcast", async () => {
  const { client } = setup(), sender = client(), receiver = client();
  const runtime = sourcePorts({ sharedObjects: receiver.service });
  const sab = new SharedArrayBuffer(16), graph = sourceCodec(sender.service).encode(sab);
  await new Promise<void>(resolve => runtime.codec.wait(graph, resolve));
  const hooks = { isPort: () => false, prepare() { throw new Error("Unexpected transfer"); }, restore() {}, activate() {} };
  const strict = sourceCodec(receiver.service, { ...hooks, sharedObjects: undefined });
  expect(() => strict.decode(graph)).toThrow();
  expect(() => strict.wait(graph, () => {})).toThrow();
  expect(() => strict.encode(sab)).toThrow();
  const v8 = sourceV8(receiver.service);
  expect(() => v8.serialize(sab)).toThrow();
  const bytes = Buffer.from("bun-wasm:structured\0" + JSON.stringify(graph));
  expect(() => v8.deserialize(bytes)).toThrow();
  expect(() => runtime.internal.clonePorts?.(sab, {})).toThrow();
  expect(runtime.internal.workerErrorData?.(new Error("not cloneable", { cause: sab })).code).toBe("ERR_WORKER_UNSERIALIZABLE_ERROR");
  const child = new runtime.MessageChannel(), transfer = runtime.codec.encode(child.port2, [child.port2]);
  cleanup.add(() => child.port1.close());
  runtime.__fixtureChild({ send() {}, pump: () => false, subscriptions: () => new Uint8Array(), close() {}, drain() {}, pending: false, ended: false }, transfer);
  const channel = new runtime.BroadcastChannel("strict");
  cleanup.add(() => channel.close());
  expect(() => channel.postMessage(sab)).toThrow();
  expect(receiver.service.inspect().staged).toBe(0);
});

test("actual bootstrap and engine gate delay workerData/environmentData and transferred-port aliases", async () => {
  const { broker, client } = setup(), sender = client(), receiver = client(true);
  const runtime = sourcePorts({ sharedObjects: sender.service }), sab = new SharedArrayBuffer(16);
  const ports = new runtime.MessageChannel();
  cleanup.add(() => { ports.port1.close(); ports.port2.close(); });
  ports.port1.postMessage({ sab, view: new Int32Array(sab, 4, 2) });
  const data = { sab, alias: sab, view: new Int32Array(sab, 4, 2), port: ports.port2 };
  const control = new runtime.MessageChannel();
  cleanup.add(() => { control.port1.close(); control.port2.close(); });
  const plan = runtime.codec.prepare([data, [["shared", sab]], control.port2], [ports.port2, control.port2]);
  plan.commit();
  const f = start(plan.graph, receiver.service, { execArgv: ["--conditions=vitest", "--require=preload"] });
  expect(f.entries).toEqual([]);
  expect(f.preloads).toEqual([]);
  expect(f.frames).toEqual([]);
  const startup = f.internal.workerStartup;
  f.internal.require("worker_threads").initialize();
  expect(f.internal.workerStartup).toBe(startup);
  expect(f.host.pendingAsync).toBe(2);
  expect(f.internal.sharedObjects).toBe(f.host.native.sharedObjects);
  expect(f.internal.require("worker_threads").parentPort).toBeNull();
  await new Promise<void>(resolve => setTimeout(resolve, 80));
  expect(f.entries).toEqual([]);
  receiver.deliver();
  await f.internal.workerStartup?.ready;
  await tick();
  expect(f.entries).toHaveLength(1);
  expect(f.preloads).toEqual(["preload"]);
  expect(f.process.execArgv).toEqual(["--conditions=vitest", "--require=preload"]);
  expect(f.host.pendingAsync).toBe(0);
  const value = f.entries[0];
  if (!value || typeof value !== "object" || !("sab" in value) || !(value.sab instanceof SharedArrayBuffer)
    || !("alias" in value) || !("view" in value) || !(value.view instanceof Int32Array) || !("port" in value)) throw new Error("Invalid startup data");
  expect(value.alias).toBe(value.sab);
  expect(value.view.buffer).toBe(value.sab);
  expect(value.view.byteOffset).toBe(4);
  const threads = f.internal.require("worker_threads");
  expect(threads.getEnvironmentData("shared")).toBe(value.sab);
  if (!value.port || typeof value.port !== "object" || !("close" in value.port) || typeof value.port.close !== "function") throw new Error("Missing startup port");
  const received = threads.receiveMessageOnPort(value.port)?.message;
  if (!received || typeof received !== "object" || !("sab" in received) || !("view" in received) || !(received.view instanceof Int32Array)) throw new Error("Missing queued startup message");
  expect(received.sab).toBe(value.sab);
  expect(received.view.buffer).toBe(value.sab);
  expect(received.view.byteOffset).toBe(4);
  expect(received.view.length).toBe(2);
  expect(threads.receiveMessageOnPort(value.port)).toBeUndefined();
  Atomics.store(value.view, 0, 42);
  expect(Atomics.load(new Int32Array(sab), 1)).toBe(42);
  expect(f.frames.filter(frame => JSON.stringify(frame).includes('"kind":"online"'))).toHaveLength(1);
  f.host.exit(0); f.host.exit(7);
  expect(f.closes).toBe(1);
  expect(f.exits).toEqual([0]);
  expect(receiver.service.inspect()).toMatchObject({ pending: 0, closed: true });
  sender.service.close(); await tick();
  expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
});

test("uninstalled startup stays strict and ordinary data still starts synchronously", () => {
  const sender = sourcePorts(), ordinary = initialGraph(sender, { value: 42 });
  ordinary.commit();
  const f = start(ordinary.graph);
  expect(f.internal.sharedObjects).toBeUndefined();
  expect(f.internal.workerStartup).toBeUndefined();
  expect(f.entries).toEqual([{ value: 42 }]);
  const { client } = setup(), publisher = client();
  const shared = initialGraph(sourcePorts({ sharedObjects: publisher.service }), new SharedArrayBuffer(8));
  shared.commit();
  const rejected = start(shared.graph);
  expect(rejected.entries).toEqual([]);
  expect(rejected.exits).toEqual([70]);
});

for (const failure of ["close", "released", "preload"] as const) test(`startup ${failure} failure never runs entry or publishes online`, async () => {
  const { client } = setup(), sender = client(), receiver = client();
  const plan = initialGraph(sourcePorts({ sharedObjects: sender.service }), new SharedArrayBuffer(8));
  const f = start(plan.graph, receiver.service, { execArgv: failure === "preload" ? ["--require=bad"] : [],
    preload() { throw new Error("preload failed"); } });
  const ready = f.internal.workerStartup?.ready;
  expect(ready).toBeDefined();
  if (failure === "close") receiver.service.close();
  if (failure === "released") sender.service.close();
  if (failure === "preload") plan.commit();
  await expect(ready).rejects.toThrow(); await tick();
  expect(f.entries).toEqual([]);
  expect(f.exits).toEqual([1]);
  expect(f.failures).toHaveLength(1);
  expect(f.closes).toBe(1);
  expect(f.frames.filter(frame => JSON.stringify(frame).includes('"kind":"online"'))).toEqual([]);
  expect(f.host.pendingAsync).toBe(0);
  plan.abort();
});

test("engine exit cancels startup hydration and late attachment cannot revive entry", async () => {
  const { broker, client } = setup(), sender = client(), receiver = client(true);
  const plan = initialGraph(sourcePorts({ sharedObjects: sender.service }), new SharedArrayBuffer(8));
  plan.commit();
  const f = start(plan.graph, receiver.service);
  const ready = f.internal.workerStartup?.ready;
  await tick();
  f.host.exit(143); f.host.exit(0);
  receiver.deliver();
  await expect(ready).rejects.toThrow("cancelled"); await tick();
  expect(f.entries).toEqual([]);
  expect(f.exits).toEqual([143]);
  expect(f.failures).toEqual([]);
  expect(f.closes).toBe(1);
  expect(f.host.pendingAsync).toBe(0);
  expect(broker.inspect().waiting).toBe(0);
});

test("startup retains a readiness notification delivered during subscription", async () => {
  const { client } = setup(), sender = client(), receiver = client();
  const plan = initialGraph(sourcePorts({ sharedObjects: sender.service }), new SharedArrayBuffer(8));
  plan.commit();
  await new Promise<void>(resolve => receiver.service.wait(plan.graph.nodes.flatMap(node => node[0] === "shared" ? [{ id: node[1], byteLength: node[2] }] : []), resolve));
  const immediate: typeof receiver.service = { ...receiver.service, wait(_references, ready) { ready(); return () => {}; } };
  const f = start(plan.graph, immediate);
  await f.internal.workerStartup?.ready;
  await tick();
  expect(f.entries).toHaveLength(1);
  expect(f.host.pendingAsync).toBe(0);
  expect(f.failures).toEqual([]);
  expect(f.frames.filter(frame => JSON.stringify(frame).includes('"kind":"online"'))).toHaveLength(1);
});

function legacyChannel(input: unknown[], output: unknown[]): Channel {
  return {
    send(frame) { output.push(frame); },
    pump(receive) {
      const frames = input.splice(0);
      for (const frame of frames) receive(frame);
      return frames.length > 0;
    },
    subscriptions: () => new Uint8Array(), drain() {}, close() {}, pending: false, ended: false,
  };
}
function legacyWorker() {
  const parent = sourcePorts(), control = new parent.MessageChannel();
  cleanup.add(() => { control.port1.close(); control.port2.close(); });
  const plan = parent.codec.prepare([null, [], control.port2], [control.port2]);
  plan.commit();
  const upward: unknown[] = [], downward: unknown[] = [];
  const parentChannel = legacyChannel(upward, downward), childChannel = legacyChannel(downward, upward);
  parent.__fixtureChild(parentChannel, plan.graph);
  const child = sourcePorts({ channel: childChannel, graph: plan.graph });
  child.initialize(); parent.pump();
  cleanup.add(() => child.parentPort.close());
  const reply = new child.MessageChannel();
  cleanup.add(() => { reply.port1.close(); reply.port2.close(); });
  child.parentPort.postMessage(reply.port1, [reply.port1]);
  const moving = upward.find(isMovingFrame);
  if (!moving) throw new Error("Missing actual legacy transfer commit frame");
  parent.pump();
  const port = parent.receiveMessageOnPort(control.port1)?.message;
  if (!(port instanceof parent.MessagePort)) throw new Error("Missing transferred child port");
  cleanup.add(() => port.close());
  return { parent, child, control, reply, port, moving, childChannel };
}
function isMovingFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== "object" || !("body" in frame)) return false;
  const body = frame.body;
  return Boolean(body && typeof body === "object" && "kind" in body && body.kind === "moving");
}

test("legacy transferred child port keeps its bound owner after the late moving frame", () => {
  const { parent, child, reply, port } = legacyWorker();
  port.postMessage(9); child.pump();
  expect(child.receiveMessageOnPort(reply.port2)).toEqual({ message: 9 });
  reply.port2.postMessage("echo 9"); parent.pump();
  expect(parent.receiveMessageOnPort(port)).toEqual({ message: "echo 9" });
});

test("legacy returned port retains queued replies when its creator exits", () => {
  const { parent, childChannel, reply, port } = legacyWorker();
  reply.port2.postMessage("before exit");
  childChannel.send({ kind: "up", body: { kind: "gone", path: [0] } });
  parent.pump();
  expect(parent.receiveMessageOnPort(port)).toEqual({ message: "before exit" });
  expect(parent.receiveMessageOnPort(port)).toBeUndefined();
});

test("legacy ownership accepts a new transfer version and ignores an older moving replay", () => {
  const { parent, child, control, reply, port, moving, childChannel } = legacyWorker();
  control.port1.postMessage(port, [port]); child.pump(); parent.pump();
  const returned = child.receiveMessageOnPort(child.parentPort)?.message;
  if (!(returned instanceof child.MessagePort)) throw new Error("Missing port transferred back to its creator");
  cleanup.add(() => returned.close());
  child.parentPort.postMessage(returned, [returned]); parent.pump();
  const latest = parent.receiveMessageOnPort(control.port1)?.message;
  if (!(latest instanceof parent.MessagePort)) throw new Error("Missing next-generation port");
  cleanup.add(() => latest.close());
  childChannel.send(moving); parent.pump();
  reply.port2.postMessage("latest owner"); parent.pump();
  expect(parent.receiveMessageOnPort(latest)).toEqual({ message: "latest owner" });
});
