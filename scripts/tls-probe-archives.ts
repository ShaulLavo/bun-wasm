import assert from "node:assert/strict";
import { closeSync, openSync, readSync } from "node:fs";

export type TlsAbi = "host" | "wasm32-wasip1";
function read(fd: number, size: number, offset: number): Buffer {
  const bytes = Buffer.alloc(size);
  assert.equal(readSync(fd, bytes, 0, size, offset), size, "truncated TLS archive");
  return bytes;
}
export function objectAbi(bytes: Uint8Array, abi: TlsAbi): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (abi === "wasm32-wasip1") {
    assert.ok(buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "archive object is not WASM");
    return;
  }
  assert.ok(buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && buffer[4] === 2 && buffer[5] === 1, "archive object is not host ELF64");
  assert.equal(buffer.readUInt16LE(18), process.arch === "arm64" ? 183 : 62, "foreign host machine");
}
export function inspectArchive(path: string, abi: TlsAbi): number {
  const fd = openSync(path, "r");
  try { return inspectMembers(fd, abi); }
  finally { closeSync(fd); }
}
function inspectMembers(fd: number, abi: TlsAbi): number {
  assert.equal(read(fd, 8, 0).toString(), "!<arch>\n", "expected regular ar archive");
  let offset = 8;
  let objects = 0;
  for (;;) {
    const header = Buffer.alloc(60);
    const length = readSync(fd, header, 0, 60, offset);
    if (length === 0) break;
    assert.equal(length, 60, "truncated archive header");
    assert.equal(header.subarray(58).toString(), "`\n");
    const name = header.subarray(0, 16).toString().trim();
    const size = Number(header.subarray(48, 58).toString().trim());
    assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 256 * 1024 * 1024, "unsafe archive member size");
    if (!["/", "//", "/SYM64/"].includes(name)) {
      objectAbi(read(fd, Math.min(size, 64), offset + 60), abi);
      objects++;
    }
    read(fd, 1, offset + 60 + size - 1);
    offset += 60 + size + size % 2;
  }
  assert.ok(objects > 0, "archive has no objects");
  return objects;
}
