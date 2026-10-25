import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as nativeV8 from "node:v8";
import { runInNewContext } from "node:vm";
import { MessageChannel, MessagePort } from "node:worker_threads";

interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: unknown): unknown;
}

function runtimeModules(useRuntimeBuffer = false) {
  const cache = new Map<string, unknown>();
  const context = {
    ArrayBuffer, Uint8Array, Uint16Array, DataView, Buffer, Blob, DOMException, EventTarget,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError,
    Map, Set, Date, RegExp, Number, String, Boolean, TextEncoder, TextDecoder,
  };
  const internal = {
    native: {
      base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
      base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
      transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
    },
    builtinFactories: {},
    isMessagePort: (value: unknown) => value instanceof MessagePort,
    require(name: string): unknown {
      if (name === "buffer" && !useRuntimeBuffer) return { Buffer };
      if (name === "dns") return {};
      if (cache.has(name)) return cache.get(name);
      const extension = ["builtins", "buffer"].includes(name) ? "js" : "ts";
      const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
      const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
      const factory = runInNewContext(emitted, context);
      const value = factory(internal);
      cache.set(name, value);
      return value;
    },
  };
  return internal;
}

function builtinSerializer(modules: ReturnType<typeof runtimeModules>): Serializer {
  const registry = modules.require("builtins");
  if (!registry || typeof registry !== "object" || !("node:v8" in registry) || typeof registry["node:v8"] !== "function") throw new Error("Missing v8 builtin factory");
  return registry["node:v8"]();
}

const modules = runtimeModules();
const runtime = builtinSerializer(modules);
const implementations: [string, Serializer][] = [["native Bun", nativeV8], ["runtime builtin", runtime]];

for (const [name, implementation] of implementations) {
  test(`${name} preserves cyclic RPC values and numeric primitives`, () => {
    const value = { missing: undefined, nan: NaN, zero: -0, infinity: Infinity, big: 9007199254740993n, self: null as unknown };
    value.self = value;
    const bytes = implementation.serialize(value);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    const result = implementation.deserialize(bytes) as typeof value;
    expect(result.self).toBe(result);
    expect(Object.hasOwn(result, "missing")).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(Number.isNaN(result.nan)).toBe(true);
    expect(Object.is(result.zero, -0)).toBe(true);
    expect(result.infinity).toBe(Infinity);
    expect(result.big).toBe(value.big);
  });

  test(`${name} preserves Maps, Sets, typed arrays and nested Buffers`, () => {
    const buffer = Buffer.alloc(65536, 57).subarray(100, 103);
    const value = { buffer, same: buffer, typed: new Uint16Array([1, 65535]), map: new Map<unknown, unknown>() };
    value.map.set(value, new Set([value]));
    const bytes = implementation.serialize(value);
    const result = implementation.deserialize(bytes) as typeof value;
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer).toBe(result.same);
    expect(Array.from(result.buffer)).toEqual([57, 57, 57]);
    expect(result.typed).toBeInstanceOf(Uint16Array);
    expect(Array.from(result.typed)).toEqual([1, 65535]);
    expect((result.map.get(result) as Set<unknown>).has(result)).toBe(true);
  });

  test(`${name} preserves Error type and message without detaching buffers`, () => {
    const buffer = new ArrayBuffer(8);
    const value = { error: new TypeError("RPC failed", { cause: new RangeError("bad range") }), buffer };
    const result = implementation.deserialize(implementation.serialize(value)) as typeof value;
    expect(result.error).toBeInstanceOf(TypeError);
    expect(result.error.message).toBe("RPC failed");
    expect(buffer.byteLength).toBe(8);
    expect(result.buffer).not.toBe(buffer);
  });

  test(`${name} rejects functions, symbols and MessagePorts without transferring`, () => {
    const channel = new MessageChannel();
    try {
      for (const value of [() => {}, Symbol("rpc"), channel.port1]) {
        expect(() => implementation.serialize({ value })).toThrow();
      }
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
}


test("runtime serializes only visible Buffer bytes and accepts a sliced byte input", () => {
  const value = Buffer.alloc(65536, 57).subarray(100, 103);
  const bytes = runtime.serialize({ value });
  expect(bytes.byteLength).toBeLessThan(4096);
  const envelope = Buffer.concat([Buffer.from("prefix"), Buffer.from(bytes), Buffer.from("suffix")]);
  const input = new DataView(envelope.buffer, envelope.byteOffset + 6, bytes.byteLength);
  expect(runtime.deserialize(input)).toEqual({ value });
});

test("runtime rejects corrupt UTF-8 instead of changing string values", () => {
  const bytes = Buffer.concat([Buffer.from('bun-wasm:structured\0{"root":0,"nodes":[["string","'), Buffer.from([255]), Buffer.from('"]]}')]);
  expect(() => runtime.deserialize(bytes)).toThrow();
});

test("runtime rejects corrupt bytes and malformed Buffer nodes", () => {
  for (const input of [Buffer.from("invalid"), runtime.serialize({ ok: true }).subarray(0, 25)]) {
    expect(() => runtime.deserialize(input)).toThrow();
  }
  const factory = modules.require("worker_codec") as { create(hooks: object): { decode(value: unknown): unknown; encode(value: unknown): { nodes: unknown[] } } };
  const hooks = { isPort: () => false, prepare() { throw new Error("Unexpected transfer"); }, restore() {}, activate() {} };
  const plain = factory.create(hooks);
  const withBuffer = factory.create({ ...hooks, buffer: { isBuffer: Buffer.isBuffer, from: (bytes: Uint8Array) => Buffer.from(bytes) } });
  for (const node of [["node-buffer", "!"], ["node-buffer", "AA="], ["node-buffer", "AB=="], ["node-buffer", "AA==", 1]]) {
    expect(() => withBuffer.decode({ root: 0, nodes: [node] })).toThrow();
    expect(() => withBuffer.decode({ root: 0, nodes: [["null"], node] })).toThrow();
  }
  expect(() => plain.decode({ root: 0, nodes: [["node-buffer", "AA=="]] })).toThrow();
  expect(() => plain.decode({ root: 0, nodes: [["null"], ["node-buffer", "AA=="]] })).toThrow();
  const port = { id: "a", peer: "b", version: 1, sent: 0, received: 0, closing: null, closed: false,
    pending: [[0, { root: 0, nodes: [["node-buffer", "AA=="]] }]] };
  expect(() => plain.decode({ root: 0, nodes: [["port", port, 1], ["array", 0, []]] })).toThrow();
  expect(withBuffer.decode({ root: 0, nodes: [["node-buffer", ""]] })).toEqual(Buffer.alloc(0));
  const value = Buffer.from([1, 2, 3]);
  const graph = plain.encode(value);
  expect(graph.nodes.every(node => Array.isArray(node) && node[0] !== "node-buffer")).toBe(true);
  expect(Buffer.isBuffer(plain.decode(graph))).toBe(false);
  expect(Array.from(plain.decode(graph) as Uint8Array)).toEqual([1, 2, 3]);
});


test("builtin serializer uses the runtime Buffer implementation", () => {
  const implementation = runtimeModules(true);
  const buffer = implementation.require("buffer") as { Buffer: typeof Buffer };
  const serializer = builtinSerializer(implementation);
  const value = buffer.Buffer.from([1, 2, 3]);
  const bytes = serializer.serialize({ value, text: "héllo 🌍" });
  expect(buffer.Buffer.isBuffer(bytes)).toBe(true);
  const output = serializer.deserialize(bytes) as { value: Uint8Array; text: string };
  expect(buffer.Buffer.isBuffer(output.value)).toBe(true);
  expect(Array.from(output.value)).toEqual([1, 2, 3]);
  expect(output.text).toBe("héllo 🌍");
});
