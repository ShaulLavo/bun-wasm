// webpack's persistent cache reads a whole pack in one fs.read and gunzips it
// with a 100 MiB chunkSize. In a 512 MiB wasm32 guest, a full-size copy per
// read and one doubling output buffer per codec call failed to allocate in a
// fragmented heap during a Next.js dev server's idle cache store.
import fs from "node:fs";
import zlib from "node:zlib";

const MiB = 2 ** 20;
const size = 40 * MiB;
const data = Buffer.alloc(size, "webpack pack 0123456789 ");
fs.writeFileSync("large.bin", data);
const rss = () => process.memoryUsage().rss;

const target = Buffer.allocUnsafeSlow(size + 5);
const fd = fs.openSync("large.bin", "r");
// Use up the free heap left by the write, so a full-size temporary has to grow memory.
const fillers: Buffer[] = [];
for (const start = rss(); rss() === start;) fillers.push(Buffer.alloc(MiB));
const before = rss();
const positional = fs.readSync(fd, target, 0, size + 5, 0);
const growth = rss() - before;
console.log("positional read stops at end of file", positional === size && target.subarray(0, size).equals(data));
console.log("read growth under 8 MiB", growth < 8 * MiB);
fillers.length = 0;
const cursor = Buffer.alloc(3 * MiB);
console.log("cursor reads continue", fs.readSync(fd, cursor, 0, cursor.length, null) === cursor.length && cursor.equals(data.subarray(0, cursor.length)));
console.log("cursor reads advance", fs.readSync(fd, cursor, 0, cursor.length, null) === cursor.length && cursor.equals(data.subarray(cursor.length, 2 * cursor.length)));
const callback = await new Promise<number>((resolve, reject) => {
  fs.read(fd, target, 0, size, MiB, (error, count) => error ? reject(error) : resolve(count));
});
console.log("callback read", callback === size - MiB && target.subarray(0, size - MiB).equals(data.subarray(MiB)));
fs.closeSync(fd);

const compressed = zlib.gzipSync(data);
const pieces = await new Promise<Buffer[]>((resolve, reject) => {
  const parts: Buffer[] = [];
  const gunzip = zlib.createGunzip({ chunkSize: 100 * MiB });
  gunzip.on("data", chunk => parts.push(chunk));
  gunzip.on("end", () => resolve(parts));
  gunzip.on("error", reject);
  gunzip.end(compressed);
});
console.log("gunzip round trip", Buffer.concat(pieces).equals(data));
console.log("gunzip pieces at most 1 MiB", pieces.length > 1 && pieces.every(piece => piece.length <= MiB));
const recompressed = await new Promise<Buffer[]>((resolve, reject) => {
  const parts: Buffer[] = [];
  const gzip = zlib.createGzip({ chunkSize: 100 * MiB, level: zlib.constants.Z_BEST_SPEED });
  gzip.on("data", chunk => parts.push(chunk));
  gzip.on("end", () => resolve(parts));
  gzip.on("error", reject);
  gzip.end(data);
});
console.log("gzip round trip", zlib.gunzipSync(Buffer.concat(recompressed)).equals(data));
const sample = data.subarray(0, 3 * MiB + 7);
const streamed = await new Promise<Buffer>((resolve, reject) => {
  const parts: Buffer[] = [];
  const deflate = zlib.createDeflate();
  deflate.on("data", chunk => parts.push(chunk));
  deflate.on("end", () => resolve(Buffer.concat(parts)));
  deflate.on("error", reject);
  deflate.end(sample);
});
console.log("one large deflate write matches deflateSync", streamed.equals(zlib.deflateSync(sample)));
const brotli = await new Promise<Buffer>((resolve, reject) => {
  const parts: Buffer[] = [];
  const encoder = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  encoder.on("data", chunk => parts.push(chunk));
  encoder.on("end", () => resolve(Buffer.concat(parts)));
  encoder.on("error", reject);
  encoder.end(sample);
});
console.log("brotli round trip", zlib.brotliDecompressSync(brotli).equals(sample));
console.log("sync inflate of a large input", zlib.inflateSync(zlib.deflateSync(sample)).equals(sample));
