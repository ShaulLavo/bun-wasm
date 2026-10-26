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

for (const [name, implementation] of implementations) {
  test(`${name} preserves overlapping Buffer views and their shared backing`, () => {
    const b = Buffer.alloc(32, 17).subarray(8, 16);
    const s = b.subarray(2, 4);
    const output = implementation.deserialize(implementation.serialize({ b, s })) as { b: Buffer; s: Buffer };
    expect(Buffer.isBuffer(output.b)).toBe(true);
    expect(Buffer.isBuffer(output.s)).toBe(true);
    expect(output.b.buffer).toBe(output.s.buffer);
    expect(output.s.byteOffset - output.b.byteOffset).toBe(2);
    output.b[2] = 91;
    expect(output.s[0]).toBe(91);
  });

  test(`${name} accepts cross-realm ArrayBuffer values`, () => {
    const foreign = runInNewContext("new Uint8Array([7, 9]).buffer") as ArrayBuffer;
    const output = implementation.deserialize(implementation.serialize(foreign)) as ArrayBuffer;
    expect(Object.prototype.toString.call(output)).toBe("[object ArrayBuffer]");
    expect(Array.from(new Uint8Array(output))).toEqual([7, 9]);
  });

  test(`${name} deserializes its own bytes from a foreign ArrayBuffer`, () => {
    const bytes = implementation.serialize({ value: 42 });
    const input = runInNewContext("new ArrayBuffer(length)", { length: bytes.byteLength }) as ArrayBuffer;
    new Uint8Array(input).set(bytes);
    expect(implementation.deserialize(input)).toEqual({ value: 42 });
  });
}

function graphBytes(nodes: unknown[]) {
  return Buffer.from("bun-wasm:structured\0" + JSON.stringify({ root: 0, nodes }));
}

test("runtime Buffer views alias typed views and explicit backing in either property order", () => {
  const backing = new ArrayBuffer(16);
  const b = Buffer.from(backing, 4, 4);
  b.set([1, 2, 3, 4]);
  const typed = new Uint8Array(backing, 5, 2);
  for (const input of [{ b, typed, backing }, { backing, typed, b }]) {
    const output = runtime.deserialize(runtime.serialize(input)) as typeof input;
    expect(output.b.buffer).toBe(output.backing);
    expect(output.typed.buffer).toBe(output.backing);
    output.b[1] = 99;
    expect(output.typed[0]).toBe(99);
  }
});

test("runtime Buffer-only views omit invisible slab bytes and zero uncovered gaps", () => {
  const slab = Buffer.alloc(65536, 57);
  const left = slab.subarray(100, 103);
  const right = slab.subarray(105, 107);
  const bytes = runtime.serialize({ right, left });
  expect(bytes.byteLength).toBeLessThan(4096);
  const output = runtime.deserialize(bytes) as { left: Buffer; right: Buffer };
  expect(output.left.buffer).toBe(output.right.buffer);
  expect(output.left.buffer.byteLength).toBe(7);
  expect(Array.from(new Uint8Array(output.left.buffer))).toEqual([57, 57, 57, 0, 0, 57, 57]);
});

test("runtime rejects inherited view constructors, invalid bounds and malformed binary bytes", () => {
  const invalidViews = ["toString", "constructor", "__proto__", "hasOwnProperty"];
  for (const name of invalidViews) {
    expect(() => runtime.deserialize(graphBytes([["view", name, 1, 0, 0], ["buffer", "", 0]]))).toThrow();
  }
});

test("runtime rejects malformed base64 for ArrayBuffer and Blob", () => {
  const invalidBytes = ["!", "AA=", "AB==", "AAB=", "AA==\n", "-w=="];
  for (const bytes of invalidBytes) {
    expect(() => runtime.deserialize(graphBytes([["buffer", bytes, 0]]))).toThrow();
    expect(() => runtime.deserialize(graphBytes([["blob", bytes, ""]]))).toThrow();
  }
});

test("runtime validates binary tuple arity and view bounds", () => {
  const invalidNodes = [["buffer", "AA==", 0, 0], ["buffer", "AAA=", 1], ["blob", "", "", 0],
    ["view", "Uint16Array", 1, 1, 2], ["view", "Uint8Array", 1, 0, 2], ["view", "Uint8Array", 0, 0, 0],
    ["view", "Uint8Array", 1, 0, 0, 0]];
  for (const node of invalidNodes) {
    expect(() => runtime.deserialize(graphBytes([node, ["buffer", "AA==", 0]]))).toThrow();
  }
});

test("runtime rejects noncanonical numeric nodes without turning them into NaN", () => {
  for (const text of ["not-a-number", "", " ", "01", "+1", "1.0", "0x10", "1e999", "nan"]) {
    expect(() => runtime.deserialize(graphBytes([["number", text]]))).toThrow();
  }
  for (const text of ["NaN", "Infinity", "-Infinity", "-0", "0", "1.25", "1e+21", "5e-324"]) {
    expect(Object.is(runtime.deserialize(graphBytes([["number", text]])), Number(text))).toBe(true);
  }
});

test("fork fixture reports early child exit instead of leaving the reply pending", async () => {
  const fixture = new URL("../tests/fixtures/v8-fork-serialization/index.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, fixture, "--exit-before-reply"], { stdout: "pipe", stderr: "pipe", timeout: 2000 });
  try {
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("Child exited before sending a reply (code 23)");
  } finally {
    child.kill();
    await child.exited;
  }
});
