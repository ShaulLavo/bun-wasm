import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const collect = typeof Bun !== "undefined" ? () => Bun.gc(true) : () => (globalThis as unknown as { gc(): void }).gc();
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function gcUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await nextTurn();
    collect();
    await nextTurn();
    if (predicate()) return;
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

async function openAndLeak(filePath: string): Promise<{ fd: number; ref: WeakRef<fs.promises.FileHandle> }> {
  const h = await fs.promises.open(filePath, "r");
  return { fd: h.fd, ref: new WeakRef(h) };
}

async function openAndCloseBatch(filePath: string, count: number): Promise<Array<{ fd: number; ref: WeakRef<fs.promises.FileHandle> }>> {
  const closed: Array<{ fd: number; ref: WeakRef<fs.promises.FileHandle> }> = [];
  for (let i = 0; i < count; i++) {
    const h = await fs.promises.open(filePath, "r");
    closed.push({ fd: h.fd, ref: new WeakRef(h) });
    await h.close();
  }
  return closed;
}

async function openStreamHandle(filePath: string): Promise<{ ref: WeakRef<fs.promises.FileHandle>; stream: fs.ReadStream }> {
  const h = await fs.promises.open(filePath, "r");
  return { ref: new WeakRef(h), stream: h.createReadStream({ autoClose: true }) };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync("fs-fh-gc-");
  const uncaught: (Error & { code?: string })[] = [];
  const onUncaught = (err: Error & { code?: string }) => {
    uncaught.push(err);
  };
  process.on("uncaughtException", onUncaught);

  try {
    // 1. Dropped FileHandle closes its fd on GC and raises ERR_INVALID_STATE.
    const leakedPath = path.join(root, "leaked.txt");
    fs.writeFileSync(leakedPath, "leak-data");
    const { fd: leakedFd, ref: leakedRef } = await openAndLeak(leakedPath);
    await gcUntil(() => uncaught.length > 0, "leaked FileHandle GC");
    assert.equal(leakedRef.deref(), undefined);
    assert.equal(uncaught.length, 1);
    assert.equal(uncaught[0]!.code, "ERR_INVALID_STATE");
    assert.ok(uncaught[0]!.message.includes(`File descriptor: ${leakedFd}`), uncaught[0]!.message);
    assert.throws(() => fs.fstatSync(leakedFd), { code: "EBADF" });

    // 2. Explicitly closed FileHandles whose fds are reused are never closed by GC.
    uncaught.length = 0;
    const closedPath = path.join(root, "closed.txt");
    const reusedPath = path.join(root, "reused.txt");
    fs.writeFileSync(closedPath, "old");
    fs.writeFileSync(reusedPath, "new");
    const closedBatch = await openAndCloseBatch(closedPath, 12);
    const reusedFd = fs.openSync(reusedPath, "r+");
    try {
      await gcUntil(
        () => closedBatch.some((entry) => entry.fd === reusedFd && entry.ref.deref() === undefined),
        "closed FileHandle GC for reused fd",
      );
      await nextTurn();
      assert.equal(uncaught.length, 0);
      assert.equal(fs.fstatSync(reusedFd).isFile(), true);
      fs.writeSync(reusedFd, "ok", 0);
      assert.equal(fs.readFileSync(reusedPath, "utf8"), "okw");
    } finally {
      fs.closeSync(reusedFd);
    }

    // 3. Stream-held FileHandle stays alive across GC and closes cleanly with no diagnostic.
    uncaught.length = 0;
    const streamPath = path.join(root, "stream.txt");
    fs.writeFileSync(streamPath, "stream-payload");
    const { ref: streamRef, stream: rs } = await openStreamHandle(streamPath);
    collect();
    await nextTurn();
    assert.ok(streamRef.deref() !== undefined, "stream must keep FileHandle alive");
    const chunks: Buffer[] = [];
    for await (const chunk of rs) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await nextTurn();
    collect();
    await nextTurn();
    assert.equal(Buffer.concat(chunks).toString("utf8"), "stream-payload");
    assert.equal(uncaught.length, 0);

    console.log("ok fs-file-handle-gc");
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main();
