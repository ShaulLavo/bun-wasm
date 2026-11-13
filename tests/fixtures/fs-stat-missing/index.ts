import assert from "node:assert/strict";
import fs from "node:fs";
import { Buffer } from "node:buffer";

export async function checkStatMissing(api: typeof fs): Promise<void> {
  const root = api.mkdtempSync("stat-missing-");
  const file = `${root}/file`;
  const absent = `${root}/absent`;
  const dangling = `${root}/dangling`;
  api.writeFileSync(file, "test");
  api.symlinkSync("absent", dangling);
  const errors = new Set<Error>();
  function check(error: unknown, code: string, path: string, syscall: string): void {
    assert(error instanceof Error);
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal("code" in error && error.code, code);
    assert.equal("syscall" in error && error.syscall, syscall);
    assert.equal("path" in error && error.path, path);
    assert.equal("errno" in error && error.errno, code === "ENOENT" ? -2 : -20);
    assert(error.message.includes(`${syscall} '${path}'`));
    assert(!errors.has(error));
    errors.add(error);
    assert(String(error.stack).includes("fs-stat-missing"), "stack retains the caller");
    assert(!Object.keys(error).includes("message"));
  }
  function missing(operation: () => unknown, code: string, path: string, syscall: string): void {
    try { operation(); }
    catch (error) { check(error, code, path, syscall); return; }
    assert.fail("missing path succeeded");
  }
  async function checkAsync(link: boolean): Promise<void> {
    const callback = link ? api.lstat : api.stat;
    const promise = link ? api.promises.lstat : api.promises.stat;
    const syscall = link ? "lstat" : "stat";
    let returned = false;
    const pending = new Promise<{ error: unknown; value: unknown; returned: boolean }>(resolve =>
      callback(absent, (error, value) => resolve({ error, value, returned })));
    returned = true;
    const result = await pending;
    assert(result.returned);
    assert.equal(result.value, undefined);
    check(result.error, "ENOENT", absent, syscall);
    await promise(absent).then(() => assert.fail("promise succeeded"), error => check(error, "ENOENT", absent, syscall));
  }
  try {
    for (const link of [false, true]) {
      const sync = link ? api.lstatSync : api.statSync;
      const syscall = link ? "lstat" : "stat";
      for (const path of [absent, Buffer.from(absent), ""]) {
        assert.equal(sync(path, { throwIfNoEntry: false }), undefined);
        assert.equal(sync(path, { bigint: true, throwIfNoEntry: false }), undefined);
      }
      missing(() => sync(absent), "ENOENT", absent, syscall);
      missing(() => sync(absent, { throwIfNoEntry: true }), "ENOENT", absent, syscall);
      missing(() => sync(`${file}/child`, { throwIfNoEntry: false }), "ENOTDIR", `${file}/child`, syscall);
      const normal = sync(file, { throwIfNoEntry: false });
      assert(normal instanceof api.Stats && normal.isFile());
      const big = sync(file, { bigint: true, throwIfNoEntry: false });
      assert.equal(big?.size, 4n);
      await checkAsync(link);
    }
    assert.equal(api.statSync(dangling, { throwIfNoEntry: false }), undefined);
    assert(api.lstatSync(dangling, { throwIfNoEntry: false })?.isSymbolicLink());
  } finally { api.rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  await checkStatMissing(fs);
  console.log("missing stat suppression preserves errors and delivery");
}
