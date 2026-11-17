import assert from "node:assert/strict";
import type { isAscii, isUtf8 } from "node:buffer";

type Validators = { isAscii: typeof isAscii; isUtf8: typeof isUtf8 };

export function boundaryChecks(factory: typeof Buffer, validators: Validators, concat: typeof Bun.concatArrayBuffers) {
  return [
    { name: "inferred concat limit differs from explicit length validation", run() {
      const input = factory.allocUnsafe(64 * 1024 * 1024);
      const chunks = new Array<Buffer>(1024).fill(input);
      assert.throws(() => factory.concat(chunks), { name: "RangeError", message: /JavaScriptCore typed arrays are currently limited to 4294967296 bytes/ });
      assert.throws(() => factory.concat([input], 2 ** 32 + 1), { code: "ERR_OUT_OF_RANGE", message: /"length"/ });
      assert.equal(factory.concat(chunks, 3).length, 3);
      assert.throws(() => concat(chunks), { name: "TypeError", message: "Failed to allocate ArrayBuffer" });
      assert.equal(new Uint8Array(concat(chunks, 3)).length, 3);
    } },
    { name: "size validation runs before allocation and retains its error code", run() {
      for (const allocate of [factory.alloc, factory.allocUnsafe, factory.allocUnsafeSlow]) {
        invalidSizes(allocate);
        assert.equal(allocate(3.9).length, 3);
      }
    } },
    { name: "isAscii calls match native Bun and construction throws", run() {
      const ascii = validators.isAscii;
      assert.equal(ascii(factory.from("abc")), true);
      assert.equal(ascii(factory.from("What did the 🦊 say?")), false);
      assert.throws(() => Reflect.construct(ascii, [factory.from("What did the 🦊 say?")]), TypeError);
      assert.equal(Object.hasOwn(ascii, "prototype"), false);
    } },
    { name: "isUtf8 calls match native Bun and construction throws", run() {
      const utf8 = validators.isUtf8;
      assert.equal(utf8(factory.from("What did the 🦊 say?")), true);
      assert.equal(utf8(factory.from([0xc3])), false);
      assert.throws(() => Reflect.construct(utf8, [factory.from("abc")]), TypeError);
      assert.equal(Object.hasOwn(utf8, "prototype"), false);
    } },
    { name: "Bun concat caps the allocation and returns one exact backing store", run() {
      const input = factory.from([1, 2, 3]);
      const bytes = concat([input, input], 4, true);
      assert(bytes instanceof Uint8Array);
      assert.deepEqual(Array.from(bytes), [1, 2, 3, 1]);
      assert.equal(bytes.buffer.byteLength, 4);
      input[0] = 9;
      assert.equal(bytes[0], 1);
      assert.equal(concat([input], 2 ** 32).byteLength, 0);
      assert.throws(() => concat([input], NaN), RangeError);
      assert.throws(() => concat([input], -1), RangeError);
      const hostile = new Uint8Array([4, 5, 6]);
      Object.defineProperty(hostile, "constructor", { get() { throw new Error("constructor observed"); } });
      const capped = concat([hostile], 2, true);
      assert(capped instanceof Uint8Array);
      assert.deepEqual(Array.from(capped), [4, 5]);
    } },
    { name: "Bun concat reads array elements once by index", run() {
      const calls = { species: 0, iterator: 0 };
      class Chunks extends Array<Uint8Array> {
        static get [Symbol.species]() { calls.species++; return Chunks; }
        *[Symbol.iterator]() { calls.iterator++; yield new Uint8Array(calls.iterator === 1 ? [1] : [9, 9, 9, 9]); }
      }
      const chunks = new Chunks();
      chunks.push(new Uint8Array([1, 2]), new Uint8Array([3]));
      assert.deepEqual(Array.from(concat(chunks, undefined, true) as Uint8Array), [1, 2, 3]);
      assert.deepEqual(calls, { species: 0, iterator: 0 });
    } },
    { name: "Bun concat preserves errors from input getters", run() {
      const failure = new RangeError("input getter");
      const chunks = [factory.from([1])];
      Object.defineProperty(chunks, 1, { get() { throw failure; } });
      assert.throws(() => concat(chunks), error => error === failure);
    } },
  ];
}

function invalidSizes(allocate: (size: number) => Buffer) {
  for (const size of [-1, NaN, Infinity, 2 ** 32 + 1]) assert.throws(() => allocate(size), { code: "ERR_OUT_OF_RANGE", message: /"size"/ });
}
