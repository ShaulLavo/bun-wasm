// Byte buffers that native code produced or read stay transferable, as in native Bun.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

function transfer(name: string, bytes: Uint8Array) {
  const expected = Array.from(bytes);
  const offset = bytes.byteOffset;
  const length = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copy = structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  assert.equal(bytes.byteLength, 0, name + " source detached");
  assert.throws(() => view.getUint8(0), TypeError);
  assert.deepEqual(Array.from(new Uint8Array(copy, offset, length)), expected, name + " bytes retained");
  console.log(name);
}

function read<T extends Uint8Array>(bytes: T, consume: (bytes: T) => unknown) {
  consume(bytes);
  return bytes;
}

writeFileSync("input.txt", "native output");

transfer("TextEncoder", new TextEncoder().encode("native output"));
transfer("TextEncoder empty", new TextEncoder().encode(""));
transfer("base64", Uint8Array.fromBase64("AQIDBA=="));
transfer("compression", deflateSync("native output"));
transfer("decompression", inflateSync(deflateSync("native output")));
transfer("file read", readFileSync("input.txt"));
transfer("hash digest", createHash("sha256").update("native output").digest());
transfer("Buffer string", Buffer.from("native output"));
transfer("JavaScript", new Uint8Array([1, 2, 3, 4]));
transfer("decoded input", read(new Uint8Array([104, 105]), bytes => new TextDecoder().decode(bytes)));
transfer("written input", read(new Uint8Array([1, 2, 3]), bytes => writeFileSync("output.bin", bytes)));
const large = new Uint8Array(4096).fill(7);
transfer("large written input", read(large, bytes => writeFileSync("large.bin", bytes)));
transfer("view input", read(new Uint8Array(new ArrayBuffer(8), 2, 4).fill(9), bytes => new TextDecoder().decode(bytes)));
