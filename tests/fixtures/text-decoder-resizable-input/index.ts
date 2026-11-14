import { strict as assert } from "node:assert";

for (const kind of ["DataView", "Uint16Array", "Uint8Array"]) {
  const backing = new ArrayBuffer(4, { maxByteLength: 8 });
  new Uint8Array(backing).fill(65);
  const input = kind === "DataView" ? new DataView(backing, 1, 2)
    : kind === "Uint16Array" ? new Uint16Array(backing, 2, 1) : new Uint8Array(backing, 1, 2);
  assert.equal(new TextDecoder().decode(input, { get stream() { backing.resize(1); return false; } }), "");
}
console.log("TextDecoder resizable input controls passed");
