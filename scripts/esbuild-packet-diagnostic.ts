import { readFileSync, writeFileSync } from "node:fs";

const protocolSource = readFileSync(new URL("./fixtures/esbuild-packet/stdio-protocol.txt", import.meta.url), "utf8");

const originalRead = `  read() {
    let length = this.read32();
    let bytes = new Uint8Array(length);
    let ptr = this._read(bytes.length);
    bytes.set(this.buf.subarray(ptr, ptr + length));
    return bytes;
  }`;

const diagnosticRead = `  read(kind) {
    let length = this.read32();
    let offset = this.ptr;
    let phase = "allocation";
    try {
      let bytes = new Uint8Array(length);
      phase = "bounds";
      let ptr = this._read(bytes.length);
      phase = "copy";
      bytes.set(this.buf.subarray(ptr, ptr + length));
      return bytes;
    } catch (error) {
      bunWasmReportPacketReadFailure(this.buf, kind, length, offset, phase);
      throw error;
    }
  }`;

const reporter = `var bunWasmPacketReadFailed = false;
function bunWasmReportPacketReadFailure(buffer, kind, length, offset, phase) {
  if (bunWasmPacketReadFailed) return;
  bunWasmPacketReadFailed = true;
  try {
    let header = readUInt32LE(buffer, 0);
    console.error("[bun-wasm:esbuild-packet-read] " + JSON.stringify({
      kind, phase, length, unsignedLength: length >>> 0, offset,
      remaining: buffer.length - offset, packetBytes: buffer.length,
      packetId: header >>> 1, isRequest: (header & 1) === 0,
      fits: length >= 0 && length <= buffer.length - offset
    }));
  } catch {}
}
`;

function replaceOnce(source: string, before: string, after: string): string {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error("Unrecognized esbuild packet decoder source");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

export function instrumentEsbuildPacketReads(source: string): string {
  let result = replaceOnce(protocolSource, originalRead, diagnosticRead);
  result = replaceOnce(result, "var ByteBuffer = class {", reporter + "var ByteBuffer = class {");
  result = replaceOnce(result, "return decodeUTF8(bb.read());", 'return decodeUTF8(bb.read("string"));');
  result = replaceOnce(result, "return bb.read();", 'return bb.read("bytes");');
  result = replaceOnce(result, "value2[decodeUTF8(bb.read())] = visit();", 'value2[decodeUTF8(bb.read("key"))] = visit();');
  return replaceOnce(source, protocolSource, result);
}

if (import.meta.main) {
  const [input, output, extra] = process.argv.slice(2);
  if (!input || !output || extra) throw new Error("Usage: bun scripts/esbuild-packet-diagnostic.ts INPUT OUTPUT");
  const source = instrumentEsbuildPacketReads(readFileSync(input, "utf8"));
  writeFileSync(output, source, { flag: "wx" });
}
