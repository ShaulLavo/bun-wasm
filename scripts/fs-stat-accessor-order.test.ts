import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Buffer } from "node:buffer";
import path from "node:path";
import { types } from "node:util";

function source(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}
const fsSource = source("crates/bunwasm-runtime/src/js/node_fs.js");
const optionsSource = source("crates/bunwasm-runtime/src/js/fs_options.ts");
type Options = { readonly bigint?: boolean; readonly throwIfNoEntry?: boolean };
type Operation = (file: string, options: Options) => { isFile(): boolean } | undefined;
type Callback = (file: string, options: Options, callback: (error: Error | null, value: unknown) => void) => void;
type Api = { statSync: Operation; lstatSync: Operation; stat: Callback; lstat: Callback };
function fixture(trace: string[], trackCode = false): Api {
  const native = {
    hostCaps: { proc_spawn: false },
    stat(file: string, _link: boolean, _bigint: boolean) {
      trace.push("native");
      if (file.endsWith("/present")) return { mode: 0o100644, size: 4, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 };
      const error = Object.assign(new Error(`ENOENT: stat '${file}'`), { code: "ENOENT", errno: -2, syscall: "stat", path: file });
      if (trackCode) Object.defineProperty(error, "code", { get() { trace.push("code"); return "ENOENT"; } });
      throw error;
    },
  };
  const helpers = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${optionsSource}`), { Date })({});
  const factory = runInNewContext(fsSource, { Uint8Array, ArrayBuffer, URL, Date, Error, TypeError, FinalizationRegistry });
  const api = factory({ native, describe: String, isProxy: types.isProxy, realTimers: { setImmediate }, require(name: string) {
    if (name === "buffer") return { Buffer };
    if (name === "path") return path;
    if (name === "fs_options") return helpers;
    if (name === "fs_watch") return () => ({});
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return api.fs;
}
for (const method of ["statSync", "lstatSync"] as const) {
  test(`${method} missing flag false becomes true during bigint read`, () => {
    const trace: string[] = [], api = fixture(trace);
    let flag = false;
    const options = { get bigint() { trace.push("bigint"); flag = true; return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } };
    expect(() => api[method]("/missing", options)).toThrow("ENOENT");
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry"]);
  });
  test(`${method} missing flag true becomes false during bigint read`, () => {
    const trace: string[] = [], api = fixture(trace);
    let flag = true;
    const options = { get bigint() { trace.push("bigint"); flag = false; return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } };
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry"]);
  });
  test(`${method} successful stat reads bigint twice and no missing flag`, () => {
    const trace: string[] = [], api = fixture(trace);
    const options = { get bigint() { trace.push("bigint"); return false; }, get throwIfNoEntry(): boolean { throw new Error("success must not read throwIfNoEntry"); } };
    expect(api[method]("/present", options)?.isFile()).toBe(true);
    expect(trace).toEqual(["bigint", "native", "bigint"]);
  });
  test(`${method} native failure reads missing flag after bigint and before code`, () => {
    const trace: string[] = [], api = fixture(trace, true);
    const options = { get bigint() { trace.push("bigint"); return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return false; } };
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry", "code"]);
  });
  test(`${method} inherited accessors keep the same order`, () => {
    const trace: string[] = [], api = fixture(trace);
    let flag = false;
    const options = Object.create({ get bigint() { trace.push("bigint"); flag = true; return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } });
    expect(() => api[method]("/missing", options)).toThrow("ENOENT");
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry"]);
  });
  test(`${method} options proxy must not gain descriptor traps`, () => {
    const trace: string[] = [], api = fixture(trace);
    const options = new Proxy({ bigint: false, throwIfNoEntry: false }, {
      get(target, key, receiver) { trace.push(String(key)); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry"]);
  });
  test(`${method} bigint getter failure is handled by the original catch`, () => {
    const trace: string[] = [], api = fixture(trace);
    const sentinel = Object.assign(new Error("bigint getter"), { code: "ENOENT" });
    const options = { get bigint(): boolean { trace.push("bigint"); throw sentinel; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return false; } };
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "throwIfNoEntry"]);
  });
  test(`${method} second bigint getter failure is handled after successful metadata`, () => {
    const trace: string[] = [], api = fixture(trace);
    let reads = 0;
    const sentinel = Object.assign(new Error("second bigint getter"), { code: "ENOENT" });
    const options = { get bigint() { trace.push("bigint"); if (++reads === 2) throw sentinel; return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return false; } };
    expect(api[method]("/present", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "bigint", "throwIfNoEntry"]);
  });
  test(`${method} callback keeps getter order and deferred Error delivery`, async () => {
    const trace: string[] = [], api = fixture(trace);
    let flag = false, returned = false;
    const options = { get bigint() { trace.push("bigint"); flag = true; return false; }, get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } };
    const callback = method === "statSync" ? api.stat : api.lstat;
    const pending = new Promise<{ error: Error | null; value: unknown; returned: boolean }>(resolve =>
      callback("/missing", options, (error, value) => resolve({ error, value, returned })));
    returned = true;
    const result = await pending;
    expect(result.returned).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("ENOENT");
    expect(result.value).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "throwIfNoEntry"]);
  });
}
