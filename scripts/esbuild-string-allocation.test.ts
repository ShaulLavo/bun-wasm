import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

type Packet = { id: number; isRequest: boolean; value: unknown };
type Counts = { allocations: number[]; copiedBytes: number; views: number };

let scratch: string;
let original: string;
let adapted: string;
const measurements: unknown[] = [];
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (!process.env.BUNWASM_ESBUILD_STRING_RESULT) return;
  writeFileSync(process.env.BUNWASM_ESBUILD_STRING_RESULT, JSON.stringify({ measurements, removedScratch: scratch,
    scratchAbsent: !existsSync(scratch) }, null, 2) + "\n");
});

function command(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString();
}

function adapt(path: string, source = original): string {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, source);
  const output = join(scratch, "adapted.cjs");
  command([join(scratch, "target/release/esbuild-packet-check"), path, output]);
  expect(readFileSync(path, "utf8")).toBe(source);
  return readFileSync(output, "utf8");
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bun-wasm-esbuild-string-"));
  const fixture = resolve(import.meta.dir, "fixtures/esbuild-packet-adapter.rs");
  writeFileSync(join(scratch, "Cargo.toml"), `[package]\nname = "esbuild-packet-check"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n[dependencies]\nsha2 = "=0.10.9"\n[[bin]]\nname = "esbuild-packet-check"\npath = ${JSON.stringify(fixture)}\n`);
  command(["cargo", "build", "--quiet", "--release", "--manifest-path", join(scratch, "Cargo.toml"), "--target-dir", join(scratch, "target")]);
  const response = await fetch("https://registry.npmjs.org/esbuild-wasm/-/esbuild-wasm-0.25.12.tgz", { signal: AbortSignal.timeout(30_000) });
  expect(response.ok).toBe(true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("e0712c0e7a9bcfb53c648f63222b07d6ef052897da093498441b8ac5fcfc5342");
  const archive = join(scratch, "package.tgz");
  writeFileSync(archive, bytes);
  command(["tar", "-xzf", archive, "-C", scratch, "package/lib/main.js", "package/package.json"]);
  expect(JSON.parse(readFileSync(join(scratch, "package/package.json"), "utf8"))).toMatchObject({ name: "esbuild-wasm", version: "0.25.12" });
  original = readFileSync(join(scratch, "package/lib/main.js"), "utf8");
  expect(gunzipSync(readFileSync(new URL("./fixtures/esbuild-packet/main.js.gz", import.meta.url))).toString()).toBe(original);
  adapted = adapt(join(scratch, "node_modules/esbuild/lib/main.js"));
}, 120_000);

function protocol(source: string): string {
  const start = source.indexOf("function encodePacket(packet) {");
  const end = source.indexOf("\n// lib/shared/common.ts", start);
  if (start < 0 || end < 0) throw new Error("Missing published protocol");
  return source.slice(start, end).trimEnd() + "\n";
}

function codec(source: string, failLength?: number, bufferCodec = false) {
  const counts: Counts = { allocations: [], copiedBytes: 0, views: 0 };
  const sentinel = new RangeError("allocation sentinel");
  const Bytes = new Proxy(Uint8Array, { construct(target, args) {
    if (typeof args[0] === "number") counts.allocations.push(args[0]);
    if (args[0] === failLength) throw sentinel;
    const result: Uint8Array = Reflect.construct(target, args);
    result.set = (input, offset) => { counts.copiedBytes += input.length; Uint8Array.prototype.set.call(result, input, offset); };
    return result;
  } });
  const filename = join(scratch, "package/lib/main.js");
  const module = { exports: {} };
  const raw: unknown = new Function("Uint8Array", "TextEncoder", "TextDecoder", "Buffer", "require", "module", "exports", "__filename", "__dirname",
    source + "\nreturn { encodePacket, decodePacket, createChannel };")(
    Bytes, bufferCodec ? undefined : TextEncoder, bufferCodec ? undefined : TextDecoder, Buffer,
    createRequire(import.meta.url), module, module.exports, filename, resolve(filename, ".."));
  if (!raw || typeof raw !== "object" || !("encodePacket" in raw) || !("decodePacket" in raw) || !("createChannel" in raw)) throw new Error("Missing codec");
  const { encodePacket, decodePacket, createChannel } = raw;
  if (typeof encodePacket !== "function" || typeof decodePacket !== "function" || typeof createChannel !== "function") throw new Error("Invalid codec");
  const encode = (packet: Packet): Uint8Array => {
    const frame: unknown = encodePacket(packet);
    if (!(frame instanceof Uint8Array)) throw new Error("Invalid frame");
    return frame.subarray(4);
  };
  const decode = (bytes: Uint8Array): Packet => {
    const value: unknown = decodePacket(bytes);
    if (!value || typeof value !== "object" || !("value" in value) || !("id" in value) || !("isRequest" in value)) throw new Error("Invalid decoded packet");
    if (typeof value.id !== "number" || typeof value.isRequest !== "boolean") throw new Error("Invalid decoded header");
    return { id: value.id, isRequest: value.isRequest, value: value.value };
  };
  const reset = () => { counts.allocations.length = 0; counts.copiedBytes = 0; counts.views = 0; };
  const channel = (writeToStdin: (frame: Uint8Array) => void) => {
    const raw: unknown = createChannel({ writeToStdin });
    if (!raw || typeof raw !== "object" || !("readFromStdout" in raw) || typeof raw.readFromStdout !== "function") throw new Error("Missing channel");
    const readFromStdout = raw.readFromStdout;
    return (chunk: Uint8Array): void => { readFromStdout(chunk); };
  };
  reset();
  return { encode, decode, channel, counts, reset, sentinel };
}

function failure(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected failure");
}

function countedPacket(bytes: Uint8Array, counts: Counts): Uint8Array {
  const packet = new Uint8Array(bytes);
  const subarray = packet.subarray.bind(packet);
  packet.subarray = (begin, end) => { counts.views++; return subarray(begin, end); };
  return packet;
}

test("the compiled adapter changes only two string reads and the private read method", () => {
  const fixture = readFileSync(new URL("./fixtures/esbuild-packet/stdio-protocol.txt", import.meta.url), "utf8");
  expect(protocol(original)).toBe(fixture);
  expect(adapted).not.toBe(original);
  const restored = adapted.replace("  read(owned = true)", "  read()")
    .replace(/ if \(!owned[^\n]* }/, "")
    .replaceAll("decodeUTF8(bb.read(false))", "decodeUTF8(bb.read())");
  expect(restored).toBe(original);
  expect(adapted.split("\n")).toHaveLength(original.split("\n").length);
  expect(adapted.match(/bb\.read\(false\)/g)).toHaveLength(2);
  expect(adapted).toContain("case 4:\n        return bb.read();");
  expect(adapt(join(scratch, "nested/node_modules/outer/node_modules/esbuild-wasm/lib/main.js"))).toBe(adapted);
});

test("qualification needs the entire published module and an exact package path", () => {
  for (const path of ["main.js", "node_modules/not-esbuild/lib/main.js", "node_modules/esbuild/lib/browser.js"]) {
    expect(adapt(join(scratch, path))).toBe(original);
  }
  const path = join(scratch, "node_modules/esbuild/lib/main.js");
  for (const changed of [original + "\n", original.replace('"0.25.12"', '"0.25.11"'), original + original, protocol(original), adapted]) {
    expect(adapt(path, changed)).toBe(changed);
  }
});

test("valid values, UTF-8 keys, empty fields and integer headers keep their results", () => {
  const stock = codec(original), small = codec(adapted);
  const value = { "π🙂": "\u0000é\ufeff", empty: "", bytes: new Uint8Array([0, 255, 7]), array: [null, true, false, -123, "text", {}] };
  for (const id of [0, 17, 0x7fffffff]) {
    for (const isRequest of [true, false]) {
      const packet = stock.encode({ id, isRequest, value });
      expect(small.decode(packet)).toEqual(stock.decode(packet));
    }
  }
});

test("strings and keys eliminate backing allocations while bytes still copy", () => {
  const stock = codec(original), small = codec(adapted);
  const packet = stock.encode({ id: 5, isRequest: false, value: { code: "π🙂", payload: new Uint8Array([1, 2, 3]) } });
  stock.reset();
  expect(small.decode(countedPacket(packet, small.counts))).toEqual(stock.decode(countedPacket(packet, stock.counts)));
  expect(stock.counts).toEqual({ allocations: [4, 6, 7, 3], copiedBytes: 20, views: 4 });
  expect(small.counts).toEqual({ allocations: [3], copiedBytes: 3, views: 4 });
});

test("decoded strings and byte fields survive caller mutation and accumulator reuse", () => {
  const small = codec(adapted);
  const frame = small.encode({ id: 7, isRequest: false, value: ["persist", new Uint8Array([4, 5, 6])] });
  const accumulator = new Uint8Array(frame.length + 20);
  accumulator.set(frame, 7);
  const packet = accumulator.subarray(7, 7 + frame.length);
  const result = small.decode(packet);
  accumulator.fill(0);
  expect(result.value).toEqual(["persist", new Uint8Array([4, 5, 6])]);
  const other = small.encode({ id: 8, isRequest: true, value: "another response" });
  expect(small.decode(other).value).toBe("another response");
  expect(result.value).toEqual(["persist", new Uint8Array([4, 5, 6])]);
});

test("every truncated packet prefix and trailing bytes preserve the original error", () => {
  const stock = codec(original), small = codec(adapted);
  const frame = stock.encode({ id: 13, isRequest: true, value: { text: "π🙂", binary: new Uint8Array([1, 2]), values: ["next"] } });
  for (let length = 0; length < frame.length; length++) {
    const prefix = frame.subarray(0, length);
    expect(String(failure(() => small.decode(prefix)))).toBe(String(failure(() => stock.decode(prefix))));
  }
  const trailing = new Uint8Array(frame.length + 1);
  trailing.set(frame);
  expect(String(failure(() => small.decode(trailing)))).toBe(String(failure(() => stock.decode(trailing))));
});

test("the actual stdout accumulator buffers partial frames and reuses storage", () => {
  for (const source of [original, adapted]) {
    const current = codec(source);
    const responses: Packet[] = [];
    const feed = current.channel(frame => responses.push(current.decode(frame.subarray(4))));
    const version = new TextEncoder().encode("0.25.12");
    const hello = new Uint8Array(4 + version.length);
    new DataView(hello.buffer).setInt32(0, version.length, true);
    hello.set(version, 4);
    for (let i = 0; i < hello.length; i++) feed(hello.subarray(i, i + 1));
    for (const id of [17, 18]) {
      const payload = current.encode({ id, isRequest: true, value: { command: "ping", bytes: new Uint8Array([5, 6]) } });
      const frame = new Uint8Array(4 + payload.length);
      new DataView(frame.buffer).setInt32(0, payload.length, true);
      frame.set(payload, 4);
      feed(frame.subarray(0, frame.length - 1));
      expect(responses).toHaveLength(id - 17);
      feed(frame.subarray(frame.length - 1));
      frame.fill(0);
    }
    expect(responses).toEqual([{ id: 17, isRequest: false, value: {} }, { id: 18, isRequest: false, value: {} }]);
  }
});

test("invalid string, key and byte spans retain allocation before bounds checking", () => {
  const cases = [{ value: "abc", offset: 5 }, { value: new Uint8Array([1, 2, 3]), offset: 5 }, { value: { abc: 0 }, offset: 9 }];
  for (const { value, offset } of cases) {
    for (const length of [-1, -2147483648, 16, 1048576, 2147483647]) {
      const stock = codec(original, length), small = codec(adapted, length);
      const packet = codec(original).encode({ id: 3, isRequest: false, value });
      new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setInt32(offset, length, true);
      expect(failure(() => stock.decode(packet))).toBe(stock.sentinel);
      expect(failure(() => small.decode(packet))).toBe(small.sentinel);
      expect(small.counts.allocations).toEqual([length]);
    }
  }
  const stock = codec(original), small = codec(adapted);
  const negative = stock.encode({ id: 1, isRequest: true, value: "" });
  new DataView(negative.buffer, negative.byteOffset, negative.byteLength).setInt32(5, -1, true);
  expect(failure(() => small.decode(negative))).toBeInstanceOf(RangeError);
  expect(String(failure(() => small.decode(negative)))).toBe(String(failure(() => stock.decode(negative))));
});

test("small truncated strings keep bounds errors without an injected allocation failure", () => {
  const stock = codec(original), small = codec(adapted);
  const packet = stock.encode({ id: 1, isRequest: true, value: "x" });
  new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setInt32(5, 2, true);
  stock.reset();
  expect(String(failure(() => small.decode(packet)))).toBe("Error: Invalid packet");
  expect(String(failure(() => stock.decode(packet)))).toBe("Error: Invalid packet");
  expect(small.counts.allocations).toEqual([2]);
  expect(small.counts).toEqual(stock.counts);
});

test("valid string allocation refusals are avoided and valid byte refusals keep their identity", () => {
  for (const value of ["x".repeat(123), new Uint8Array(123)]) {
    const stock = codec(original, 123), small = codec(adapted, 123);
    const packet = codec(original).encode({ id: 2, isRequest: true, value });
    expect(failure(() => stock.decode(packet))).toBe(stock.sentinel);
    if (typeof value === "string") expect(small.decode(packet).value).toBe(value);
    else expect(failure(() => small.decode(packet))).toBe(small.sentinel);
  }
});

test("Buffer, shared buffers and typed-array subclasses preserve original copy semantics", () => {
  const stock = codec(original), small = codec(adapted);
  const packet = stock.encode({ id: 1, isRequest: true, value: "plain" });
  const shared = new Uint8Array(new SharedArrayBuffer(packet.length));
  shared.set(packet);
  class PacketBytes extends Uint8Array {}
  for (const input of [Buffer.from(packet), shared, new PacketBytes(packet)]) {
    stock.reset(); small.reset();
    expect(small.decode(input)).toEqual(stock.decode(input));
    expect(small.counts).toEqual(stock.counts);
    expect(small.counts.allocations).toEqual([5]);
  }
  Object.defineProperty(PacketBytes, Symbol.species, { value: Uint16Array });
  stock.reset(); small.reset();
  const input = new PacketBytes(packet);
  expect(String(failure(() => small.decode(input)))).toBe(String(failure(() => stock.decode(input))));
  expect(small.counts).toEqual(stock.counts);
});

test("a plain byte array with a custom constructor retains species coercion", () => {
  const stock = codec(original), small = codec(adapted);
  const packet = stock.encode({ id: 1, isRequest: true, value: "abcdef" });
  const input = new Uint8Array(new ArrayBuffer(40), 1, packet.length);
  input.set(packet);
  Object.defineProperty(input, "constructor", { value: Uint16Array });
  stock.reset();
  expect(small.decode(input)).toEqual(stock.decode(input));
  expect(small.counts).toEqual(stock.counts);
  expect(small.counts.allocations).toEqual([6]);
});

test("the Buffer UTF-8 fallback and malformed UTF-8 preserve decoded text", () => {
  for (const bufferCodec of [false, true]) {
    const stock = codec(original, undefined, bufferCodec), small = codec(adapted, undefined, bufferCodec);
    const packet = stock.encode({ id: 11, isRequest: false, value: "xx" });
    packet.set([0xc3, 0x28], 9);
    expect(small.decode(packet)).toEqual(stock.decode(packet));
  }
});

test("real encoded protocol frames quantify strings and byte-valued code separately", () => {
  for (const length of [64 * 1024, 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024]) {
    for (const kind of ["string", "bytes"]) {
      const code = original.repeat(Math.ceil(length / original.length)).slice(0, length);
      const bytes = new TextEncoder().encode(code);
      const value = { errors: [], warnings: [], code: kind === "string" ? code : bytes, map: "", codeFS: false, mapFS: false };
      const stock = codec(original), small = codec(adapted);
      const packet = stock.encode({ id: 12, isRequest: false, value });
      stock.reset();
      expect(small.decode(countedPacket(packet, small.counts))).toEqual(stock.decode(countedPacket(packet, stock.counts)));
      const savedBytes = stock.counts.copiedBytes - small.counts.copiedBytes;
      expect(savedBytes).toBe((kind === "string" ? bytes.length : 0) + 32);
      expect(small.counts.allocations).toEqual(kind === "string" ? [] : [bytes.length]);
      measurements.push({ codeKind: kind, codeBytes: bytes.length, packetBytes: packet.length, original: stock.counts, adapted: small.counts, savedBytes });
    }
  }
}, 30_000);
