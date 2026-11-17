import assert from "node:assert/strict";

// The WASI port backs resizable ArrayBuffers with malloc memory, so they construct and resize.
for (const [initial, maximum] of [[0, 0], [0, 16], [8, 8], [8, 16]]) {
  const buffer = new ArrayBuffer(initial, { maxByteLength: maximum });
  assert.deepEqual([buffer.byteLength, buffer.maxByteLength, buffer.resizable], [initial, maximum, true]);
  const view = new Uint8Array(buffer);
  view.fill(9);
  buffer.resize(maximum);
  assert.equal(view.length, maximum);
  assert.equal(view.subarray(initial).every(byte => byte === 0), true);
  buffer.resize(0);
  assert.equal(view.length, 0);
  assert.throws(() => buffer.resize(maximum + 1), RangeError);
}
console.log("ArrayBuffer resizable construction and resize work");

// Growable SharedArrayBuffers still need virtual reservation, which WASI lacks.
for (const [initial, maximum] of [[0, 0], [0, 16], [8, 8], [8, 16]]) {
  assert.throws(() => new SharedArrayBuffer(initial, { maxByteLength: maximum }), Error);
}
console.log("SharedArrayBuffer unsupported growth caught");

for (const Constructor of [ArrayBuffer, SharedArrayBuffer]) {
  const fixed = new Constructor(16);
  const view = new Uint8Array(fixed);
  view[0] = 7;
  assert.equal(view[0], 7);
  assert.equal(fixed.byteLength, 16);
  assert.equal(Object.getPrototypeOf(fixed), Constructor.prototype);
  assert.equal(fixed.slice(4).byteLength, 12);
  console.log(Constructor.name, "fixed allocation works");
}
console.log("guest survived");
