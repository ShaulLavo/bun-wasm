import { expect, test } from "bun:test";
import { brokerClients, testCleanup, tick } from "./fixtures/shared-objects/broker-clients";
import { sourceCodec } from "./fixtures/shared-objects/source-runtime";

const cleanup = testCleanup();
const moduleBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function values() {
  return { module: new WebAssembly.Module(moduleBytes), memory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }) };
}
function received(value: unknown) {
  if (!value || typeof value !== "object" || !("module" in value) || !(value.module instanceof WebAssembly.Module)
    || !("memory" in value) || !(value.memory instanceof WebAssembly.Memory)) throw new Error("Missing native Wasm objects");
  return { ...value, module: value.module, memory: value.memory };
}

test("native Wasm objects use staged publication, module clone and shared-memory identity", async () => {
  const { broker, client } = brokerClients(cleanup, { lanes: true });
  const sender = client(), receiver = client();
  const input = values();
  const codec = sourceCodec(sender.sharedObjects), target = sourceCodec(receiver.sharedObjects);
  const plan = codec.prepare({ ...input, alias: input.memory, moduleAlias: input.module });
  expect(sender.service.inspect().staged).toBe(1);
  expect(broker.inspect().objects).toBe(0);
  plan.commit();
  await new Promise<void>(resolve => target.wait(plan.graph, resolve));
  const first = received(target.decode(plan.graph));
  expect(first.module).not.toBe(input.module);
  expect("alias" in first && first.alias).toBe(first.memory);
  expect("moduleAlias" in first && first.moduleAlias).toBe(first.module);
  Atomics.store(new Int32Array(first.memory.buffer), 0, 42);
  expect(Atomics.load(new Int32Array(input.memory.buffer), 0)).toBe(42);
  const second = received(target.decode(codec.encode(input)));
  expect(second.memory).toBe(first.memory);
  expect(second.module).not.toBe(first.module);
  expect(WebAssembly.Module.exports(second.module)).toEqual([]);
  sender.service.close(); receiver.service.close(); await tick();
  expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(Atomics.load(new Int32Array(first.memory.buffer), 0)).toBe(42);
});

test("unsupported targets, unshared memory and transfer lists reject native Wasm objects", () => {
  const input = values();
  expect(() => sourceCodec().encode(input)).toThrow();
  const { client } = brokerClients(cleanup, { lanes: true });
  const { sharedObjects, service } = client();
  const codec = sourceCodec(sharedObjects);
  expect(() => codec.encode(new WebAssembly.Memory({ initial: 1 }))).toThrow();
  expect(() => codec.encode(input, [input.module])).toThrow();
  expect(() => codec.encode(input, [input.memory])).toThrow();
  expect(service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
});

test("native Wasm publication rolls back preparation, publish and delivery failures", async () => {
  const { broker, client } = brokerClients(cleanup, { lanes: true });
  const sender = client();
  const codec = sourceCodec(sender.sharedObjects), input = values();
  expect(() => codec.prepare({ ...input, bad() {} })).toThrow();
  expect(sender.service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
  const abandoned = codec.prepare(input); abandoned.abort(); abandoned.abort();
  expect(sender.service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
  expect(() => codec.prepare(input).commit(() => { throw new Error("delivery failed"); })).toThrow("delivery failed");
  const failing = client({ observe(packet) { if (packet.kind === "publish") throw new Error("publication failed"); } });
  expect(() => sourceCodec(failing.sharedObjects).encode(input)).toThrow("publication failed");
  expect(failing.service.inspect()).toMatchObject({ buffers: 0, staged: 0 });
  await tick();
  expect(broker.inspect().objects).toBe(0);
});

test("discarding an unread native Wasm message cancels hydration and exit drops its publications", async () => {
  const { broker, client } = brokerClients(cleanup, { lanes: true });
  const sender = client(), receiver = client();
  const plan = sourceCodec(sender.sharedObjects).prepare({ data: values(), ports: [] });
  const { port1, port2 } = new receiver.runtime.MessageChannel();
  cleanup.add(() => { port1.close(); port2.close(); });
  const seen: unknown[] = [];
  port2.on("message", value => seen.push(value));
  receiver.runtime.__fixturePacket(port2, 0, plan.graph);
  await tick();
  expect(broker.inspect().waiting).toBe(3);
  port2.close(); await tick();
  expect(broker.inspect().waiting).toBe(0);
  expect(receiver.service.inspect().pending).toBe(0);
  plan.commit(); await tick();
  expect(seen).toEqual([]);
  for (const node of plan.graph.nodes) {
    if (node[0] !== "wasm-module" && node[0] !== "wasm-memory") continue;
    expect(() => receiver.sharedObjects.readWasm?.({ id: node[1], byteLength: 0 })).toThrow("not attached");
  }
  sender.service.close(); receiver.service.close(); await tick();
  expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
});

test("a committed native identity survives later rollback and shared Memory may grow in transit", async () => {
  const { broker, client } = brokerClients(cleanup, { lanes: true });
  const sender = client(), receiver = client();
  const codec = sourceCodec(sender.sharedObjects), target = sourceCodec(receiver.sharedObjects);
  const input = values(), graph = codec.encode(input);
  expect(() => codec.prepare(input).commit(() => { throw new Error("later failure"); })).toThrow("later failure");
  input.memory.grow(1);
  await new Promise<void>(resolve => target.wait(graph, resolve));
  const value = received(target.decode(graph));
  expect(value.memory.buffer.byteLength).toBe(131072);
  expect(broker.inspect().objects).toBe(3);
});

test("unattached, forged and nested native references fail before restoring any port", () => {
  const { client } = brokerClients(cleanup, { lanes: true });
  const { sharedObjects } = client();
  let restored = 0;
  const codec = sourceCodec(sharedObjects, { isPort: () => false, prepare() { throw new Error("Unexpected transfer"); }, restore() { restored++; }, activate() {} });
  const pending = { root: 0, nodes: [["wasm-module", "unknown/id"]] };
  const snapshot = { id: "a", peer: "b", version: 1, sent: 0, received: 0, pending: [[0, pending]], closing: null, closed: false };
  const graph = { root: 0, nodes: [["port", snapshot, 1], ["array", 0, []]] };
  expect(() => codec.decode(graph)).toThrow("not attached");
  expect(restored).toBe(0);
  const sab = codec.encode(new SharedArrayBuffer(0));
  const node = sab.nodes[0];
  if (!node || node[0] !== "shared") throw new Error("Missing backing reference");
  expect(() => codec.decode({ root: 0, nodes: [["wasm-memory", node[1], 1], ["shared", node[1], 0]] })).toThrow("Invalid shared Wasm");
  expect(() => codec.decode({ root: 0, nodes: [["wasm-module", "bad/id", "extra"]] })).toThrow("Invalid worker message");
  expect(() => codec.decode({ root: 0, nodes: [["wasm-memory", "invalid"]] })).toThrow("Invalid worker message");
});

test("shared Memory buffer keeps the identity of separately posted buffers and views through growth", async () => {
  const { client } = brokerClients(cleanup, { lanes: true });
  const sender = client(), receiver = client();
  const input = values();
  const codec = sourceCodec(sender.sharedObjects), target = sourceCodec(receiver.sharedObjects);
  for (const pages of [1, 2]) {
    if (pages === 2) input.memory.grow(1);
    const graph = codec.encode({ memory: input.memory, buffer: input.memory.buffer, view: new Int32Array(input.memory.buffer) });
    await new Promise<void>(resolve => target.wait(graph, resolve));
    const value = target.decode(graph);
    if (!value || typeof value !== "object" || !("memory" in value) || !(value.memory instanceof WebAssembly.Memory)
      || !("buffer" in value) || !("view" in value) || !(value.view instanceof Int32Array)) throw new Error("Missing memory aliases");
    expect(value.buffer).toBe(value.memory.buffer);
    expect(value.view.buffer).toBe(value.memory.buffer);
    expect(value.memory.buffer.byteLength).toBe(pages * 65536);
  }
});
