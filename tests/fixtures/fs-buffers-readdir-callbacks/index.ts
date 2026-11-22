import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = fs.mkdtempSync("fs-brc-");

try {
  // 1. fs.read and fs.readv pin destination ArrayBuffers while pending.
  {
    const dataPath = path.join(root, "data.bin");
    fs.writeFileSync(dataPath, Buffer.alloc(64, 0x61));
    const fd = fs.openSync(dataPath, "r");
    const ab = new ArrayBuffer(64);
    const view = new Uint8Array(ab);
    const pending = new Promise<number>((resolve, reject) => {
      fs.read(fd, view, 0, 64, 0, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)));
    });
    const copy = ab.transfer();
    const bytesRead = await pending;
    assert.equal(bytesRead, 64);
    assert.equal(ab.detached, false);
    assert.equal(view.byteLength, 64);
    assert.equal(view[0], 0x61);
    assert.equal(view[63], 0x61);
    assert.equal(copy.byteLength, 64);

    const ab2 = new ArrayBuffer(32);
    const view2 = new Uint8Array(ab2);
    const pendingV = new Promise<number>((resolve, reject) => {
      fs.readv(fd, [view2], 0, (err, n) => (err ? reject(err) : resolve(n)));
    });
    ab2.transfer();
    assert.equal(await pendingV, 32);
    assert.equal(ab2.detached, false);
    assert.equal(view2[0], 0x61);
    fs.closeSync(fd);
  }

  // 2. writevSync snapshots buffers once and treats buffers detached by an index getter as empty.
  {
    const outPath = path.join(root, "writev.bin");
    const first = new Uint8Array(new ArrayBuffer(16)).fill(0x41);
    const second = new Uint8Array(8).fill(0x42);
    const buffers: Uint8Array[] = [first];
    let getterCalls = 0;
    Object.defineProperty(buffers, 1, {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls++;
        first.buffer.transfer();
        return second;
      },
    });
    const fd = fs.openSync(outPath, "w");
    try {
      assert.equal(fs.writevSync(fd, buffers), 8);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(getterCalls, 1);
    assert.equal(first.buffer.detached, true);
    assert.equal(fs.readFileSync(outPath, "latin1"), "BBBBBBBB");
  }

  // 3. Dir.read callback can call closeSync without ERR_DIR_CONCURRENT_OPERATION.
  {
    const listDir = path.join(root, "list");
    fs.mkdirSync(listDir);
    fs.writeFileSync(path.join(listDir, "a.txt"), "a");
    fs.writeFileSync(path.join(listDir, "b.txt"), "b");
    const dir = fs.opendirSync(listDir);
    await new Promise<void>((resolve, reject) => {
      dir.read((err, entry) => {
        if (err) return reject(err);
        try {
          assert.ok(entry !== null);
          dir.closeSync();
          resolve();
        } catch (closeErr) {
          reject(closeErr);
        }
      });
    });
  }

  // 4. readdirSync({ recursive: true }) descends into dir symlinks, ignores file/dangling symlinks, and reports ELOOP.
  {
    const walkDir = path.join(root, "walk");
    fs.mkdirSync(path.join(walkDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(walkDir, "sub", "f.txt"), "hi");
    fs.symlinkSync("sub", path.join(walkDir, "linkdir"));
    fs.symlinkSync("sub/f.txt", path.join(walkDir, "linkfile"));
    fs.symlinkSync("missing", path.join(walkDir, "dangling"));
    const entries = fs.readdirSync(walkDir, { recursive: true }).map(String).sort();
    assert.deepEqual(entries, ["dangling", "linkdir", "linkdir/f.txt", "linkfile", "sub", "sub/f.txt"]);

    fs.symlinkSync("loop", path.join(walkDir, "loop"));
    assert.throws(
      () => fs.readdirSync(walkDir, { recursive: true, encoding: "buffer" }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ELOOP",
    );
  }

  // 5. 4-argument fs.symlink ignores a non-callable callback.
  {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    fs.writeFileSync(target, "ok");
    (fs.symlink as (...args: unknown[]) => void)("target.txt", link, "file", "notafunc");
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    assert.equal(fs.readFileSync(link, "utf8"), "ok");
    assert.equal(fs.symlink.name, "symlink");
  }

  // 6. fs.promises preserves async stack frames on engines with async stacks.
  {
    const supportsAsyncStacks = await (async function probe() {
      await Promise.resolve();
      return new Error().stack?.includes("at async probe") ?? false;
    })();
    async function level3() {
      await fs.promises.readFile(path.join(root, "does-not-exist.txt"));
    }
    async function level2() {
      await level3();
    }
    async function level1() {
      await level2();
    }
    let caught: NodeJS.ErrnoException | undefined;
    try {
      await level1();
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    assert.ok(caught);
    assert.equal(caught.code, "ENOENT");
    if (supportsAsyncStacks) {
      assert.ok(caught.stack?.includes("at async level3"), caught.stack);
      assert.ok(caught.stack?.includes("at async level2"), caught.stack);
      assert.ok(caught.stack?.includes("at async level1"), caught.stack);
    }
  }

  console.log("ok fs-buffers-readdir-callbacks");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
