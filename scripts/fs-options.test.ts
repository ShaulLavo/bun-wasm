import { afterEach, expect, test } from "bun:test";
import * as host from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { checkFsOptions, checkBigintStats, checkCopyOptions, checkCopyTypeErrors } from "../tests/fixtures/fs-options/index";

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
    writev(fd: number, buffers: Uint8Array[], position: number) { return host.writevSync(fd, buffers, position < 0 ? undefined : position); },
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
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
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

test("no-overwrite copies still reject file-to-directory conflicts", async () => {
  const { fs, root } = fixture();
  await checkCopyTypeErrors(fs, root);
});

test("creation defaults are 0666 before umask while explicit modes survive", async () => {
  const { fs, root } = fixture();
  const previous = process.umask(0);
  try {
    fs.writeFileSync(path.join(root, "write-default"), "x");
    fs.closeSync(fs.openSync(path.join(root, "open-default"), "w"));
    await fs.promises.writeFile(path.join(root, "promise-default"), "x");
    await new Promise<void>((resolve, reject) => fs.writeFile(path.join(root, "callback-default"), "x",
      (error: NodeJS.ErrnoException | null) => error ? reject(error) : resolve()));
    const handle = await fs.promises.open(path.join(root, "handle-default"), "w");
    await handle.close();
    for (const name of ["write-default", "open-default", "promise-default", "callback-default", "handle-default"]) {
      expect(host.statSync(path.join(root, name)).mode & 0o777).toBe(0o666);
    }
    fs.writeFileSync(path.join(root, "write-explicit"), "x", { mode: 0o600 });
    fs.closeSync(fs.openSync(path.join(root, "open-explicit"), "w", 0o640));
    expect(host.statSync(path.join(root, "write-explicit")).mode & 0o777).toBe(0o600);
    expect(host.statSync(path.join(root, "open-explicit")).mode & 0o777).toBe(0o640);
    process.umask(0o027);
    fs.writeFileSync(path.join(root, "write-masked"), "x");
    expect(host.statSync(path.join(root, "write-masked")).mode & 0o777).toBe(0o640);
  } finally {
    process.umask(previous);
  }
});

type CopyMode = {
  name: string;
  copy(api: typeof host, from: string, to: string, options?: host.CopySyncOptions): Promise<void>;
};
const copyModes: readonly CopyMode[] = [
  { name: "sync", copy: async (api, from, to, options) => { api.cpSync(from, to, options); } },
  { name: "promise", copy: (api, from, to, options) => api.promises.cp(from, to, options) },
  { name: "callback", copy: (api, from, to, options) => new Promise<void>((resolve, reject) => {
    api.cp(from, to, options ?? {}, error => error ? reject(error) : resolve());
  }) },
];

for (const mode of copyModes) {
  test(`${mode.name} copy creates missing nested destination parents`, async () => {
    const { fs, root } = fixture();
    const from = path.join(root, "source");
    const to = path.join(root, "missing/nested/asset");
    host.writeFileSync(from, "asset");
    await mode.copy(fs, from, to);
    expect(host.readFileSync(to, "utf8")).toBe("asset");
  });

  test(`${mode.name} false copy filter leaves destination parents absent`, async () => {
    const { fs, root } = fixture();
    const from = path.join(root, "source");
    host.writeFileSync(from, "asset");
    await mode.copy(fs, from, path.join(root, "missing/nested/asset"), { filter: () => false });
    expect(host.existsSync(path.join(root, "missing"))).toBe(false);
  });
}

function callbackCopy(api: typeof host, from: string, to: string, options: host.CopyOptions): Promise<void> {
  return new Promise((resolve, reject) => api.cp(from, to, options, error => error ? reject(error) : resolve()));
}

test("async false and rejected copy filters leave destination parents absent", async () => {
  const { fs, root } = fixture();
  const from = path.join(root, "source");
  const to = path.join(root, "missing/nested/asset");
  host.writeFileSync(from, "asset");
  await fs.promises.cp(from, to, { filter: async () => false });
  await callbackCopy(fs, from, to, { filter: async () => false });
  const error = new Error("filter rejected");
  const filter = async () => { throw error; };
  await expect(fs.promises.cp(from, to, { filter })).rejects.toBe(error);
  await expect(callbackCopy(fs, from, to, { filter })).rejects.toBe(error);
  expect(() => fs.cpSync(from, to, { filter: () => { throw error; } })).toThrow(error);
  expect(host.existsSync(path.join(root, "missing"))).toBe(false);
});

test("file copies retain source and destination symlink behavior", async () => {
  const { fs, root } = fixture();
  const from = path.join(root, "source");
  const sourceLink = path.join(root, "source-link");
  const target = path.join(root, "target");
  const destinationLink = path.join(root, "destination-link");
  host.writeFileSync(from, "asset");
  host.symlinkSync(from, sourceLink);
  host.writeFileSync(target, "old");
  host.symlinkSync(target, destinationLink);
  fs.cpSync(sourceLink, path.join(root, "copied-link"));
  expect(host.lstatSync(path.join(root, "copied-link")).isSymbolicLink()).toBe(false);
  expect(host.readFileSync(path.join(root, "copied-link"), "utf8")).toBe("asset");
  await fs.promises.cp(from, destinationLink);
  expect(host.lstatSync(destinationLink).isSymbolicLink()).toBe(true);
  expect(host.readFileSync(target, "utf8")).toBe("asset");
});

test("a trailing destination slash does not create the file path as a directory", async () => {
  const { fs, root } = fixture();
  const from = path.join(root, "source");
  const to = path.join(root, "destination");
  host.writeFileSync(from, "asset");
  await expect(fs.promises.cp(from, to + "/")).rejects.toThrow();
  expect(host.existsSync(to)).toBe(false);
});
