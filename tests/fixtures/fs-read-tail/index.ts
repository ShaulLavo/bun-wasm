import assert from "node:assert/strict";
import fs from "node:fs";

const path = "tail.txt";
fs.writeFileSync(path, "abcdef");
const fd = fs.openSync(path, "r");
try {
  const prefix = Buffer.alloc(3);
  assert.equal(fs.readSync(fd, prefix), 3);
  assert.equal(prefix.toString(), "abc");
  const target = Buffer.alloc(65536, 46);
  assert.equal(fs.readSync(fd, target, 0, target.length, 5), 1);
  assert.equal(target[0], 102);
  assert.equal(target[1], 46);
  assert.equal(fs.readSync(fd, target, 0, target.length, 99), 0);
  assert.equal(fs.readFileSync(fd, "utf8"), "def");
  assert.equal(fs.readFileSync(fd).length, 0);
} finally { fs.closeSync(fd); }

const streamFd = fs.openSync(path, "r");
try {
  fs.readSync(streamFd, Buffer.alloc(3));
  const positioned = fs.createReadStream(path, { fd: streamFd, start: 5, autoClose: false });
  const chunks: Buffer[] = [];
  for await (const chunk of positioned) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "f");
  assert.equal(positioned.bytesRead, 1);
  assert.equal(fs.readFileSync(streamFd, "utf8"), "def");
} finally { fs.closeSync(streamFd); }

fs.writeFileSync("empty.txt", "");
const empty = fs.openSync("empty.txt", "r");
try { assert.equal(fs.readFileSync(empty).length, 0); }
finally { fs.closeSync(empty); }
const writeonly = fs.openSync("empty.txt", "w");
try { assert.throws(() => fs.readSync(writeonly, Buffer.alloc(65536)), { code: "EBADF" }); }
finally { fs.closeSync(writeonly); }
assert.throws(() => fs.readFileSync(2147483647), { code: "EBADF" });
console.log("regular tail, EOF, stream position and descriptor errors passed");
