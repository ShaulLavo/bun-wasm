import assert from "node:assert/strict";
import fs from "node:fs";

// Bun 1.4.2 returns 0 for [] even on closed positive fds; Node 26.7.0 returns
// EINVAL. This fixture deliberately is not part of the shared Bun/Node table.
console.log("Bun readv empty-vector behaviour");
const path = "readv-empty-input.txt";
fs.writeFileSync(path, "input");
const fd = fs.openSync(path, "r");
fs.closeSync(fd);
try {
  assert.equal(fs.readvSync(fd, []), 0);
  let returned = false;
  const buffers: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    fs.readv(fd, buffers, (error, count, original) => {
      if (error) return reject(error);
      assert(returned);
      assert.equal(count, 0);
      assert.equal(original, buffers);
      resolve();
    });
    returned = true;
  });
  assert.throws(() => fs.readvSync(-1, []), { code: "ERR_OUT_OF_RANGE" });
  assert.throws(() => fs.readvSync(fd, [Buffer.alloc(0)]), { code: "EBADF" });
  const handle = await fs.promises.open(path, "r");
  await handle.close();
  await assert.rejects(handle.readv([]), { code: "EBADF" });
  console.log("empty arrays skip native reads; empty views and closed handles do not");
} finally { fs.unlinkSync(path); }
