const fs = require("node:fs");
const assert = require("node:assert/strict");

assert.equal(fs.readSync(0, new Uint8Array(0), 0, 0, null), 0);
assert.equal(fs.readSync(0, new Uint8Array(4), 2, 0, null), 0);
assert.equal(fs.readSync(0, new Uint8Array(4), { offset: 2, length: 0 }), 0);
console.log("sync empty reads returned 0");

const fd = fs.openSync("index.js", "r");
assert.equal(fs.readSync(fd, new Uint8Array(0), 0, 0, null), 0);
fs.closeSync(fd);
assert.throws(() => fs.readSync(fd, new Uint8Array(1), 0, 1, null), { code: "EBADF" });
console.log("file and closed fd checked");

fs.read(0, new Uint8Array(0), 0, 0, null, async (err, bytesRead, buffer) => {
  assert.ifError(err);
  assert.equal(bytesRead, 0);
  assert.equal(buffer.length, 0);
  console.log("callback empty read returned 0");
  const file = await fs.promises.open("index.js", "r");
  const result = await file.read(new Uint8Array(0), 0, 0, null);
  assert.equal(result.bytesRead, 0);
  await file.close();
  console.log("promise empty read returned 0");
});
