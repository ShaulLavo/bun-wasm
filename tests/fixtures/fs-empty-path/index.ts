import assert from "node:assert/strict";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

async function callbackStat(callback: typeof fs.stat, path: fs.PathLike, context: AsyncLocalStorage<string>, check: (error: unknown) => void): Promise<void> {
  let returned = false;
  const result = await new Promise<{ error: unknown; value: unknown; returned: boolean; store: string | undefined }>(resolve => {
    callback(path, (error, value) => resolve({ error, value, returned, store: context.getStore() }));
    returned = true;
  });
  check(result.error);
  assert.equal(result.value, undefined);
  assert(result.returned);
  assert.equal(result.store, "empty-path");
}

export async function checkEmptyPaths(api: typeof fs): Promise<void> {
  const errors = new Set<Error>();
  const context = new AsyncLocalStorage<string>();
  function check(error: unknown, syscall: string): void {
    assert(error instanceof Error);
    assert.equal("code" in error && error.code, "ENOENT");
    assert.equal("errno" in error && error.errno, -2);
    assert.equal("syscall" in error && error.syscall, syscall);
    assert.equal("path" in error && error.path, "");
    assert(error.message.includes(`${syscall} ''`));
    assert(!errors.has(error), "each call must create a fresh Error");
    errors.add(error);
  }
  function missing(action: () => unknown, syscall: string): void {
    try { action(); }
    catch (error) { check(error, syscall); return; }
    assert.fail(`${syscall} accepted an empty path`);
  }
  async function metadata(path: fs.PathLike, link: boolean): Promise<void> {
    const sync = link ? api.lstatSync : api.statSync;
    const callback = link ? api.lstat : api.stat;
    const promise = link ? api.promises.lstat : api.promises.stat;
    const syscall = link ? "lstat" : "stat";
    missing(() => sync(path), syscall);
    missing(() => sync(path, { bigint: true }), syscall);
    assert.equal(sync(path, { throwIfNoEntry: false }), undefined);
    await context.run("empty-path", () => callbackStat(callback, path, context, error => check(error, syscall)));
    await context.run("empty-path", async () => {
      let returned = false;
      const pending = promise(path).then(() => assert.fail("empty promise path succeeded"), error => {
        check(error, syscall);
        assert(returned);
        assert.equal(context.getStore(), "empty-path");
      });
      returned = true;
      await pending;
    });
  }
  for (const path of ["", Buffer.alloc(0)]) {
    await metadata(path, false);
    await metadata(path, true);
    assert.equal(api.existsSync(path), false);
    missing(() => api.readFileSync(path), "open");
    missing(() => api.readdirSync(path), "scandir");
    missing(() => api.openSync(path, "r"), "open");
    missing(() => api.readlinkSync(path), "readlink");
    missing(() => api.mkdirSync(path), "mkdir");
    missing(() => api.mkdirSync(path, { recursive: true }), "mkdir");
    api.rmSync(path, { force: true });
  }
  assert(api.statSync(".").isDirectory());
  assert.equal(api.realpathSync(""), api.realpathSync("."));
  await new Promise<void>((resolve, reject) => api.realpath("", (error, value) => {
    if (error) { reject(error); return; }
    try { assert.equal(value, api.realpathSync(".")); resolve(); }
    catch (failure) { reject(failure); }
  }));
  const temporary = api.mkdtempSync("");
  try { assert(api.statSync(temporary).isDirectory()); }
  finally { api.rmdirSync(temporary); }
}

if (import.meta.main) {
  await checkEmptyPaths(fs);
  console.log("empty filesystem paths retain missing-path semantics");
}
