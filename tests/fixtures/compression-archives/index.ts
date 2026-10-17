import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from "node:fs";

function checksum(bytes: Uint8Array) {
  bytes.fill(32, 148, 156);
  const total = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.set(new TextEncoder().encode(total.toString(8).padStart(6, "0") + "\0 "), 148);
}

const source = Buffer.from("codec and archive content ".repeat(200));
const archive = new Bun.Archive({ "hello.txt": "hello", "src/a.ts": source, "src/a.test.ts": "test" }, { compress: "gzip" });
const bytes = await archive.bytes();
assert.equal(bytes[0], 0x1f);
const restored = new Bun.Archive(new Blob([bytes]));
const files = await restored.files("**/*.ts");
assert.equal(files.size, 2);
assert.equal(files.get("src/a.ts")?.name, "src/a.ts");
assert.deepEqual(Buffer.from(await files.get("src/a.ts")!.arrayBuffer()), source);
assert.equal(await restored.extract("out", { glob: ["**", "!**/*.test.ts"] }), 2);
assert.equal(readFileSync("out/hello.txt", "utf8"), "hello");
assert.equal(existsSync("out/src/a.test.ts"), false);
assert.equal(await new Bun.Archive({ "empty/": "", "package/file.txt": "package" }).extract("directories"), 2);
assert.equal(statSync("directories/empty").isDirectory(), true);
assert.equal(await Bun.Archive.write("saved.tar", new Bun.Archive({ "saved.txt": "saved" })), undefined);
assert.equal((await new Bun.Archive(await Bun.file("saved.tar").bytes()).files()).size, 1);
const originalData = new Uint8Array([1, 2, 3]);
const originalEntries = { "data.bin": originalData };
const immutable = new Bun.Archive(originalEntries);
originalData[0] = 255;
originalEntries["data.bin"] = new Uint8Array([9]);
assert.deepEqual(new Uint8Array(await (await immutable.files()).get("data.bin")!.arrayBuffer()), new Uint8Array([1, 2, 3]));
await Bun.write("via-bun.tar", immutable);
assert.deepEqual(new Uint8Array(await (await new Bun.Archive(await Bun.file("via-bun.tar").bytes()).files()).get("data.bin")!.arrayBuffer()), new Uint8Array([1, 2, 3]));
await assert.rejects(() => new Bun.Archive(new Uint8Array([1, 2, 3])).files());
mkdirSync("guard");
symlinkSync("..", "guard/link");
await assert.rejects(() => new Bun.Archive({ "link/escaped.txt": "escape" }).extract("guard"));
assert.equal(existsSync("escaped.txt"), false);
const link = await new Bun.Archive({ "alias.txt": "" }).bytes();
link[156] = 50;
link.set(new TextEncoder().encode("hello.txt"), 157);
checksum(link);
const original = await new Bun.Archive({ "hello.txt": "linked" }).bytes();
await new Bun.Archive(Buffer.concat([original.subarray(0, -1024), link])).extract("linked");
assert.equal(readlinkSync("linked/alias.txt"), "hello.txt");
assert.equal(readFileSync("linked/alias.txt", "utf8"), "linked");
function paxField(key: string, value: string): Uint8Array {
  const content = new TextEncoder().encode(`${key}=${value}\n`);
  for (let length = content.length + 2; ; length++) {
    const prefix = new TextEncoder().encode(`${length} `);
    if (prefix.length + content.length === length) return Buffer.concat([prefix, content]);
  }
}
const pax = Buffer.concat([
  paxField("GNU.sparse.major", "1"), paxField("GNU.sparse.minor", "0"),
  paxField("GNU.sparse.name", "sparse.bin"), paxField("GNU.sparse.realsize", "4096"),
]);
const paxHeader = await new Bun.Archive({ "PaxHeaders/sparse": pax }).bytes();
paxHeader[156] = 120;
checksum(paxHeader);
const sparseBody = new Uint8Array(515);
sparseBody.set(new TextEncoder().encode("2\n0\n3\n4096\n0\n"));
sparseBody.set([1, 2, 3], 512);
const sparseTar = await new Bun.Archive({ "GNUSparseFile.0/sparse.bin": sparseBody }).bytes();
const sparse = new Bun.Archive(Buffer.concat([paxHeader.subarray(0, -1024), sparseTar]));
const sparseFile = (await sparse.files()).get("sparse.bin")!;
assert.equal(sparseFile.size, 4096);
assert.deepEqual(new Uint8Array(await sparseFile.arrayBuffer()).subarray(0, 3), new Uint8Array([1, 2, 3]));
assert.equal(await sparse.extract("sparse"), 1);
assert.equal(statSync("sparse/sparse.bin").size, 4096);
assert.equal(readFileSync("sparse/sparse.bin")[4095], 0);
for (const time of [1n << 62n, -1n, 0n]) {
  const timestamp = await new Bun.Archive({ "time.txt": "" }).bytes();
  let field = time;
  for (let index = 147; index >= 136; index--) { timestamp[index] = Number(field & 255n); field >>= 8n; }
  timestamp[136] |= 128;
  checksum(timestamp);
  assert.equal((await new Bun.Archive(timestamp).files()).get("time.txt")?.lastModified, Number(time) * 1000);
}
console.log("archive round trip, filters, writes and safe extraction");

for (const [compress, decompress] of [
  ["gzip", "gunzip"], ["deflate", "inflate"], ["deflateRaw", "inflateRaw"],
  ["brotliCompress", "brotliDecompress"], ["zstdCompress", "zstdDecompress"],
] as const) {
  const encoded = zlib[`${compress}Sync`](source);
  assert.deepEqual(zlib[`${decompress}Sync`](encoded), source);
  const asynchronous = await new Promise<Buffer>((resolve, reject) => zlib[compress](source, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(zlib[`${decompress}Sync`](asynchronous), source);
  const stream = zlib[`create${compress[0].toUpperCase()}${compress.slice(1)}`]();
  const chunks: Buffer[] = [];
  stream.on("data", chunk => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  stream.write(source.subarray(0, 100));
  await new Promise<void>(resolve => stream.flush(() => resolve()));
  assert.ok(chunks.length > 0, `${compress} emits flushed data before end`);
  stream.end(source.subarray(100));
  await ended;
  assert.equal(stream.bytesWritten, source.length);
  assert.deepEqual(zlib[`${decompress}Sync`](Buffer.concat(chunks)), source);
  assert.throws(() => zlib[`${decompress}Sync`](encoded, { maxOutputLength: 10 }), { code: "ERR_BUFFER_TOO_LARGE" });
  console.log(`${compress} sync, callback and incremental stream`);
}

const first = zlib.zstdCompressSync("first");
const second = zlib.zstdCompressSync("second");
assert.equal(zlib.gunzipSync(Buffer.concat([zlib.gzipSync("first"), zlib.gzipSync("second")])).toString(), "firstsecond");
assert.equal(Bun.zstdDecompressSync(Buffer.concat([first, second])).toString(), "firstsecond");
assert.deepEqual(await Bun.zstdDecompress(await Bun.zstdCompress(source)), source);
assert.throws(() => Bun.zstdCompressSync(source, { level: 0 }));
assert.throws(() => zlib.createBrotliCompress({ params: { 99999: 1 } }), { code: "ERR_BROTLI_INVALID_PARAM" });
// Node and Bun store Brotli parameters unchecked; the encoder clamps them.
zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_NPOSTFIX]: 4 } }).destroy();
assert.throws(() => zlib.zstdCompressSync(source, { params: { 99999: 1 } }), { code: "ERR_ZSTD_INVALID_PARAM" });
assert.equal(zlib.crc32("world", zlib.crc32("hello ")), zlib.crc32("hello world"));
console.log("zstd frames, Bun functions, validation and seeded crc32");

for (const format of ["gzip", "deflate", "deflate-raw", "brotli", "zstd"]) {
  const output = new Blob([source]).stream().pipeThrough(new CompressionStream(format)).pipeThrough(new DecompressionStream(format));
  assert.deepEqual(Buffer.from(await new Response(output).arrayBuffer()), source);
}
console.log("Web compression round trips on every codec");

using server = Bun.serve({
  port: 0,
  fetch() { return new Response(Buffer.concat([first, second]), { headers: { "content-encoding": "zstd" } }); },
});
assert.equal(await (await fetch(server.url)).text(), "firstsecond");
console.log("fetch decodes concatenated zstd frames");
