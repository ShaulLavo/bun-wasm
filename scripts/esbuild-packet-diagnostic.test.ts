import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentEsbuildPacketReads } from "./esbuild-packet-diagnostic.ts";

const original = readFileSync(new URL("./fixtures/esbuild-packet/stdio-protocol.txt", import.meta.url), "utf8");
const diagnostic = instrumentEsbuildPacketReads(original);
const prefix = "[bun-wasm:esbuild-packet-read] ";
type Packet = { id: number; isRequest: boolean; value: unknown };

function load(source: string, failLength?: number, logThrows = false) {
  const allocations: number[] = [], lines: string[] = [];
  const sentinel = new RangeError("allocation sentinel");
  const Bytes = new Proxy(Uint8Array, { construct(target, args) {
    if (typeof args[0] === "number") allocations.push(args[0]);
    if (args[0] === failLength) throw sentinel;
    return Reflect.construct(target, args);
  } });
  const error = (line: string) => {
    if (logThrows) throw new Error("log unavailable");
    lines.push(line);
  };
  const raw: unknown = new Function("Uint8Array", "console", source + "\nreturn { encodePacket, decodePacket };")(Bytes, { error });
  if (!raw || typeof raw !== "object" || !("encodePacket" in raw) || !("decodePacket" in raw)) throw new Error("Missing codec");
  const { encodePacket, decodePacket } = raw;
  if (typeof encodePacket !== "function" || typeof decodePacket !== "function") throw new Error("Invalid codec");
  const encode = (packet: Packet) => {
    const frame: unknown = encodePacket(packet);
    if (!(frame instanceof Uint8Array)) throw new Error("Invalid encoded frame");
    return frame.subarray(4);
  };
  return { encode, decode: (bytes: Uint8Array): unknown => decodePacket(bytes), allocations, lines, sentinel };
}

function failure(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected failure");
}

function record(line: string | undefined): unknown {
  if (!line?.startsWith(prefix)) throw new Error("Missing diagnostic");
  return JSON.parse(line.slice(prefix.length));
}

function stringPacket(length: number, declaredLength = length) {
  const bytes = load(original).encode({ id: 23, isRequest: false, value: "x".repeat(length) });
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(5, declaredLength, true);
  return bytes;
}

test("valid packets keep values and exactly the original allocation lengths", () => {
  const baseline = load(original), observed = load(diagnostic);
  const value = { code: "π🙂\u0000é", empty: "", bytes: new Uint8Array([1, 2, 255]), items: [null, true, -7, "text"] };
  const packet = baseline.encode({ id: 0x7fffffff, isRequest: true, value });
  baseline.allocations.length = 0;
  expect(observed.decode(packet)).toEqual(baseline.decode(packet));
  expect(observed.allocations).toEqual(baseline.allocations);
  expect(observed.allocations).toContain(new TextEncoder().encode(value.code).length);
  expect(new TextEncoder().encode(value.code).length).not.toBe(value.code.length);
  expect(observed.lines).toEqual([]);
});

test("every truncated prefix keeps the decoder's error and allocation sequence", () => {
  const packet = load(original).encode({ id: 4, isRequest: true, value: { text: "π🙂", bytes: new Uint8Array([1, 2]), array: ["x"] } });
  for (let length = 0; length < packet.length; length++) {
    const baseline = load(original), observed = load(diagnostic);
    const truncated = packet.subarray(0, length);
    expect(String(failure(() => observed.decode(truncated)))).toBe(String(failure(() => baseline.decode(truncated))));
    expect(observed.allocations).toEqual(baseline.allocations);
    expect(observed.lines.length).toBeLessThanOrEqual(1);
  }
});

test("invalid spans still reach allocation first and report the exact bounds", () => {
  const packet = stringPacket(3, 1_048_576);
  const baseline = load(original, 1_048_576), observed = load(diagnostic, 1_048_576);
  expect(failure(() => baseline.decode(packet))).toBe(baseline.sentinel);
  expect(failure(() => observed.decode(packet))).toBe(observed.sentinel);
  expect(observed.allocations).toEqual([1_048_576]);
  expect(record(observed.lines[0])).toEqual({ kind: "string", phase: "allocation", length: 1_048_576, unsignedLength: 1_048_576,
    offset: 9, remaining: 3, packetBytes: 12, packetId: 23, isRequest: false, fits: false });
});

test("a small truncated field is distinguished from a valid allocation refusal", () => {
  const truncated = load(diagnostic);
  expect(String(failure(() => truncated.decode(stringPacket(3, 4))))).toBe("Error: Invalid packet");
  expect(record(truncated.lines[0])).toMatchObject({ phase: "bounds", length: 4, remaining: 3, fits: false });
  const valid = load(diagnostic, 11);
  expect(failure(() => valid.decode(stringPacket(11)))).toBe(valid.sentinel);
  expect(record(valid.lines[0])).toMatchObject({ phase: "allocation", length: 11, remaining: 11, fits: true });
});

test("signed length words remain signed and report their unsigned wire value", () => {
  const baseline = load(original), observed = load(diagnostic);
  const packet = stringPacket(0, -1);
  expect(String(failure(() => observed.decode(packet)))).toBe(String(failure(() => baseline.decode(packet))));
  expect(observed.allocations).toEqual([-1]);
  expect(record(observed.lines[0])).toMatchObject({ length: -1, unsignedLength: 0xffffffff, fits: false });
});

test("byte values own their storage when the stdout accumulator is reused", () => {
  const decoder = load(diagnostic);
  const packet = decoder.encode({ id: 9, isRequest: false, value: new Uint8Array([7, 8, 9]) });
  const decoded = decoder.decode(packet);
  if (!decoded || typeof decoded !== "object" || !("value" in decoded) || !(decoded.value instanceof Uint8Array)) throw new Error("Missing bytes");
  packet.fill(0);
  expect(Array.from(decoded.value)).toEqual([7, 8, 9]);
});

test("key and byte failures are labelled without retaining packet contents", () => {
  const encoder = load(original), key = load(diagnostic, 7), bytes = load(diagnostic, 11);
  const keyPacket = encoder.encode({ id: 6, isRequest: true, value: { private: 0 } });
  expect(failure(() => key.decode(keyPacket))).toBe(key.sentinel);
  expect(record(key.lines[0])).toMatchObject({ kind: "key", packetId: 6, isRequest: true });
  const bytePacket = encoder.encode({ id: 5, isRequest: false, value: new Uint8Array(11) });
  expect(failure(() => bytes.decode(bytePacket))).toBe(bytes.sentinel);
  expect(record(bytes.lines[0])).toMatchObject({ kind: "bytes", length: 11, fits: true });
  expect(key.lines.join("")).not.toContain("private");
});

test("only the first failure logs and a failed reporter preserves error identity", () => {
  const observed = load(diagnostic, 11);
  const packet = stringPacket(11);
  expect(failure(() => observed.decode(packet))).toBe(observed.sentinel);
  expect(failure(() => observed.decode(packet))).toBe(observed.sentinel);
  expect(observed.lines.length).toBe(1);
  const unavailable = load(diagnostic, 11, true);
  expect(failure(() => unavailable.decode(packet))).toBe(unavailable.sentinel);
});

test("changed, duplicate and already instrumented protocol source is rejected", () => {
  expect(() => instrumentEsbuildPacketReads(original.replace("id >>>= 1", "id >>>= 2"))).toThrow("Unrecognized");
  expect(() => instrumentEsbuildPacketReads(original + original)).toThrow("Unrecognized");
  expect(() => instrumentEsbuildPacketReads(diagnostic)).toThrow("Unrecognized");
  expect(instrumentEsbuildPacketReads("before\n" + original + "after")).toBe("before\n" + diagnostic + "after");
});

test("the manual CLI writes a new output and preserves its input and existing files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-esbuild-packet-"));
  const cli = fileURLToPath(new URL("./esbuild-packet-diagnostic.ts", import.meta.url));
  const input = join(scratch, "input.txt"), output = join(scratch, "output.js");
  const run = () => Bun.spawnSync([process.execPath, cli, input, output], { stdout: "pipe", stderr: "pipe" });
  try {
    writeFileSync(input, original);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(diagnostic);
    expect(readFileSync(input, "utf8")).toBe(original);
    expect(run().exitCode).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(diagnostic);
    rmSync(output);
    writeFileSync(input, "unrecognized decoder");
    expect(run().exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
