// Records native Node and Bun compression behaviour for
// tests/fixtures/compression-review. Run from the repository root:
//   node scripts/generate-compression-oracle.ts /tmp/node.json
//   bun scripts/generate-compression-oracle.ts /tmp/bun.json
//   node scripts/generate-compression-oracle.ts --merge /tmp/node.json /tmp/bun.json
// The merge step writes tests/fixtures/compression-review/oracle.json. Where
// the runtimes disagree, Bun is the reference except for the cases listed in
// `nodeReference` (documented in the fixture's README section of
// docs/bun-patches.md).
import * as zlib from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

type Case = Record<string, unknown> & { name: string };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const input = Buffer.from("hello hello hello");
const dictionary = Buffer.from("dictionary words dictionary words");
const dictInput = Buffer.from("dictionary words dictionary words payload");
const specs = [
  ["gzip", "Gzip", "gunzip", "Gunzip"],
  ["deflate", "Deflate", "inflate", "Inflate"],
  ["deflateRaw", "DeflateRaw", "inflateRaw", "InflateRaw"],
  ["brotliCompress", "BrotliCompress", "brotliDecompress", "BrotliDecompress"],
  ["zstdCompress", "ZstdCompress", "zstdDecompress", "ZstdDecompress"],
] as const;
const z = zlib as unknown as Record<string, any>;

function errorShape(error: any) {
  return { class: error?.constructor?.name, message: error?.message, code: error?.code, errno: error?.errno };
}

async function streamCase(create: string, options: object, writes: (Buffer | number)[]) {
  const stream = z["create" + create](options);
  const pieces: Buffer[] = [];
  stream.on("data", (piece: Buffer) => pieces.push(piece));
  const done = new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  for (let i = 0; i < writes.length; i++) {
    const step = writes[i];
    const last = i === writes.length - 1;
    if (typeof step === "number") await new Promise<void>(resolve => stream.flush(step, () => resolve()));
    else if (last) stream.end(step);
    else stream.write(step);
  }
  await done;
  return { hex: hex(Buffer.concat(pieces)), pieces: pieces.map(piece => piece.length) };
}

async function record() {
  const cases: Case[] = [];
  for (const [compress, Create, decompress] of specs) {
    const brotliOrZstd = compress.startsWith("brotli") || compress.startsWith("zstd");
    cases.push({ name: `${compress} sync`, kind: "sync", fn: compress, input: hex(input), hex: hex(z[compress + "Sync"](input)), decode: decompress });
    if (compress !== "gzip") {
      cases.push({ name: `${compress} sync dictionary`, kind: "sync", fn: compress, input: hex(dictInput), dictionary: hex(dictionary), hex: hex(z[compress + "Sync"](dictInput, { dictionary })), decode: decompress });
      const streamed = await streamCase(Create, { dictionary, chunkSize: 64 }, [dictInput.subarray(0, 7), dictInput.subarray(7)]);
      cases.push({ name: `${compress} stream dictionary`, kind: "stream", create: Create, input: hex(dictInput), dictionary: hex(dictionary), flushes: [], ...streamed, decode: decompress });
    }
    const modes: [string, number[]][] = brotliOrZstd ? [["none", []], ["flush", [1]]] : [["none", []], ["sync flush", [2]], ["full flush", [3]]];
    for (const [label, flushes] of modes) {
      const writes: (Buffer | number)[] = [input.subarray(0, 7), ...flushes, input.subarray(7)];
      const streamed = await streamCase(Create, { chunkSize: 64 }, writes);
      cases.push({ name: `${compress} stream ${label}`, kind: "stream", create: Create, input: hex(input), flushes, ...streamed, decode: decompress });
    }
  }
  // Data-event boundaries: Node keeps filling one chunkSize buffer across writes.
  const tail = Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 7) & 255));
  const pieces = await streamCase("Gzip", { chunkSize: 64 }, [Buffer.from("a".repeat(300)), tail]);
  cases.push({ name: "gzip stream pieces", kind: "pieces", create: "Gzip", writes: [hex(Buffer.from("a".repeat(300))), hex(tail)], pieces: pieces.pieces });

  const corrupt: Case[] = [];
  for (const [compress, , decompress, Decompress] of specs) {
    const good = z[compress + "Sync"](input) as Buffer;
    const inputs: [string, Buffer][] = [
      ["garbage", Buffer.from([255, 255, 255, 255, 255])],
      ["truncated", good.subarray(0, 4)],
      ["empty", Buffer.alloc(0)],
    ];
    for (const [label, data] of inputs) {
      let sync: unknown = null;
      try { z[decompress + "Sync"](data); } catch (error) { sync = errorShape(error); }
      const stream = z["create" + Decompress]();
      const streamError = await new Promise(resolve => {
        stream.on("error", (error: unknown) => resolve(errorShape(error)));
        stream.on("end", () => resolve(null));
        stream.resume();
        stream.end(data);
      });
      corrupt.push({ name: `${decompress} ${label}`, fn: decompress, create: Decompress, input: hex(data), sync, stream: streamError });
    }
  }
  const dictionaryErrors: Case[] = [];
  const withDictionary = zlib.deflateSync("abc", { dictionary: Buffer.from("xyz") });
  for (const [label, options] of [["missing", {}], ["bad", { dictionary: Buffer.from("xyq") }]] as const) {
    let error: unknown = null;
    try { zlib.inflateSync(withDictionary, options); } catch (caught) { error = errorShape(caught); }
    dictionaryErrors.push({ name: `inflate ${label} dictionary`, input: hex(withDictionary), dictionary: "dictionary" in options ? hex(options.dictionary) : null, error });
  }

  const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024));
  const bigBomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
  const limits: Case[] = [];
  const shape = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return errorShape(error); } };
  limits.push({ name: "gunzipSync maxOutputLength", error: shape(() => zlib.gunzipSync(bomb, { maxOutputLength: 1024 })) });
  limits.push({ name: "_processChunk maxOutputLength", error: shape(() => (new zlib.Gunzip({ maxOutputLength: 1024 }) as any)._processChunk(bomb, zlib.constants.Z_NO_FLUSH)) });
  limits.push({ name: "gunzip callback maxOutputLength", error: await new Promise(resolve => zlib.gunzip(bomb, { maxOutputLength: 1024 }, error => resolve(error ? errorShape(error) : null))) });

  const bun: Case[] = [];
  const B = (globalThis as any).Bun;
  if (B) {
    bun.push({ name: "Bun.gzipSync", hex: hex(B.gzipSync(input)) });
    bun.push({ name: "Bun.deflateSync", hex: hex(B.deflateSync(input)) });
    bun.push({ name: "Bun.zstdCompressSync", hex: hex(B.zstdCompressSync(input)) });
    bun.push({ name: "Bun.zstdCompressSync level 19", hex: hex(B.zstdCompressSync(input, { level: 19 })) });
    bun.push({ name: "Bun.zstdCompressSync level 0", error: shape(() => B.zstdCompressSync(input, { level: 0 })) });
    bun.push({ name: "Bun.zstdDecompressSync garbage", error: shape(() => B.zstdDecompressSync(Buffer.from([1, 2, 3, 4, 5]))) });
    bun.push({ name: "Bun.gunzipSync garbage", error: shape(() => B.gunzipSync(Buffer.from([1, 2, 3, 4, 5]))) });
  }

  // A gzip tar whose only entry claims 8 GiB but stops after 1 MiB, and one
  // whose entry really expands to 48 MiB.
  function tarHeader(name: string, size: number) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644", 100);
    header.write("0000000", 108);
    header.write("0000000", 116);
    header.write(size.toString(8).padStart(11, "0"), 124);
    header.write("00000000000", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return header;
  }
  const truncatedArchive = zlib.gzipSync(Buffer.concat([tarHeader("huge.bin", 8 * 1024 ** 3 - 1), Buffer.alloc(1024 * 1024)]));
  const expandingArchive = zlib.gzipSync(Buffer.concat([tarHeader("large.bin", 48 * 1024 * 1024), Buffer.alloc(48 * 1024 * 1024), Buffer.alloc(1024)]));
  // GNU long-name ('L') and PAX ('x') records whose 64 MiB bodies precede a
  // small file: the metadata must be refused before it is read into memory.
  function metadataArchive(kind: string) {
    const size = 64 * 1024 * 1024;
    const header = tarHeader("././@LongLink", size);
    header[156] = kind.charCodeAt(0);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(size, 0x61);
    if (kind === "x") body.write(`${size} path=`, 0);
    body[size - 1] = 10;
    return zlib.gzipSync(Buffer.concat([header, body, tarHeader("file.txt", 0), Buffer.alloc(1024)]));
  }
  const longNameArchive = metadataArchive("L");
  const paxArchive = metadataArchive("x");

  return {
    runtime: B ? `bun ${B.version}` : `node ${process.version}`,
    cases, corrupt, dictionaryErrors, limits, bun,
    bomb: hex(bomb), bigBomb: hex(bigBomb),
    truncatedArchive: hex(truncatedArchive), expandingArchive: hex(expandingArchive),
    longNameArchive: hex(longNameArchive), paxArchive: hex(paxArchive),
  };
}

// Bun leaves these unchecked (a truncated or empty Zstd frame decodes to an
// empty buffer); Node reports Z_BUF_ERROR, which the fixture expects.
const nodeReference = new Set(["zstdDecompress truncated", "zstdDecompress empty"]);

function merge(nodeFile: string, bunFile: string) {
  const node = JSON.parse(readFileSync(nodeFile, "utf8"));
  const bun = JSON.parse(readFileSync(bunFile, "utf8"));
  const disagreements: string[] = [];
  const pick = (group: string) => (node[group] as Case[]).map((nodeCase, index) => {
    const bunCase = bun[group][index] as Case;
    if (JSON.stringify(nodeCase) === JSON.stringify(bunCase)) return nodeCase;
    disagreements.push(nodeCase.name);
    return nodeReference.has(nodeCase.name) ? nodeCase : bunCase;
  });
  const oracle = {
    node: node.runtime, bun: bun.runtime,
    cases: pick("cases"), corrupt: pick("corrupt"), dictionaryErrors: pick("dictionaryErrors"), limits: pick("limits"),
    bunFunctions: bun.bun, bomb: node.bomb, bigBomb: node.bigBomb,
    truncatedArchive: node.truncatedArchive, expandingArchive: node.expandingArchive,
    longNameArchive: node.longNameArchive, paxArchive: node.paxArchive,
    disagreements,
  };
  writeFileSync("tests/fixtures/compression-review/oracle.json", JSON.stringify(oracle) + "\n");
  console.log(`merged; Node and Bun disagree on: ${disagreements.join(", ") || "nothing"}`);
}

const [output, nodeOracle, bunOracle] = process.argv.slice(2);
if (!output) throw new Error("Expected output path or --merge <node-oracle> <bun-oracle>");
if (output === "--merge" && (!nodeOracle || !bunOracle)) throw new Error("Expected both oracle paths");
if (output === "--merge" && nodeOracle && bunOracle) merge(nodeOracle, bunOracle);
else writeFileSync(output, JSON.stringify(await record()));
