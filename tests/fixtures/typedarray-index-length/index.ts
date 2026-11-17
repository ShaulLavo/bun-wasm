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

const outOfRange = { name: "RangeError", message: "Length out of range of buffer" };
const offsetBeyond = { name: "RangeError", message: "byteOffset exceeds source ArrayBuffer byteLength" };
const outOfMemory = { name: "RangeError", message: "Out of memory" };
const fixed = () => new ArrayBuffer(8);

assert.throws(() => new Uint8Array(fixed(), 2 ** 32), outOfRange);
assert.throws(() => new Uint8Array(fixed(), 2 ** 32 + 8), outOfRange);
assert.throws(() => new Uint8Array(fixed(), 0, 2 ** 32 + 1), outOfRange);
assert.throws(() => new Float64Array(fixed(), 0, 2 ** 32), outOfRange);
assert.throws(() => new Uint16Array(fixed(), 2 ** 32 + 1), { name: "RangeError", message: "byteOffset modulo TypedArray.BYTES_PER_ELEMENT must be 0" });
assert.throws(() => new Uint16Array(new ArrayBuffer(9), 2 ** 32), { name: "RangeError", message: "ArrayBuffer length minus the byteOffset is not a multiple of the element size" });
assert.throws(() => new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }), 2 ** 32), offsetBeyond);
assert.throws(() => new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }), 0, 2 ** 32 + 1), outOfRange);
const detached = fixed();
detached.transfer();
assert.throws(() => new Uint8Array(detached, 2 ** 32), TypeError);
assert.equal(new Uint8Array(fixed(), 8).length, 0);
assert.equal(new Uint8Array(fixed(), 2, 3).length, 3);
console.log("pass typed array buffer offset and length");

assert.throws(() => new DataView(fixed(), 2 ** 32), offsetBeyond);
assert.throws(() => new DataView(fixed(), 0, 2 ** 32 + 1), outOfRange);
assert.throws(() => new DataView(fixed(), 2 ** 32, 1), offsetBeyond);
assert.equal(new DataView(fixed(), 2, 3).byteLength, 3);
console.log("pass DataView offset and length");

assert.throws(() => new Uint8Array({ length: 2 ** 32 + 1 }), outOfMemory);
assert.throws(() => new Float64Array({ length: 2 ** 32 }), outOfMemory);
assert.equal(new Uint8Array({ length: 2, 0: 7, 1: 9 })[1], 9);
console.log("pass array-like length");

assert.throws(() => fixed().transfer(2 ** 32 + 1), outOfMemory);
assert.throws(() => fixed().transferToFixedLength(2 ** 32 + 1), outOfMemory);
assert.equal(fixed().transfer(3).byteLength, 3);
console.log("pass ArrayBuffer transfer length");
