const fs = require("node:fs");
const fsp = require("node:fs/promises");
const assert = require("node:assert/strict");
const path = require("node:path");

async function main() {
  fs.mkdirSync("tree/sub/deep", { recursive: true });
  fs.writeFileSync("tree/a.txt", "a");
  fs.writeFileSync("tree/sub/b.txt", "b");
  fs.writeFileSync("tree/sub/deep/c.txt", "c");
  fs.symlinkSync("sub", "tree/link");
  const expected = ["a.txt", "link", "sub", "sub/b.txt", "sub/deep", "sub/deep/c.txt"];
  const relative = entry => path.relative("tree", path.join(entry.parentPath, entry.name));
  const collect = dir => {
    const entries = [];
    let entry;
    while ((entry = dir.readSync()) !== null) entries.push(relative(entry));
    return entries.sort();
  };
  const dir = fs.opendirSync("tree", { bufferSize: 1, recursive: true });
  assert(dir instanceof fs.Dir);
  assert.equal(dir.path, "tree");
  assert.throws(() => Object.getOwnPropertyDescriptor(fs.Dir.prototype, "path").get.call({}), { code: "ERR_INVALID_THIS" });
  assert.deepEqual(collect(dir), expected);
  assert.equal(dir.readSync(), null);
  dir.closeSync();
  assert.throws(() => dir.readSync(), { code: "ERR_DIR_CLOSED" });
  assert.throws(() => dir.closeSync(), { code: "ERR_DIR_CLOSED" });
  await assert.rejects(dir.read(), { code: "ERR_DIR_CLOSED" });
  await assert.rejects(dir.close(), { code: "ERR_DIR_CLOSED" });
  let closedCallbackCalled = false;
  assert.throws(() => dir.read(() => { closedCallbackCalled = true; }), { code: "ERR_DIR_CLOSED" });
  assert.throws(() => dir.read(undefined), { code: "ERR_DIR_CLOSED" });
  assert.equal(closedCallbackCalled, false);
  console.log("sync recursive, bufferSize, closed handle");

  const asyncDir = await fsp.opendir("tree", { recursive: true, bufferSize: 2 });
  const names = [];
  for await (const entry of asyncDir) {
    assert(entry instanceof fs.Dirent);
    if (entry.name === "link") assert(entry.isSymbolicLink());
    if (entry.name === "sub") assert(entry.isDirectory());
    if (entry.name === "a.txt") assert(entry.isFile());
    names.push(relative(entry));
  }
  assert.deepEqual(names.sort(), expected);
  await assert.rejects(asyncDir.read(), { code: "ERR_DIR_CLOSED" });
  const early = await fsp.opendir(new URL("file://" + path.resolve("tree")));
  for await (const entry of early) break;
  await assert.rejects(early.read(), { code: "ERR_DIR_CLOSED" });
  const manuallyClosed = await fsp.opendir("tree");
  await assert.rejects(async () => {
    for await (const entry of manuallyClosed) { await manuallyClosed.close(); break; }
  }, { code: "ERR_DIR_CLOSED" });
  console.log("promises, dirents, iteration and early close");

  let sync = true;
  const callbackOpen = new Promise((resolve, reject) => {
    fs.opendir("tree", (error, opened) => {
      if (error) return reject(error);
      assert.equal(sync, false);
      resolve(opened);
    });
  });
  sync = false;
  const cbDir = await callbackOpen;
  sync = true;
  const callbackRead = new Promise((resolve, reject) => {
    assert.equal(cbDir.read((error, entry) => {
      if (error) return reject(error);
      assert.equal(sync, false);
      assert(entry instanceof fs.Dirent);
      resolve();
    }), undefined);
  });
  sync = false;
  await callbackRead;
  await new Promise((resolve, reject) => cbDir.close(error => error ? reject(error) : resolve()));
  await new Promise(resolve => cbDir.close(error => { assert.equal(error.code, "ERR_DIR_CLOSED"); resolve(); }));
  console.log("callback open, read, close and errors are asynchronous");

  const queued = await fsp.opendir("tree", { bufferSize: 1 });
  const first = queued.read();
  assert.throws(() => queued.readSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
  assert.throws(() => queued.closeSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
  const second = queued.read();
  const closed = queued.close();
  assert.notEqual((await first).name, (await second).name);
  await closed;
  await assert.rejects(queued.read(), { code: "ERR_DIR_CLOSED" });
  const buffered = fs.opendirSync("tree");
  buffered.readSync();
  const bufferedRead = buffered.read();
  assert(buffered.readSync() instanceof fs.Dirent);
  buffered.closeSync();
  assert(await bufferedRead instanceof fs.Dirent);
  const closing = fs.opendirSync("tree");
  const closePromise = closing.close();
  assert.throws(() => closing.readSync(), { code: "ERR_DIR_CLOSED" });
  await closePromise;
  console.log("queued reads and close, sync operations reject concurrency");

  const refill = fs.opendirSync("tree", { bufferSize: 1 });
  await new Promise((resolve, reject) => refill.read((error) => {
    if (error) return reject(error);
    assert.throws(() => refill.readSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
    assert.throws(() => refill.closeSync(), { code: "ERR_DIR_CONCURRENT_OPERATION" });
    resolve();
  }));
  refill.closeSync();

  for (const options of [{ bufferSize: 0 }, { bufferSize: -1 }, { bufferSize: 1.5 }, { bufferSize: Infinity }]) {
    assert.throws(() => fs.opendirSync("tree", options), { code: "ERR_OUT_OF_RANGE" });
  }
  for (const bufferSize of ["1", null]) assert.throws(() => fs.opendirSync("tree", { bufferSize }), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => fs.opendirSync("tree", "no-such-encoding"), { code: "ERR_INVALID_ARG_VALUE" });
  assert.throws(() => fs.opendir("tree"), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => fs.opendir(1, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => fs.opendirSync("tree/a.txt"), { code: "ENOTDIR", syscall: "opendir", errno: -20 });
  await assert.rejects(fsp.opendir("tree/missing"), { code: "ENOENT", syscall: "opendir", path: "tree/missing" });
  await new Promise(resolve => fs.opendir("tree/a.txt", error => {
    assert.equal(error.code, "ENOTDIR");
    assert.equal(error.syscall, "opendir");
    resolve();
  }));
  console.log("options, paths and eager open errors");

  fs.mkdirSync("encoding");
  fs.writeFileSync("encoding/naïve", "");
  const encoded = fs.opendirSync("encoding", "latin1");
  assert.equal(encoded.readSync().name, Buffer.from("naïve").toString("latin1"));
  encoded.closeSync();
  const bufferPath = Buffer.from("encoding");
  const bytes = fs.opendirSync(bufferPath, { encoding: "buffer" });
  assert(Buffer.isBuffer(bytes.path));
  assert.deepEqual(bytes.path, bufferPath);
  const byteEntry = bytes.readSync();
  assert(Buffer.isBuffer(byteEntry.name));
  assert(Buffer.isBuffer(byteEntry.parentPath));
  assert.deepEqual(byteEntry.parentPath, bufferPath);
  bytes.closeSync();
  await new Promise((resolve, reject) => fs.opendir(bufferPath, { encoding: "buffer" }, (error, callbackDir) => {
    if (error) return reject(error);
    assert(Buffer.isBuffer(callbackDir.path));
    const entry = callbackDir.readSync();
    assert(Buffer.isBuffer(entry.parentPath));
    callbackDir.closeSync();
    resolve();
  }));
  const promiseDir = await fsp.opendir(bufferPath, { encoding: "buffer" });
  assert(Buffer.isBuffer(promiseDir.path));
  assert(Buffer.isBuffer((await promiseDir.read()).parentPath));
  await promiseDir.close();
  const empty = fs.opendirSync("tree/sub/deep");
  assert.throws(() => empty.read(null), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => empty.close(false), { code: "ERR_INVALID_ARG_TYPE" });
  empty.closeSync();
  empty[Symbol.dispose]();
  await empty[Symbol.asyncDispose]();
  const disposed = fs.opendirSync("tree");
  disposed[Symbol.dispose]();
  await assert.rejects(disposed.read(), { code: "ERR_DIR_CLOSED" });
  const asyncDisposed = await fsp.opendir("tree");
  await asyncDisposed[Symbol.asyncDispose]();
  assert.throws(() => asyncDisposed.readSync(), { code: "ERR_DIR_CLOSED" });
  assert.throws(() => fs.opendirSync(""), { code: "ENOENT" });
  let testing;
  try { testing = require("bun:internal-for-testing"); } catch {}
  if (testing) {
    const baseline = testing.directoryCount();
    function abandon() {
      const abandoned = Array.from({ length: 20 }, () => fs.opendirSync("tree"));
      assert.equal(testing.directoryCount(), baseline + abandoned.length);
    }
    abandon();
    for (let i = 0; i < 50 && testing.directoryCount() !== baseline; i++) {
      try { Bun.gc(true); } catch {}
      globalThis.__bunwasmSweepDirs?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (testing.directoryCount() !== baseline) testing.closeAllDirs();
    assert.equal(testing.directoryCount(), baseline);
    fs.opendirSync("tree");
    process.once("exit", () => fs.writeFileSync("directory-exit-count", `${testing.directoryCount()}\n`));
  }
  console.log("entry encodings and callback validation");
}
main();
