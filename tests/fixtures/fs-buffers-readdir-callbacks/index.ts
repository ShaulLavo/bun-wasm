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

  // 2. writevSync snapshots buffers once, uses intrinsic view getters, and treats detached views as empty.
  {
    const outPath = path.join(root, "writev.bin");
    const first = new Uint8Array(new ArrayBuffer(16)).fill(0x41);
    const second = new Uint8Array(8).fill(0x42);
    const detachedAb = new ArrayBuffer(8);
    const detachedDv = new DataView(detachedAb);
    detachedAb.transfer();
    const backing = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35]);
    const shadowedTa = backing.subarray(1, 4);
    Object.defineProperty(shadowedTa, "byteLength", { value: 0 });
    Object.defineProperty(shadowedTa, "byteOffset", { value: 99 });
    Object.defineProperty(shadowedTa, "buffer", { value: { detached: true } });
    const shadowedDv = new DataView(backing.buffer, 0, 3);
    Object.defineProperty(shadowedDv, "byteLength", { value: 0 });
    Object.defineProperty(shadowedDv, "byteOffset", { value: 99 });
    Object.defineProperty(shadowedDv, "buffer", { value: { detached: true } });

    const buffers: ArrayBufferView[] = [first, second, detachedDv, shadowedTa, shadowedDv];
    let getterCalls = 0;
    Object.defineProperty(buffers, 1, {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls++;
        first.buffer.transfer();
        buffers.push(Buffer.from("EXTRA"));
        return second;
      },
    });
    const fd = fs.openSync(outPath, "w");
    try {
      assert.equal(fs.writevSync(fd, buffers), 14);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(getterCalls, 1);
    assert.equal(first.buffer.detached, true);
    assert.equal(fs.readFileSync(outPath, "latin1"), "BBBBBBBB234123");
  }

  // 3. Recursive readdir descends into dir symlinks, normalizes Dirent.parentPath, and reports sync vs async ELOOP paths.
  {
    const walkDir = path.join(root, "walk");
    fs.mkdirSync(path.join(walkDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(walkDir, "sub", "f.txt"), "hi");
    fs.symlinkSync("sub", path.join(walkDir, "linkdir"));
    fs.symlinkSync("sub/f.txt", path.join(walkDir, "linkfile"));
    fs.symlinkSync("missing", path.join(walkDir, "dangling"));
    const entries = fs.readdirSync(walkDir, { recursive: true }).map(String).sort();
    assert.deepEqual(entries, ["dangling", "linkdir", "linkdir/f.txt", "linkfile", "sub", "sub/f.txt"]);

    const dirents = fs.readdirSync(`${walkDir}/`, { recursive: true, withFileTypes: true });
    const byKey = new Set(dirents.map((entry) => `${entry.parentPath}|${entry.name}`));
    assert.equal(byKey.has(`${walkDir}|sub`), true);
    assert.equal(byKey.has(`${walkDir}/sub|f.txt`), true);
    assert.equal(byKey.has(`${walkDir}/linkdir|f.txt`), true);

    const loopRoot = path.join(root, "walk-loop");
    fs.mkdirSync(path.join(loopRoot, "sub"), { recursive: true });
    fs.symlinkSync("loop", path.join(loopRoot, "sub", "loop"));
    assert.throws(
      () => fs.readdirSync(loopRoot, { recursive: true, encoding: "buffer" }),
      (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        return e.code === "ELOOP" && e.path === loopRoot && e.syscall === "scandir";
      },
    );
    const asyncLoopErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      fs.readdir(loopRoot, { recursive: true }, resolve);
    });
    assert.equal(asyncLoopErr?.code, "ELOOP");
    assert.equal(asyncLoopErr?.path, path.join(loopRoot, "sub", "loop"));
    assert.equal(asyncLoopErr?.syscall, "open");

    let promiseLoopErr: NodeJS.ErrnoException | undefined;
    try {
      await fs.promises.readdir(loopRoot, { recursive: true });
    } catch (err) {
      promiseLoopErr = err as NodeJS.ErrnoException;
    }
    assert.equal(promiseLoopErr?.code, "ELOOP");
    assert.equal(promiseLoopErr?.path, path.join(loopRoot, "sub", "loop"));
    assert.equal(promiseLoopErr?.syscall, "open");
  }

  // 5. fs.symlink delivers 1-arg callbacks for 3-arg and 4-arg callable calls, and ignores non-callable 4th args.
  {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    const link3 = path.join(root, "link3.txt");
    const link4 = path.join(root, "link4.txt");
    fs.writeFileSync(target, "ok");
    (fs.symlink as (...args: unknown[]) => void)("target.txt", link, "file", "notafunc");
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    assert.equal(fs.readFileSync(link, "utf8"), "ok");
    assert.equal(fs.symlink.name, "symlink");

    const args3 = await new Promise<unknown[]>((resolve) => {
      fs.symlink("target.txt", link3, function (...args: unknown[]) {
        resolve(args);
      });
    });
    assert.deepEqual(args3, [undefined]);
    const args4 = await new Promise<unknown[]>((resolve) => {
      fs.symlink("target.txt", link4, "file", function (...args: unknown[]) {
        resolve(args);
      });
    });
    assert.deepEqual(args4, [undefined]);
  }

  // 6. fs.promises preserves async stack frames and frozen error identity.
  {
    async function probeInner() {
      await Promise.resolve();
      return new Error().stack ?? "";
    }
    async function probeOuter() {
      return await probeInner();
    }
    const supportsAsyncStacks = (await probeOuter()).includes("at async probeOuter");
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

    const frozen = Object.freeze(new Error("frozen-options-err"));
    let caughtFrozen: unknown;
    try {
      await fs.promises.readFile(path.join(root, "does-not-exist.txt"), {
        get encoding(): BufferEncoding {
          throw frozen;
        },
      });
    } catch (err) {
      caughtFrozen = err;
    }
    assert.equal(caughtFrozen, frozen);
  }

  console.log("ok fs-buffers-readdir-callbacks");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
