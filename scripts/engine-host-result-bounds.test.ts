import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { memoryViews } from "waffle/core/memory-views";

const host = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
const start = host.indexOf("const utf8 = ");
const end = host.indexOf("// Thrown to unwind after process.exit", start);
assert.ok(start >= 0 && end > start);
let arrayAllocations = 0;
const ObservedArray = new Proxy(Array, {
  construct(target, args) {
    arrayAllocations++;
    assert.ok(args[0] <= 256, "corrupt collection reached array allocation");
    return Reflect.construct(target, args);
  },
});
// Only the exports are stand-ins. The codec, bridge, memory views, and memory are real.
const wire: unknown = runInNewContext(`${host.slice(start, end)}
({
  encode(value) {
    const writer = new Writer();
    writer.value(value);
    return writer.buf.subarray(0, writer.len);
  },
  decode(bytes) {
    return new Reader(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, bytes.length).value();
  },
  bridge: wasmCaller,
})`, {
  NativeTextEncoder: TextEncoder, NativeTextDecoder: TextDecoder, memoryViews,
  Uint8Array, ArrayBuffer, DataView, Array: ObservedArray, Error, TypeError, RangeError, SyntaxError,
});

function method(value: unknown, name: string): (...args: unknown[]) => unknown {
  assert.ok(value && typeof value === "object");
  const fn: unknown = Reflect.get(value, name);
  assert.ok(typeof fn === "function");
  return (...args) => Reflect.apply(fn, value, args);
}

const encodeValue = method(wire, "encode");
const decode = method(wire, "decode");
const bridge = method(wire, "bridge");
function encode(value: unknown): Uint8Array {
  const packet = encodeValue(value);
  assert.ok(packet instanceof Uint8Array);
  return packet;
}

function fixture(shared: boolean, grow = false) {
  const memory = new WebAssembly.Memory({ initial: 6, maximum: 10, shared });
  let packet = encode(undefined);
  let pointer = 4099;
  let length = packet.length;
  let status = 0;
  let lengthCalls = 0;
  let received: unknown;
  function put() {
    if (grow) memory.grow(1);
    if (packet.length) new Uint8Array(memory.buffer).set(packet, pointer);
    return status;
  }
  const caller = bridge({
    memory,
    bunwasm_alloc() {
      if (grow) memory.grow(1);
      return grow ? 6 * 65536 : 33;
    },
    bunwasm_call(_index: number, input: number, size: number) {
      if (grow) received = decode(new Uint8Array(memory.buffer, input, size));
      return put();
    },
    bunwasm_describe: put,
    bunwasm_result_ptr: () => pointer,
    bunwasm_result_len() { lengthCalls++; return length; },
  });
  return {
    memory,
    call: () => method(caller, "call")(11, [7, "é", new Uint8Array([1, 2])]),
    describe: () => method(caller, "describe")(),
    received: () => received,
    lengthCalls: () => lengthCalls,
    packet(value: Uint8Array, code = 0, at = 4099, size = value.length) {
      packet = value;
      pointer = at;
      length = size;
      status = code;
    },
  };
}

function corrupt(run: () => unknown, beforeCopy = false) {
  const slice = Uint8Array.prototype.slice;
  let copied = 0;
  let error: unknown;
  arrayAllocations = 0;
  Uint8Array.prototype.slice = function (start?: number, end?: number) {
    copied += this.byteLength;
    return slice.call(this, start, end);
  };
  try {
    run();
  } catch (caught) {
    error = caught;
  } finally {
    Uint8Array.prototype.slice = slice;
  }
  if (beforeCopy) assert.equal(copied, 0, "malformed packet must reject before copying");
  assert.equal(arrayAllocations, 0, "malformed count must reject before allocating");
  assert.ok(error instanceof RangeError, `expected corrupt-result RangeError, got ${String(error)}`);
  assert.equal(error.message, "corrupt native result");
}

function header(tag: number, count: number): Uint8Array {
  const packet = new Uint8Array(5);
  packet[0] = tag;
  new DataView(packet.buffer).setUint32(1, count, true);
  return packet;
}

const malformed: [string, Uint8Array][] = [
  ["missing tag", new Uint8Array()],
  ["truncated length", Uint8Array.of(6, 8, 0, 0)],
  ["truncated f64", Uint8Array.of(4, 0, 0, 0, 0, 0, 0, 0)],
  ["truncated signed bigint", Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0)],
  ["truncated unsigned bigint", Uint8Array.of(10, 0, 0, 0, 0, 0, 0, 0)],
  ["short bytes", header(6, 1)],
  ["short string", header(5, 1)],
  ["unknown tag", Uint8Array.of(255)],
  ["trailing value", Uint8Array.of(0, 1)],
  ["excessive array", header(7, 0xffffffff)],
  ["excessive object", header(8, 0xffffffff)],
  ["object count above minimum entry size", Uint8Array.of(8, 1, 0, 0, 0, 0)],
  ["truncated object key", Uint8Array.of(8, 1, 0, 0, 0, 2, 0, 0, 0, 65)],
  ["oversized object key length", Uint8Array.of(8, 1, 0, 0, 0, 255, 255, 255, 255, 0)],
];

for (const shared of [false, true]) {
  const label = shared ? "shared" : "unshared";
  test(`${label} 13-byte BYTES with 0xffffffff length rejects before copying`, () => {
    const f = fixture(shared);
    const packet = encode(new Uint8Array(8));
    assert.equal(packet.length, 13);
    new DataView(packet.buffer, packet.byteOffset).setUint32(1, 0xffffffff, true);
    f.packet(packet);
    corrupt(f.call, true);
  });
  for (const [name, packet] of malformed) {
    test(`${label} result rejects ${name} at its logical end`, () => {
      const f = fixture(shared);
      f.packet(packet);
      corrupt(f.call, true);
    });
  }
  test(`${label} result region beyond current backing rejects before reading`, () => {
    const f = fixture(shared);
    f.packet(encode(undefined), 0, f.memory.buffer.byteLength - 1, 2);
    corrupt(f.call, true);
    f.packet(new Uint8Array(), 0, f.memory.buffer.byteLength + 1, 0);
    corrupt(f.describe, true);
  });
  for (const size of [0, 37, 262144]) {
    test(`${label} ${size}-byte result stays independent through reuse and growth`, () => {
      const f = fixture(shared);
      const payload = Uint8Array.from({ length: size }, (_, index) => index % 251);
      f.packet(encode(payload));
      const output = f.call();
      assert.ok(output instanceof Uint8Array);
      assert.deepEqual(output, payload);
      assert.notEqual(output.buffer, f.memory.buffer);
      assert.ok(output.buffer instanceof ArrayBuffer);
      assert.equal(output.buffer.byteLength, size);
      new Uint8Array(f.memory.buffer).fill(0xdd);
      f.memory.grow(0);
      f.memory.grow(1);
      f.packet(encode(new Uint8Array([99])));
      assert.deepEqual(f.call(), new Uint8Array([99]));
      assert.deepEqual(output, payload);
      assert.equal(f.lengthCalls(), 2);
    });
  }
  test(`${label} scalars, strings, keys, and nested collections keep their values`, () => {
    const f = fixture(shared);
    const value = { "\ufeffkeyé\0": [undefined, null, false, true, 12.5, -17n, 2n ** 64n - 1n, "\ufeffé😀\0"], empty: [], object: {} };
    f.packet(encode(value));
    const output = f.describe();
    assert.ok(output && typeof output === "object");
    assert.deepEqual(Object.keys(output), Object.keys(value));
    const items: unknown = Reflect.get(output, "\ufeffkeyé\0");
    assert.ok(Array.isArray(items));
    assert.deepEqual(Array.from(items), value["\ufeffkeyé\0"]);
    assert.deepEqual(Object.keys(Reflect.get(output, "object")), []);
    assert.equal(Reflect.get(output, "empty").length, 0);
    assert.equal(f.lengthCalls(), 1);
    f.packet(encode(undefined));
    assert.equal(f.call(), undefined);
    for (const scalar of [null, false, true, -0, NaN, Infinity, -Infinity, -17n, 2n ** 64n - 1n, ""]) {
      f.packet(encode(scalar));
      assert.equal(f.call(), scalar);
    }
  });
  test(`${label} object keys remain own data properties without changing the prototype`, () => {
    const f = fixture(shared);
    f.packet(encode({}));
    const empty = f.call();
    assert.ok(empty && typeof empty === "object");
    const prototype = Object.getPrototypeOf(empty);
    for (const value of ["guest-env-value", { marker: "own value" }, null]) {
      f.packet(encode({ ["__proto__"]: value, ordinary: "kept" }));
      const output = f.call();
      assert.ok(output && typeof output === "object");
      assert.deepEqual(Object.keys(output), ["__proto__", "ordinary"]);
      assert.equal(Object.getPrototypeOf(output), prototype);
      assert.deepEqual(encode(Reflect.get(output, "__proto__")), encode(value));
      assert.equal(Reflect.get(output, "ordinary"), "kept");
      const descriptor = Object.getOwnPropertyDescriptor(output, "__proto__");
      assert.ok(descriptor);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.writable, true);
      assert.equal(descriptor.configurable, true);
      assert.equal(Object.hasOwn(descriptor, "get"), false);
    }
  });
  test(`${label} native status still decodes and rethrows the native error`, () => {
    const f = fixture(shared);
    f.packet(encode({ kind: "TypeError", message: "\ufeffbad é", name: "NativeFailure", props: { code: "EFAIL", count: 2 } }), 1);
    assert.throws(f.call, { name: "NativeFailure", message: "\ufeffbad é", code: "EFAIL", count: 2 });
    try { f.call(); } catch (error) { assert.ok(error instanceof TypeError); }
    f.packet(header(6, 0xffffffff), 1);
    corrupt(f.call, true);
  });
  test(`${label} views refresh after allocation and call grow memory`, () => {
    const f = fixture(shared, true);
    const payload = new Uint8Array([5, 6, 7]);
    f.packet(encode(payload), 0, 7 * 65536 + 3);
    assert.deepEqual(f.call(), payload);
    assert.equal(f.memory.buffer.byteLength, 8 * 65536);
    const args = f.received();
    assert.ok(Array.isArray(args));
    assert.equal(args[0], 7);
    assert.equal(args[1], "é");
    assert.deepEqual(args[2], new Uint8Array([1, 2]));
  });
}
