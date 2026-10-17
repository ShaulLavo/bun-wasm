// Regressions for the PR #57 review: output limits, dictionaries, flush and
// chunk bytes, native-compatible output, Web stream options, corrupt-input
// codes and Archive expansion. oracle.json holds real Node/Bun output
// (scripts/generate-compression-oracle.ts); the Web stream expectations are
// Bun's own (vendor/bun test/js/web/streams/compression.test.ts).
import * as z from "node:zlib";
import { statSync } from "node:fs";
import oracle from "./oracle.json";

const zlib = z as unknown as Record<string, any>;
const fromHex = (text: string) => Buffer.from(text, "hex");
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
let failures = 0;
async function check(name: string, fn: () => unknown) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (error) {
    failures++;
    console.log("FAIL " + name + ": " + (error instanceof Error ? error.message : String(error)));
  }
}
function equal(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: ${a} != ${e}`);
}
function shape(error: any) {
  return error == null ? null : { class: error.constructor?.name, message: error.message, code: error.code, errno: error.errno };
}
function thrown(fn: () => unknown) {
  try { fn(); } catch (error) { return error as any; }
  return undefined;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const rss = () => process.memoryUsage().rss;

// 1, 4: one-shot bytes, Node stream bytes under every flush mode, and the
// data-event boundaries, against real Node/Bun output.
async function streamCase(create: string, options: object, writes: (Uint8Array | number)[]) {
  const stream = zlib["create" + create](options);
  const pieces: Uint8Array[] = [];
  stream.on("data", (piece: Uint8Array) => pieces.push(piece));
  const done = new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  for (let i = 0; i < writes.length; i++) {
    const step = writes[i];
    if (typeof step === "number") await new Promise<void>(resolve => stream.flush(step, () => resolve()));
    else if (i === writes.length - 1) stream.end(step);
    else stream.write(step);
  }
  await done;
  return { hex: toHex(Buffer.concat(pieces)), pieces: pieces.map(piece => piece.length) };
}
for (const c of oracle.cases as any[]) {
  await check(`zlib ${c.name}`, async () => {
    const dictionary = c.dictionary ? fromHex(c.dictionary) : undefined;
    if (c.kind === "sync") {
      equal(toHex(zlib[c.fn + "Sync"](fromHex(c.input), dictionary ? { dictionary } : {})), c.hex, "bytes");
    } else if (c.kind === "stream") {
      const input = fromHex(c.input);
      const writes: (Uint8Array | number)[] = [input.subarray(0, 7), ...c.flushes, input.subarray(7)];
      const options = dictionary ? { dictionary, chunkSize: 64 } : { chunkSize: 64 };
      equal(await streamCase(c.create, options, writes), { hex: c.hex, pieces: c.pieces }, "stream");
    } else {
      const result = await streamCase(c.create, { chunkSize: 64 }, c.writes.map(fromHex));
      equal(result.pieces, c.pieces, "pieces");
    }
    if (c.decode) equal(toHex(zlib[c.decode + "Sync"](fromHex(c.hex), dictionary ? { dictionary } : {})), c.input, "round trip");
  });
}
for (const c of oracle.bunFunctions as any[]) {
  await check(c.name, () => {
    const input = Buffer.from("hello hello hello");
    const run: Record<string, () => Uint8Array> = {
      "Bun.gzipSync": () => Bun.gzipSync(input),
      "Bun.deflateSync": () => Bun.deflateSync(input),
      "Bun.zstdCompressSync": () => Bun.zstdCompressSync(input),
      "Bun.zstdCompressSync level 19": () => Bun.zstdCompressSync(input, { level: 19 }),
      "Bun.zstdCompressSync level 0": () => Bun.zstdCompressSync(input, { level: 0 }),
      "Bun.zstdDecompressSync garbage": () => Bun.zstdDecompressSync(Buffer.from([1, 2, 3, 4, 5])),
      "Bun.gunzipSync garbage": () => Bun.gunzipSync(Buffer.from([1, 2, 3, 4, 5])),
    };
    if (c.hex) equal(toHex(run[c.name]()), c.hex, "bytes");
    else equal(shape(thrown(run[c.name])), c.error, "error");
  });
}

// 2: dictionaries are copied when the stream is made and must match.
await check("zlib dictionary is snapshotted", async () => {
  const c = (oracle.cases as any[]).find(c => c.name === "deflate stream dictionary");
  const dictionary = fromHex(c.dictionary);
  const stream = z.createDeflate({ dictionary, chunkSize: 64 });
  dictionary.fill(0);
  const pieces: Uint8Array[] = [];
  const done = new Promise((resolve, reject) => { stream.on("data", piece => pieces.push(piece)); stream.on("end", resolve); stream.on("error", reject); });
  const input = fromHex(c.input);
  stream.write(input.subarray(0, 7));
  stream.end(input.subarray(7));
  await done;
  equal(toHex(Buffer.concat(pieces)), c.hex);
});
await check("zlib dictionary validation", () => {
  for (const name of ["deflateSync", "inflateRawSync", "brotliCompressSync"]) {
    equal(thrown(() => zlib[name]("hello", { dictionary: "words" }))?.code, "ERR_INVALID_ARG_TYPE", name);
  }
});
for (const c of oracle.dictionaryErrors as any[]) {
  await check(`zlib ${c.name}`, () => {
    const options = c.dictionary ? { dictionary: fromHex(c.dictionary) } : {};
    equal(shape(thrown(() => z.inflateSync(fromHex(c.input), options))), c.error);
  });
}

// 6: corrupt, truncated and empty input keep Node's codes on both paths.
for (const c of oracle.corrupt as any[]) {
  await check(`zlib corrupt ${c.name}`, async () => {
    equal(shape(thrown(() => zlib[c.fn + "Sync"](fromHex(c.input)))), c.sync, "sync");
    const stream = zlib["create" + c.create]();
    const error = await new Promise(resolve => {
      stream.on("error", (error: unknown) => resolve(shape(error)));
      stream.on("end", () => resolve(null));
      stream.resume();
      stream.end(fromHex(c.input));
    });
    equal(error, c.stream, "stream");
  });
}

// Zstd streams decode every frame (Bun) and report one cut short (Node).
await check("zlib zstd stream frame boundaries", async () => {
  const frame = z.zstdCompressSync("hi");
  async function decode(writes: Uint8Array[]) {
    const stream = z.createZstdDecompress();
    let text = "";
    const result = new Promise(resolve => {
      stream.on("data", (piece: Uint8Array) => { text += Buffer.from(piece).toString(); });
      stream.on("error", (error: any) => resolve(error.code));
      stream.on("end", () => resolve(text));
    });
    for (const bytes of writes) { stream.write(bytes); await tick(); }
    stream.end();
    return result;
  }
  equal(await decode([frame]), "hi", "one frame");
  equal(await decode([Buffer.concat([frame, frame])]), "hihi", "two frames");
  equal(await decode([frame.subarray(0, 5), frame.subarray(5)]), "hi", "split frame");
  equal(await decode([frame.subarray(0, 5)]), "Z_BUF_ERROR", "truncated frame");
});

// 1: maxOutputLength stops the expansion after one piece.
const bomb = fromHex(oracle.bomb);
const bigBomb = fromHex(oracle.bigBomb);
for (const c of oracle.limits as any[]) {
  await check(`zlib ${c.name}`, async () => {
    const before = rss();
    let error: unknown;
    if (c.name.startsWith("gunzipSync")) error = thrown(() => z.gunzipSync(bigBomb, { maxOutputLength: 1024 }));
    else if (c.name.startsWith("_processChunk")) error = thrown(() => (new z.Gunzip({ maxOutputLength: 1024 }) as any)._processChunk(bigBomb, z.constants.Z_NO_FLUSH));
    else error = await new Promise(resolve => z.gunzip(bigBomb, { maxOutputLength: 1024 }, resolve));
    equal(shape(error), c.error);
    if (rss() - before > 16 * 1024 * 1024) throw new Error(`memory grew by ${rss() - before} bytes`);
  });
}
await check("zlib stream expands only as it is read", async () => {
  const stream = z.createGunzip({ chunkSize: 1024 });
  let produced = 0;
  let largest = 0;
  stream.pause();
  stream.write(bomb);
  for (let i = 0; i < 20; i++) await tick();
  // Paused: the readable buffer fills to its high-water mark, then stops.
  const buffered = stream.readableLength;
  if (buffered > 64 * 1024) throw new Error(`buffered ${buffered} bytes while paused`);
  stream.on("data", (piece: Uint8Array) => { produced += piece.length; largest = Math.max(largest, piece.length); });
  stream.resume();
  stream.end();
  await new Promise((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  equal([produced, largest], [4 * 1024 * 1024, 1024]);
});

// 7: Archive reads gzip tar input as the parser needs it.
await check("Archive rejects a truncated entry without allocating its size", async () => {
  const before = rss();
  const archive = new Bun.Archive(fromHex(oracle.truncatedArchive));
  let error: unknown;
  try { await archive.files(); } catch (caught) { error = caught; }
  if (!error) throw new Error("expected a read error");
  if (rss() - before > 64 * 1024 * 1024) throw new Error(`memory grew by ${rss() - before} bytes`);
});
await check("Archive extracts a large expansion in bounded memory", async () => {
  const before = rss();
  const count = await new Bun.Archive(fromHex(oracle.expandingArchive)).extract("out");
  equal([count, statSync("out/large.bin").size], [1, 48 * 1024 * 1024]);
  if (rss() - before > 24 * 1024 * 1024) throw new Error(`memory grew by ${rss() - before} bytes`);
});

// Re-review 1: like libarchive (Bun), a GNU long-name or PAX record over
// 1 MiB is skipped without being held in memory; the member keeps its name.
for (const [name, key] of [["GNU long name", "longNameArchive"], ["PAX header", "paxArchive"]] as const) {
  await check(`Archive skips an oversized ${name} in bounded memory`, async () => {
    const bytes = fromHex((oracle as any)[key]);
    const before = rss();
    equal([...(await new Bun.Archive(bytes).files()).keys()], ["file.txt"], "files");
    equal(await new Bun.Archive(bytes).extract("metadata"), 1, "extract");
    if (rss() - before > 32 * 1024 * 1024) throw new Error(`memory grew by ${rss() - before} bytes`);
  });
}

// Re-review 3: rejectGarbageAfterEnd on every path (Node v26.7.0).
await check("zlib rejectGarbageAfterEnd", async () => {
  const junk = Buffer.from([1, 2, 3]);
  for (const [compress, decompress, Create] of [["deflate", "inflate", "Inflate"], ["brotliCompress", "brotliDecompress", "BrotliDecompress"], ["zstdCompress", "zstdDecompress", "ZstdDecompress"], ["gzip", "gunzip", "Gunzip"]]) {
    const frame = zlib[compress + "Sync"]("hello");
    const input = Buffer.concat([frame, junk]);
    const options = { rejectGarbageAfterEnd: true };
    const expected = { class: "TypeError", message: "Trailing junk found after the end of the compressed stream", code: "ERR_TRAILING_JUNK_AFTER_STREAM_END" };
    equal(shape(thrown(() => zlib[decompress + "Sync"](input, options))), expected, `${decompress} sync`);
    equal(shape(thrown(() => zlib[decompress + "Sync"](input, { ...options, info: true }))), expected, `${decompress} info`);
    equal(shape(await new Promise(resolve => zlib[decompress](input, options, resolve))), expected, `${decompress} callback`);
    const stream = zlib["create" + Create](options);
    const streamed = await new Promise(resolve => { stream.on("error", resolve); stream.on("end", () => resolve(null)); stream.resume(); stream.end(input); });
    equal(shape(streamed), expected, `${decompress} stream`);
    if (decompress !== "gunzip") equal(zlib[decompress + "Sync"](input).toString(), "hello", `${decompress} default`);
  }
  const members = Buffer.concat([z.gzipSync("hi"), z.gzipSync("hi")]);
  equal(z.gunzipSync(members).toString(), "hihi", "members");
  equal(thrown(() => z.gunzipSync(members, { rejectGarbageAfterEnd: true }))?.code, "ERR_TRAILING_JUNK_AFTER_STREAM_END", "members rejected");
});

// Re-review 4: each option is read once, as Bun reads it.
await check("Compression options are read once", async () => {
  function once(value: unknown) {
    const box = { reads: 0 };
    return [box, () => { if (box.reads++) throw new Error("read twice"); return value; }] as const;
  }
  const [levelReads, level] = once(3);
  Bun.zstdCompressSync("hello", { get level() { return level(); } } as any);
  const [highWaterMarkReads, highWaterMark] = once(1024);
  const [webLevelReads, webLevel] = once(6);
  new CompressionStream("gzip", { get highWaterMark() { return highWaterMark(); }, get level() { return webLevel(); } } as any);
  const [decompressReads, decompressMark] = once(1024);
  new DecompressionStream("gzip", { get highWaterMark() { return decompressMark(); } } as any);
  equal([levelReads.reads, highWaterMarkReads.reads, webLevelReads.reads, decompressReads.reads], [1, 1, 1, 1]);
});

// 5 and 1: Web streams take Bun's level and queuing-strategy options and
// emit an expansion one bounded step at a time.
async function readAll(readable: ReadableStream<Uint8Array>) {
  const pieces: Uint8Array[] = [];
  for await (const piece of readable) pieces.push(piece);
  return pieces;
}
async function webCompress(format: string, options: object | undefined, input: Uint8Array) {
  const cs = new CompressionStream(format as any, options as any);
  const writer = cs.writable.getWriter();
  const written = (async () => { await writer.write(input); await writer.close(); })();
  const pieces = await readAll(cs.readable);
  await written;
  return Buffer.concat(pieces);
}
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let text = "";
for (let i = 0; text.length < 64000; i++) text += `<section id="s${i}"><p>${rand().toString(36).slice(2)} lorem ipsum ${((i * 2654435761) >>> 0).toString(36)}</p></section>`;
const page = Buffer.from(text);
await check("Web level selects the compression level", async () => {
  const inflate: Record<string, (bytes: Uint8Array) => Uint8Array> = { gzip: z.gunzipSync, "deflate-raw": z.inflateRawSync, brotli: z.brotliDecompressSync, zstd: z.zstdDecompressSync };
  for (const [format, low, high] of [["gzip", 0, 9], ["deflate-raw", 0, 9], ["brotli", 1, 11], ["zstd", 1, 19]] as const) {
    const [a, b] = [await webCompress(format, { level: low }, page), await webCompress(format, { level: high }, page)];
    if (!(a.length > b.length)) throw new Error(`${format}: level ${low} ${a.length} <= level ${high} ${b.length}`);
    equal(Buffer.from(inflate[format](a)).equals(page) && Buffer.from(inflate[format](b)).equals(page), true, format);
  }
  equal((await webCompress("brotli", undefined, page)).equals(await webCompress("brotli", { level: 11 }, page)), true, "brotli default");
  equal((await webCompress("brotli", { level: 1, highWaterMark: 1024 }, page)).equals(await webCompress("brotli", { level: 1 }, page)), true, "level with highWaterMark");
});
await check("Web level validation", () => {
  const message = (format: string, level: unknown) => thrown(() => new CompressionStream(format as any, { level } as any));
  equal(shape(message("brotli", 12)), { class: "RangeError", message: "The compression level must be an integer between 0 and 11 for brotli" });
  equal(shape(message("gzip", 10)), { class: "RangeError", message: "The compression level must be an integer between 0 and 9 for gzip" });
  equal(shape(message("zstd", 0)), { class: "RangeError", message: "The compression level must be an integer between 1 and 22 for zstd" });
  for (const [format, level] of [["brotli", -1], ["brotli", 4.5], ["brotli", NaN], ["zstd", 23]] as const) {
    if (!(message(format, level) instanceof RangeError)) throw new Error(`${format} accepted ${level}`);
  }
  new CompressionStream("brotli", { level: undefined } as any);
  new DecompressionStream("brotli", { level: 99 } as any);
});
await check("Web queuing strategy validation", () => {
  if (!(thrown(() => new DecompressionStream("gzip", { highWaterMark: -1 } as any)) instanceof RangeError)) throw new Error("-1");
  if (!(thrown(() => new CompressionStream("gzip", { highWaterMark: NaN } as any)) instanceof RangeError)) throw new Error("NaN");
  if (!(thrown(() => new DecompressionStream("gzip", 4096 as any)) instanceof TypeError)) throw new Error("number");
  new DecompressionStream("gzip", {} as any);
  new DecompressionStream("gzip", undefined);
  equal(thrown(() => new CompressionStream("lz4" as any))?.code, "ERR_INVALID_ARG_VALUE");
});
async function readExactly(reader: ReadableStreamDefaultReader<Uint8Array>, length: number) {
  const pieces: Uint8Array[] = [];
  let total = 0;
  while (total < length) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`ended after ${total} bytes`);
    pieces.push(value);
    total += value.byteLength;
  }
  equal(total, length, "total");
  return pieces;
}
const expanded = 4 * 1024 * 1024;
const largest = (pieces: Uint8Array[]) => pieces.reduce((max, piece) => Math.max(max, piece.byteLength), 0);
await check("Web decompression steps as the reader pulls", async () => {
  for (const [format, compress] of [["gzip", z.gzipSync], ["deflate", z.deflateSync], ["deflate-raw", z.deflateRawSync], ["brotli", z.brotliCompressSync], ["zstd", z.zstdCompressSync]] as const) {
    const ds = new DecompressionStream(format as any);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const write = writer.write(compress(Buffer.alloc(expanded, 0x41)));
    const first = await reader.read();
    if (first.value!.byteLength > 65536) throw new Error(`${format}: first piece ${first.value!.byteLength}`);
    equal(await Promise.race([write.then(() => "settled"), tick().then(() => "pending")]), "pending", format);
    const rest = await readExactly(reader, expanded - first.value!.byteLength);
    if (largest(rest) > 65536) throw new Error(`${format}: piece ${largest(rest)}`);
    await write;
    await writer.close();
    equal(await reader.read(), { done: true }, format);
  }
});
await check("Web highWaterMark sets the step size", async () => {
  for (const highWaterMark of [16 * 1024, 1024 * 1024]) {
    const ds = new DecompressionStream("brotli", { highWaterMark } as any);
    const writer = ds.writable.getWriter();
    const write = writer.write(z.brotliCompressSync(Buffer.alloc(expanded, 0x41), { params: { [z.constants.BROTLI_PARAM_QUALITY]: 5 } }));
    const pieces = await readExactly(ds.readable.getReader(), expanded);
    equal(largest(pieces), highWaterMark, "largest");
    await write;
    await writer.close();
  }
  const ds = new DecompressionStream("zstd", { highWaterMark: Infinity } as any);
  const writer = ds.writable.getWriter();
  const write = writer.write(z.zstdCompressSync(Buffer.alloc(expanded, 0x41)));
  equal((await ds.readable.getReader().read()).value!.byteLength, expanded, "Infinity");
  await write;
});
await check("Web writes wait for the reader", async () => {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  await writer.write(new Uint8Array(1024));
  const second = writer.write(new Uint8Array(1024));
  equal(await Promise.race([second.then(() => "done"), tick().then(() => "pending")]), "pending");
  await reader.read();
  await second;
  void writer.close();
  while (!(await reader.read()).done) { /* drain */ }
});
await check("Web cancel settles the write in flight", async () => {
  const ds = new DecompressionStream("brotli");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const write = writer.write(z.brotliCompressSync(Buffer.alloc(expanded, 0x41)));
  await reader.read();
  await reader.cancel(new Error("too large"));
  equal(await write, undefined);
  equal(await writer.closed.then(() => "closed", (error: Error) => error.message), "too large");
});
await check("Web abort settles the write and errors the readable", async () => {
  const ds = new DecompressionStream("brotli");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const write = writer.write(z.brotliCompressSync(Buffer.alloc(expanded, 0x41)));
  await reader.read();
  await writer.abort(new Error("stop"));
  equal(await write, undefined);
  equal(await reader.read().then(() => "read", (error: Error) => error.message), "stop");
});
await check("Web abort during close keeps the flush", async () => {
  const input = new Uint8Array(100 * 1024).map((_, i) => (i * 2654435761) >>> 24);
  const cs = new CompressionStream("zstd");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  await writer.write(input);
  const closed = writer.close();
  const pieces = [(await reader.read()).value!];
  const aborted = writer.abort(new Error("stop"));
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pieces.push(value);
  }
  equal(Buffer.from(z.zstdDecompressSync(Buffer.concat(pieces))).equals(Buffer.from(input)), true);
  equal(await Promise.all([closed, aborted]), [undefined, undefined]);
});
await check("Web errors keep Bun's codes", async () => {
  const ds = new DecompressionStream("brotli");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array([255, 255, 255, 255, 255, 255])).catch(() => {});
  writer.close().catch(() => {});
  const error: any = await readAll(ds.readable).then(() => null, error => error);
  equal([error instanceof TypeError, error?.code, error?.cause?.code], [true, "ERR__ERROR_FORMAT_PADDING_2", "ERR__ERROR_FORMAT_PADDING_2"]);
  const junk = new DecompressionStream("deflate");
  const junkWriter = junk.writable.getWriter();
  junkWriter.write(Buffer.concat([z.deflateSync("hello"), Buffer.from([1, 2, 3])])).catch(() => {});
  junkWriter.close().catch(() => {});
  equal((await readAll(junk.readable).then(() => null, error => error))?.code, "ERR_TRAILING_JUNK_AFTER_STREAM_END");
  const nullWriter = new CompressionStream("gzip").writable.getWriter();
  equal(await nullWriter.write(null as any).then(() => null, error => error.code), "ERR_STREAM_NULL_VALUES");
});

if (failures) throw new Error(failures + " compression regressions");
