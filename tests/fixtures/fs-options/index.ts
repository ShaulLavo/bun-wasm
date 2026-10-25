import * as fs from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

type Fs = typeof fs;

function callbackResult<T>(start: (callback: (error: NodeJS.ErrnoException | null, result: T) => void) => void) {
  return new Promise<T>((resolve, reject) => start((error, result) => error ? reject(error) : resolve(result)));
}

export async function checkFsOptions(api: Fs, root: string) {
  api.mkdirSync(root, { recursive: true });
  const existing = join(root, "existing");
  const missing = join(root, "missing");
  const reset = () => api.writeFileSync(existing, "original");
  const contents = () => api.readFileSync(existing, "utf8");
  const { O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } = api.constants;
  reset();
  api.closeSync(api.openSync(existing, O_WRONLY));
  assert.equal(contents(), "original");
  assert.throws(() => api.openSync(missing, O_WRONLY), { code: "ENOENT" });
  assert.equal(api.existsSync(missing), false);
  assert.throws(() => api.writeFileSync(existing, "replacement", { flag: "wx" }), { code: "EEXIST" });
  assert.equal(contents(), "original");
  let fd = api.openSync(missing, O_WRONLY | O_CREAT | O_EXCL);
  api.writeSync(fd, "created");
  api.closeSync(fd);
  fd = api.openSync(existing, O_WRONLY | O_APPEND);
  api.writeSync(fd, "!");
  api.closeSync(fd);
  assert.equal(contents(), "original!");
  fd = api.openSync(existing, O_RDWR | O_TRUNC);
  api.closeSync(fd);
  assert.equal(contents(), "");
  reset();
  await assert.rejects(api.promises.writeFile(existing, "bad", { flag: "wx" }), { code: "EEXIST" });
  const error = await new Promise<NodeJS.ErrnoException | null>(resolve => api.writeFile(existing, "bad", { flag: "wx" }, resolve));
  assert.equal(error?.code, "EEXIST");
  const handle = await api.promises.open(existing, O_WRONLY);
  await handle.writeFile("OK");
  await handle.close();
  assert.equal(contents(), "OKiginal");
  await assert.rejects(api.promises.open(existing, "wx"), { code: "EEXIST" });
  api.appendFileSync(existing, "!", { flag: "r+" });
  assert.equal(contents(), "!Kiginal");
  assert.throws(() => api.openSync(existing, "not-a-flag"), { code: "ERR_INVALID_ARG_VALUE" });
  for (const flag of ["r", "r+", "rs", "rs+", "a", "a+", "as", "as+"]) {
    reset();
    api.closeSync(api.openSync(existing, flag));
    assert.equal(contents(), "original");
  }
  for (const flag of ["wx", "wx+", "ax", "ax+"]) {
    assert.throws(() => api.openSync(existing, flag), { code: "EEXIST" });
    assert.equal(contents(), "original");
  }
  for (const flag of [O_WRONLY | O_CREAT, O_RDWR | O_CREAT, O_WRONLY | O_EXCL]) {
    api.closeSync(api.openSync(existing, flag));
    assert.equal(contents(), "original");
  }
  await callbackResult<number>(callback => api.open(existing, O_WRONLY, callback)).then(opened => api.closeSync(opened));
}

export async function checkBigintStats(api: Fs, root: string) {
  const path = join(root, "stat-file");
  const link = join(root, "stat-link");
  api.writeFileSync(path, "metadata");
  api.symlinkSync("stat-file", link);
  const fd = api.openSync(path, "r");
  const handle = await api.promises.open(path, "r");
  try {
    const stats = [api.statSync(path, { bigint: true }), api.lstatSync(path, { bigint: true }),
      api.fstatSync(fd, { bigint: true }), await api.promises.stat(path, { bigint: true }),
      await api.promises.lstat(path, { bigint: true }), await handle.stat({ bigint: true }),
      await callbackResult<fs.BigIntStats>(callback => api.stat(path, { bigint: true }, callback)),
      await callbackResult<fs.BigIntStats>(callback => api.lstat(path, { bigint: true }, callback)),
      await callbackResult<fs.BigIntStats>(callback => api.fstat(fd, { bigint: true }, callback))];
    for (const result of stats) {
      assert.equal(typeof result.size, "bigint");
      assert.equal(typeof result.mode, "bigint");
      assert.equal(typeof result.mtimeMs, "bigint");
      assert.equal(typeof result.mtimeNs, "bigint");
      assert.equal(result.mtimeNs / 1000000n, result.mtimeMs);
      assert.equal(new BigUint64Array([result.size])[0], 8n);
      assert.equal(result.isFile(), true);
      assert.equal(result.isDirectory(), false);
      assert.equal(result.mtime instanceof Date, true);
    }
    assert.equal(api.lstatSync(link, { bigint: true }).isSymbolicLink(), true);
    assert.equal(api.statSync(link, { bigint: true }).isFile(), true);
    assert.equal(typeof api.statSync(path).size, "number");
    assert.equal(typeof api.fstatSync(fd).mtimeMs, "number");
    assert.equal(typeof (await handle.stat()).size, "number");
    assert.equal("mtimeNs" in api.statSync(path), false);
    assert.equal(api.statSync(join(root, "absent"), { bigint: true, throwIfNoEntry: false }), undefined);
    assert.equal(api.lstatSync(join(root, "absent"), { bigint: true, throwIfNoEntry: false }), undefined);
  } finally {
    api.closeSync(fd);
    await handle.close();
  }
}

export async function checkCopyOptions(api: Fs, root: string) {
  const src = join(root, "copy-source"), dst = join(root, "copy-dest");
  api.writeFileSync(src, "source");
  api.writeFileSync(dst, "keep");
  api.cpSync(src, dst, { force: false });
  assert.equal(api.readFileSync(dst, "utf8"), "keep");
  assert.throws(() => api.cpSync(src, dst, { force: false, errorOnExist: true }), { code: "ERR_FS_CP_EEXIST" });
  await assert.rejects(api.promises.cp(src, dst, { force: false, errorOnExist: true }), { code: "ERR_FS_CP_EEXIST" });
  await new Promise<void>((resolve, reject) => api.cp(src, dst, { force: false }, error => error ? reject(error) : resolve()));
  assert.equal(api.readFileSync(dst, "utf8"), "keep");
  const dir = join(root, "tree");
  api.mkdirSync(dir);
  api.writeFileSync(join(dir, "yes"), "yes");
  api.writeFileSync(join(dir, "no"), "no");
  const visited: string[] = [];
  const filtered = join(root, "filtered");
  api.cpSync(dir, filtered, { recursive: true, filter: (from, to) => {
    visited.push(from);
    assert.equal(to, filtered + from.slice(dir.length));
    return !from.endsWith("/no");
  } });
  assert.equal(visited.includes(dir), true);
  assert.equal(visited.includes(join(dir, "no")), true);
  assert.equal(api.existsSync(join(filtered, "no")), false);
  assert.equal(api.readFileSync(join(filtered, "yes"), "utf8"), "yes");
  await api.promises.cp(dir, join(root, "async-copy"), { recursive: true, filter: async from => !from.endsWith("/no") });
  assert.equal(api.existsSync(join(root, "async-copy/no")), false);
  await new Promise<void>((resolve, reject) => api.cp(dir, join(root, "callback-copy"), {
    recursive: true, filter: async from => !from.endsWith("/no"),
  }, error => error ? reject(error) : resolve()));
  assert.equal(api.existsSync(join(root, "callback-copy/no")), false);
  api.cpSync(dir, join(root, "skip-root"), { recursive: true, filter: () => false });
  assert.equal(api.existsSync(join(root, "skip-root")), false);
  await assert.rejects(api.promises.cp(src, dst, { filter: async () => { throw new Error("filter failed"); } }), /filter failed/);
  assert.equal(api.readFileSync(dst, "utf8"), "keep");
}

if (import.meta.main) {
  const root = "fs-options-work";
  try {
    fs.mkdirSync(root);
    await checkFsOptions(fs, root);
    await checkBigintStats(fs, root);
    await checkCopyOptions(fs, root);
    console.log("filesystem options ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
