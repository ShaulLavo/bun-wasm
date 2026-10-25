import { afterEach, expect, test } from "bun:test";
import * as host from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { checkFsOptions, checkBigintStats, checkCopyOptions } from "../tests/fixtures/fs-options/index";

const source = host.readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url), "utf8");
const roots: string[] = [];
const descriptors = new Set<number>();
afterEach(() => {
  for (const fd of descriptors) host.closeSync(fd);
  descriptors.clear();
  for (const root of roots) host.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function metadata(raw: host.Stats | host.BigIntStats) {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "number" || typeof value === "bigint"));
}
function fixture() {
  const root = host.mkdtempSync(path.join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-fs-options-"));
  roots.push(root);
  const native = {
    hostCaps: { proc_spawn: false },
    open(file: string, flags: string | number, mode?: number) {
      const fd = host.openSync(file, flags, mode);
      descriptors.add(fd);
      return fd;
    },
    close(fd: number) { host.closeSync(fd); descriptors.delete(fd); },
    write(fd: number, bytes: string | Uint8Array) { return host.writeSync(fd, Buffer.from(bytes)); },
    writeFile(file: string, bytes: string | Uint8Array, append: boolean) { host.writeFileSync(file, bytes, { flag: append ? "a" : "w" }); },
    writeFileFlags(file: string, bytes: string | Uint8Array, flags: number, mode: number) { const fd = host.openSync(file, flags, mode); try { host.writeFileSync(fd, bytes); } finally { host.closeSync(fd); } },
    readFile: host.readFileSync,
    exists: host.existsSync,
    stat(file: string, link: boolean, bigint = false) { return metadata(link ? host.lstatSync(file, { bigint }) : host.statSync(file, { bigint })); },
    fstat(fd: number, bigint = false) { return metadata(host.fstatSync(fd, { bigint })); },
    mkdir(file: string, recursive: boolean) { return host.mkdirSync(file, { recursive }); },
    readdir(file: string) { return host.readdirSync(file, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? "dir" : "file"]); },
    copyFile: host.copyFileSync,
    copyDir(from: string, to: string) { host.cpSync(from, to, { recursive: true }); },
    symlink: host.symlinkSync,
    utf8Decode(bytes: Uint8Array) { return Buffer.from(bytes).toString(); },
  };
  const factory = runInNewContext(source, { Uint8Array, ArrayBuffer, URL, Date, FinalizationRegistry });
  const fsOptionsPath = new URL("../crates/bunwasm-runtime/src/js/fs_options.ts", import.meta.url);
  const helpers = host.existsSync(fsOptionsPath) ? runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${host.readFileSync(fsOptionsPath, "utf8")}`), { Date })({}) : null;
  const { fs } = factory({ native, describe: String,
    require(name: string) {
      if (name === "buffer") return { Buffer };
      if (name === "path") return path;
      if (name === "fs_watch") return () => ({});
      if (name === "fs_options") return helpers;
      throw new Error(`Unexpected dependency ${name}`);
    },
    realTimers: { setImmediate },
  });
  return { fs, root, native };
}
test("open and write preserve caller flags through every API", async () => {
  const { fs, root } = fixture();
  await checkFsOptions(fs, root);
});
test("path, link, descriptor and FileHandle bigint stats", async () => {
  const { fs, root } = fixture();
  await checkBigintStats(fs, root);
});
test("copy overwrite and sync/async filters", async () => {
  const { fs, root } = fixture();
  await checkCopyOptions(fs, root);
});
test("metadata beyond Number.MAX_SAFE_INTEGER is not rounded", () => {
  const { fs, native } = fixture();
  const value = 9007199254740993n;
  Object.assign(native, { stat: () => ({ dev: value, ino: value, size: value, mode: 0o100644n, mtimeMs: 1700000000123n,
    atimeMs: 0n, ctimeMs: 0n, birthtimeMs: 0n, mtimeNs: "1700000000123456789" }) });
  const result = fs.statSync("synthetic", { bigint: true });
  expect(result.size).toBe(value);
  expect(result.ino).toBe(value);
  expect(result.mtimeNs).toBe(1700000000123456789n);
});

test("bigint timestamps preserve negative nanoseconds", () => {
  const { fs, native } = fixture();
  Object.assign(native, { stat: () => ({ mode: 0o100644n, atimeMs: "-1", mtimeMs: "-1", ctimeMs: "-1", birthtimeMs: "-1",
    atimeNs: "-1000001", mtimeNs: "-1000001", ctimeNs: "-1000001", birthtimeNs: "-1000001" }) });
  const result = fs.statSync("synthetic", { bigint: true });
  expect(result.mtimeNs).toBe(-1000001n);
  expect(result.mtimeMs).toBe(-1n);
  expect(result.mtime.getTime()).toBe(-1);
});
