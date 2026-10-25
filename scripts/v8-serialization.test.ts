import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as nativeV8 from "node:v8";
import { runInNewContext } from "node:vm";
import { MessageChannel, MessagePort } from "node:worker_threads";

interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}

function runtimeSerializer(): Serializer {
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
      if (name === "buffer") return { Buffer };
      if (name === "dns") return {};
      if (cache.has(name)) return cache.get(name);
      const extension = name === "builtins" ? "js" : "ts";
      const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
      const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
      const factory = runInNewContext(emitted, context);
      const value = factory(internal);
      cache.set(name, value);
      return value;
    },
  };
  const registry = internal.require("builtins") as Record<string, () => Serializer>;
  return registry["node:v8"]();
}

const implementations: [string, Serializer][] = [["native Bun", nativeV8], ["runtime builtin", runtimeSerializer()]];

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
