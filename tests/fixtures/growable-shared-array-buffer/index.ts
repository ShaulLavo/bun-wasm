// A growable SharedArrayBuffer grows in place: a fixed-length view keeps its length and a
// length-tracking view follows the buffer, as in Bun.
const buffer = new SharedArrayBuffer(8, { maxByteLength: 32 });
console.log("created", buffer.byteLength, buffer.maxByteLength, buffer.growable);
const fixed = Buffer.from(buffer, 0, 4);
const tracking = Buffer.from(buffer);
const view = new Uint8Array(buffer);
view[7] = 7;
buffer.grow(32);
console.log("grown", buffer.byteLength, fixed.length, tracking.length, view.length, view[7], view[31]);
try {
  buffer.grow(16);
} catch (error) {
  console.log("shrink", (error as Error).name);
}
try {
  buffer.grow(33);
} catch (error) {
  console.log("past the maximum", (error as Error).name);
}
const fixedSize = new SharedArrayBuffer(4);
console.log("fixed size", fixedSize.growable, fixedSize.maxByteLength);
