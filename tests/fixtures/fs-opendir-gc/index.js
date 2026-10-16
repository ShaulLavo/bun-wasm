const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
fs.mkdirSync("gc-tree");
fs.writeFileSync("gc-tree/entry", "x");
const directory = path.resolve("gc-tree");
let nativeCount;
if (typeof Bun !== "undefined") nativeCount = require("bun:internal-for-testing").directoryCount;
else nativeCount = () => fs.readdirSync("/proc/self/fd").filter(fd => {
  try { return fs.readlinkSync("/proc/self/fd/" + fd) === directory; } catch { return false; }
}).length;
const collect = typeof Bun !== "undefined" ? () => Bun.gc(true) : () => globalThis.gc();
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 5));
function abandon() {
  return Array.from({ length: 20 }, () => new WeakRef(fs.opendirSync("gc-tree")));
}
async function main() {
  const baseline = nativeCount();
  const held = fs.opendirSync("gc-tree");
  const owners = abandon();
  assert.equal(nativeCount(), baseline + 21);
  for (let attempt = 0; attempt < 100 && nativeCount() !== baseline + 1; attempt++) {
    await nextTurn();
    collect();
    await nextTurn();
  }
  assert(owners.every(owner => owner.deref() === undefined), "all abandoned Dir owners were collected");
  assert.equal(nativeCount(), baseline + 1, "collected owners release their native cursors and descriptors");
  assert.equal(held.readSync().name, "entry");
  held.closeSync();
  await nextTurn();
  collect();
  await nextTurn();
  assert.equal(nativeCount(), baseline);
  console.log("20 collected Dir owners release 20 cursors; held Dir survives");
  globalThis.directoryForExit = fs.opendirSync("gc-tree");
}
main();
