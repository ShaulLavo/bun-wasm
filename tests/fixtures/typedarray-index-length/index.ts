import assert from "node:assert/strict";

for (const Constructor of [Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array, Uint32Array, Int32Array, Float16Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) {
  for (const length of [2 ** 32, 2 ** 32 + 1, 2 ** 33 + 2]) {
    assert.throws(() => new Constructor(length), RangeError);
  }
  assert.equal(new Constructor(3.9).length, 3);
  assert.equal(new Constructor(NaN).length, 0);
  assert.equal(new Constructor(-0).length, 0);
  console.log("pass", Constructor.name);
}

assert.throws(() => Buffer.allocUnsafe(2 ** 32), RangeError);
console.log("pass Buffer allocation length");
