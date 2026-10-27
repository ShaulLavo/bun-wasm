import assert from "node:assert/strict";

// The WASI port rejects virtual backing stores before attempting allocation.
for (const Constructor of [ArrayBuffer, SharedArrayBuffer]) {
  for (const [initial, maximum] of [[0, 0], [0, 16], [8, 8], [8, 16]]) {
    assert.throws(() => new Constructor(initial, { maxByteLength: maximum }), Error);
  }
  const fixed = new Constructor(16);
  const view = new Uint8Array(fixed);
  view[0] = 7;
  assert.equal(view[0], 7);
  assert.equal(fixed.byteLength, 16);
  assert.equal(Object.getPrototypeOf(fixed), Constructor.prototype);
  assert.equal(fixed.slice(4).byteLength, 12);
  console.log(Constructor.name, "unsupported growth caught; fixed allocation works");
}
console.log("guest survived");
