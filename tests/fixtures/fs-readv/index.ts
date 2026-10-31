import assert from "node:assert/strict";
import fs, { readv as readVector, readvSync as readVectorSync } from "node:fs";

console.log("readv shared Bun/Node cases");
const path = "readv-input.txt";
fs.writeFileSync(path, "abcdefgh");
const fd = fs.openSync(path, "r");
let open = true;
try {
  const backing = Buffer.alloc(12, ".");
  const views = [backing.subarray(1, 3), new DataView(backing.buffer, backing.byteOffset + 5, 4)];
  assert.equal(readVectorSync(fd, views, 2), 6);
  assert.equal(backing.toString(), ".cd..efgh...");
  const cursor = Buffer.alloc(1);
  assert.equal(fs.readSync(fd, cursor), 1);
  assert.equal(cursor.toString(), "a");

  let returned = false;
  const callbackViews = [Buffer.alloc(2, "."), Buffer.alloc(4, ".")];
  await new Promise<void>((resolve, reject) => {
    readVector(fd, callbackViews, 5, (error, count, buffers) => {
      if (error) return reject(error);
      assert(returned);
      assert.equal(count, 3);
      assert.equal(buffers, callbackViews);
      resolve();
    });
    returned = true;
  });
  assert.deepEqual(callbackViews.map(view => view.toString()), ["fg", "h..."]);
  assert.equal(fs.readSync(fd, cursor), 1);
  assert.equal(cursor.toString(), "b");
  const eof = Buffer.from("keep");
  assert.equal(fs.readvSync(fd, [eof], 99), 0);
  assert.equal(eof.toString(), "keep");

  const handle = await fs.promises.open(path, "r");
  try {
    const buffers = [Buffer.alloc(2), new Uint8Array(2)];
    const result = await handle.readv(buffers, 3);
    assert.equal(result.bytesRead, 4);
    assert.equal(result.buffers, buffers);
    assert.equal(Buffer.concat(buffers).toString(), "defg");
    const next = Buffer.alloc(1);
    assert.equal((await handle.read(next)).bytesRead, 1);
    assert.equal(next.toString(), "a");
  } finally { await handle.close(); }
  await assert.rejects(handle.readv([]), { code: "EBADF" });

  const last = Buffer.from(".");
  const prefix = Array.from({ length: 1023 }, () => Buffer.alloc(0));
  assert.equal(fs.readvSync(fd, prefix.concat([last]), 0), 1);
  assert.equal(last.toString(), "a");
  last.fill(".");
  assert.equal(fs.readvSync(fd, prefix.concat([Buffer.alloc(0), last]), 0), 0);
  assert.equal(last.toString(), ".");

  const aliased = Buffer.alloc(4 * 1024 * 1024, ".");
  const aliases = Array.from({ length: 1024 }, () => aliased);
  assert.equal(readVectorSync(fd, aliases, 0), 8);
  assert.equal(aliased.subarray(0, 10).toString(), "abcdefgh..");
  await new Promise<void>((resolve, reject) => {
    readVector(fd, aliases, 0, (error, count, buffers) => {
      if (error) return reject(error);
      assert.equal(count, 8);
      assert.equal(buffers, aliases);
      resolve();
    });
  });
  assert.equal(fs.readSync(fd, cursor), 1);
  assert.equal(cursor.toString(), "c");

  fs.closeSync(fd);
  open = false;
  assert.throws(() => fs.readvSync(fd, [Buffer.alloc(0)]), { code: "EBADF" });
  assert.throws(() => fs.readvSync(fd, [Buffer.alloc(0), new DataView(new ArrayBuffer(0))]), { code: "EBADF" });
  assert.throws(() => fs.readvSync(fd, [Buffer.alloc(1)]), { code: "EBADF" });
  const callbackError = await new Promise<NodeJS.ErrnoException | null>(resolve => {
    fs.readv(fd, [Buffer.alloc(0)], error => resolve(error));
  });
  assert.equal(callbackError?.code, "EBADF");
  assert.throws(() => fs.readvSync(-1, []), { code: "ERR_OUT_OF_RANGE" });
  for (const invalid of [null, ["text"], [{}], [new ArrayBuffer(0)]]) {
    assert.throws(() => fs.readvSync(fd, invalid as unknown as NodeJS.ArrayBufferView[]), { code: "ERR_INVALID_ARG_TYPE" });
  }
  console.log("mixed views, short reads, cursor, EOF, callbacks, handles and errors passed");
} finally {
  if (open) fs.closeSync(fd);
  fs.unlinkSync(path);
}
