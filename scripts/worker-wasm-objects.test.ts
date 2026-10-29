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
  return value;
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
