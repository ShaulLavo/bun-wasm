import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Buffer } from "node:buffer";
import path from "node:path";

function source(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}
const fsSource = source("crates/bunwasm-runtime/src/js/node_fs.js");
const optionsSource = source("crates/bunwasm-runtime/src/js/fs_options.ts");
const hostSource = source("web/src/engine-host.js");
const start = hostSource.indexOf("const ERRORS = ");
const end = hostSource.indexOf("// Thrown to unwind", start);
if (start < 0 || end < start) throw new Error("Browser error materializer boundaries changed");
const materializer = hostSource.slice(start, end);
type Api = Record<"statSync" | "lstatSync", (file: string, options: object) => unknown>;

function fixture(trace: string[], onPath: () => void): Api {
  const realm = createContext({ Uint8Array, ArrayBuffer, URL, Date, FinalizationRegistry, onPath });
  runInContext(materializer, realm);
  runInContext(`Object.defineProperty(Error.prototype, "path", {
    configurable: true,
    set(value) {
      onPath();
      Object.defineProperty(this, "path", { value, writable: true, enumerable: true, configurable: true });
    },
  });`, realm);
  const native = {
    hostCaps: { proc_spawn: false },
    stat(file: string) {
      trace.push("native");
      realm.info = { kind: "Error", message: `ENOENT: no such file or directory, stat '${file}'`,
        name: null, props: { path: file, syscall: "stat", errno: -2, code: "ENOENT" } };
      throw runInContext("nativeError(info)", realm);
    },
  };
  const helpers = runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${optionsSource}`), realm)({});
  return runInContext(fsSource, realm)({ native, describe: String, realTimers: { setImmediate },
    require(name: string) {
      if (name === "buffer") return { Buffer };
      if (name === "path") return path;
      if (name === "fs_options") return helpers;
      if (name === "fs_watch") return () => ({});
      throw new Error(`Unexpected dependency ${name}`);
    },
  }).fs;
}

for (const method of ["statSync", "lstatSync"] as const) {
  test(`${method} suppressed error still invokes the browser materializer path setter`, () => {
    const trace: string[] = [];
    const api = fixture(trace, () => { trace.push("path-setter"); });
    const options = { get bigint() { trace.push("bigint"); return false; },
      get throwIfNoEntry() { trace.push("throwIfNoEntry"); return false; } };
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "path-setter", "throwIfNoEntry"]);
  });
  test(`${method} materializer can change false suppression flag to true`, () => {
    const trace: string[] = [];
    let flag = false;
    const api = fixture(trace, () => { trace.push("path-setter"); flag = true; });
    const options = { get bigint() { trace.push("bigint"); return false; },
      get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } };
    expect(() => api[method]("/missing", options)).toThrow("ENOENT");
    expect(trace).toEqual(["bigint", "native", "path-setter", "throwIfNoEntry"]);
  });
  test(`${method} materializer can change true suppression flag to false`, () => {
    const trace: string[] = [];
    let flag = true;
    const api = fixture(trace, () => { trace.push("path-setter"); flag = false; });
    const options = { get bigint() { trace.push("bigint"); return false; },
      get throwIfNoEntry() { trace.push("throwIfNoEntry"); return flag; } };
    expect(api[method]("/missing", options)).toBeUndefined();
    expect(trace).toEqual(["bigint", "native", "path-setter", "throwIfNoEntry"]);
  });
}
