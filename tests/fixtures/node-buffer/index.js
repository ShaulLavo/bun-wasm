const { Buffer } = require("buffer");
const b = Buffer.from("hello world");
console.log("toString:", b.toString(), b.toString("hex"), b.toString("base64"));
console.log("from hex/base64:", Buffer.from("68656c6c6f", "hex").toString(), Buffer.from("aGVsbG8=", "base64").toString());
console.log("base64url:", Buffer.from("subjects?_d").toString("base64url"));
console.log("latin1/utf16le:", Buffer.from("héllo", "latin1").length, Buffer.from("hi", "utf16le").toString("hex"));
console.log("byteLength:", Buffer.byteLength("€uro"), Buffer.byteLength("aGk=", "base64"));
console.log("concat:", Buffer.concat([Buffer.from("a"), Buffer.from("bc")]).toString());
console.log("alloc fill:", Buffer.alloc(4, "ab").toString(), Buffer.alloc(3).toString("hex"));
const c = Buffer.alloc(16);
c.writeUInt32BE(0xdeadbeef, 0);
c.writeInt16LE(-2, 4);
c.writeDoubleLE(1.5, 8);
console.log("read/write ints:", c.readUInt32BE(0).toString(16), c.readInt16LE(4), c.readDoubleLE(8), c.readUInt8(0));
const s = b.subarray(0, 5);
s[0] = 72;
console.log("subarray shares:", b.toString().slice(0, 5), Buffer.isBuffer(s));
console.log("compare/equals:", Buffer.compare(Buffer.from("a"), Buffer.from("b")), Buffer.from("x").equals(Buffer.from("x")));
console.log("indexOf/includes:", b.indexOf("world"), b.includes("lo w"), b.indexOf(111));
console.log("JSON:", JSON.stringify(Buffer.from([1, 2, 3])));
console.log("instanceof Uint8Array:", b instanceof Uint8Array, typeof Buffer.poolSize);
console.log("global Buffer:", globalThis.Buffer === Buffer);
console.log("bigint:", Buffer.from([0, 0, 0, 0, 0, 0, 1, 0]).readBigUInt64BE());
const copySource = Uint16Array.of(0x0201, 0x0403);
console.log("copyBytesFrom view:", Buffer.copyBytesFrom(copySource, 1, 1).toString("hex"));
for (const [offset, length] of [[-1, undefined], [1.5, undefined], [1, -1], [1, 1.5]]) {
  try {
    Buffer.copyBytesFrom(copySource, offset, length);
    console.log("copyBytesFrom invalid: accepted");
  } catch (error) {
    console.log("copyBytesFrom invalid:", error.code);
  }
}
for (const [name, view, offset, length] of [
  ["empty view with negative offset", new Uint16Array(0), -1, undefined],
  ["empty view with fractional offset", new Uint16Array(0), 1.5, undefined],
  ["empty view with invalid length", new Uint16Array(0), undefined, -1],
  ["empty view with both ranges invalid", new Uint16Array(0), -1, 1.5],
  ["offset at end with negative length", copySource, 2, -1],
  ["offset at end with fractional length", copySource, 2, 1.5],
  ["offset past end with negative length", copySource, 3, -1],
  ["offset past end with fractional length", copySource, 3, 1.5],
]) {
  const copied = Buffer.copyBytesFrom(view, offset, length);
  console.log(`copyBytesFrom ${name}:`, Buffer.isBuffer(copied), copied.length);
}
