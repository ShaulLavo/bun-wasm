import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import { test } from "bun:test";

test("partial URL comparison includes the native href and own properties", () => {
  const actual = new URL("https://a.example/");
  assert.partialDeepStrictEqual(actual, new URL(actual.href));
  assert.throws(() => assert.partialDeepStrictEqual(actual, new URL("https://b.example/")), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(actual, {}), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual({}, actual), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(actual, Object.assign(new URL(actual.href), { own: 1 })), assert.AssertionError);
});

test("partial KeyObject comparison includes key bytes and own properties", () => {
  const key = () => createSecretKey(new Uint8Array([1]));
  assert.partialDeepStrictEqual(key(), key());
  assert.throws(() => assert.partialDeepStrictEqual(key(), createSecretKey(new Uint8Array([2]))), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(key(), {}), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual({}, key()), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(key(), Object.assign(key(), { own: 1 })), assert.AssertionError);
});

test("typed array contents ignore overridden iterators", () => {
  const empty = function* () {};
  const actual = Object.assign(new Uint8Array([1]), { [Symbol.iterator]: empty });
  const expected = Object.assign(new Uint8Array([2]), { [Symbol.iterator]: empty });
  assert.throws(() => assert.partialDeepStrictEqual(actual, expected), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(Object.assign(Buffer.from([1]), { [Symbol.iterator]: empty }), Object.assign(Buffer.from([2]), { [Symbol.iterator]: empty })), assert.AssertionError);
  assert.partialDeepStrictEqual(new Float64Array([1, NaN, -0]), new Float64Array([NaN, -0]));
  assert.throws(() => assert.partialDeepStrictEqual(new Float64Array([0]), new Float64Array([-0])), assert.AssertionError);
  const signed = Object.defineProperty(new Int8Array([1]), Symbol.toStringTag, { value: "Uint8Array" });
  assert.throws(() => assert.partialDeepStrictEqual(signed, new Uint8Array([1])), assert.AssertionError);
});

test("DataView and ArrayBuffer numeric own properties are compared", () => {
  const view = Object.assign(new DataView(new ArrayBuffer(1)), { 0: 1 });
  assert.throws(() => assert.partialDeepStrictEqual(new DataView(new ArrayBuffer(1)), view), assert.AssertionError);
  assert.partialDeepStrictEqual(Object.assign(new DataView(new ArrayBuffer(1)), { 0: 1, extra: true }), view);
  const buffer = Object.assign(new ArrayBuffer(1), { 0: 1 });
  assert.throws(() => assert.partialDeepStrictEqual(new ArrayBuffer(1), buffer), assert.AssertionError);
});

test("Map identity mismatches can use a later deep key match", () => {
  const key = { id: 1 };
  const actual = new Map([[key, { x: 1 }], [{ id: 1, extra: true }, { x: 2 }]]);
  assert.partialDeepStrictEqual(actual, new Map([[key, { x: 2 }]]));
  assert.partialDeepStrictEqual(actual, new Map([[key, { x: 2 }], [{ id: 1 }, { x: 1 }]]));
  const one = new Map([[key, { x: 1 }], [{ id: 2 }, { x: 2 }]]);
  assert.throws(() => assert.partialDeepStrictEqual(one, new Map([[key, { x: 1 }], [{ id: 1 }, { x: 1 }]])), assert.AssertionError);
  assert.throws(() => assert.partialDeepStrictEqual(new Map([[key, { x: 1 }]]), new Map([[{ id: 1 }, { x: 1 }], [key, { x: 1 }]])), assert.AssertionError);
});
