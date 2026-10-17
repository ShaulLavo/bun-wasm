// bun-wasm deliberately differs from native Bun 1.4.2 here (manual fixture):
// - extraction never writes through a symlink already in the destination
//   (Bun follows it out of the target; /work/reports/upstream-bugs entry 30);
// - a GNU PAX sparse file extracts at its logical size (Bun writes only the
//   stored bytes);
// - base-256 tar timestamps are decoded (Bun reports 0).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";

function checksum(bytes: Uint8Array) {
  bytes.fill(32, 148, 156);
  const total = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.set(new TextEncoder().encode(total.toString(8).padStart(6, "0") + "\0 "), 148);
}

mkdirSync("guard");
symlinkSync("..", "guard/link");
await assert.rejects(() => new Bun.Archive({ "link/escaped.txt": "escape" }).extract("guard"));
assert.equal(existsSync("escaped.txt"), false);
console.log("no extraction through an existing destination symlink");

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
console.log("sparse members extract at their logical size");

for (const time of [1n << 62n, -1n, 0n]) {
  const timestamp = await new Bun.Archive({ "time.txt": "" }).bytes();
  let field = time;
  for (let index = 147; index >= 136; index--) { timestamp[index] = Number(field & 255n); field >>= 8n; }
  timestamp[136] |= 128;
  checksum(timestamp);
  assert.equal((await new Bun.Archive(timestamp).files()).get("time.txt")?.lastModified, Number(time) * 1000);
}

console.log("base-256 timestamps");
