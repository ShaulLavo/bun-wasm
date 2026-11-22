import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import * as host from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { inspect } from "node:util";
import { execFileSync } from "node:child_process";
import { loadFileHandleModule } from "./fs-file-handle-source";
import { checkFsOptions, checkBigintStats, checkCopyOptions, checkCopyTypeErrors } from "../tests/fixtures/fs-options/index";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

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
    readdir(file: string) {
      return host.readdirSync(file, { withFileTypes: true }).map(entry => [
        entry.name,
        entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file",
      ]);
    },
    copyFile: host.copyFileSync,
    copyDir(from: string, to: string) { host.cpSync(from, to, { recursive: true }); },
    symlink: host.symlinkSync,
    utf8Decode(bytes: Uint8Array) { return Buffer.from(bytes).toString(); },
  };
  const factory = runInNewContext(source, { Uint8Array, ArrayBuffer, URL, Date, FinalizationRegistry });
  const fsOptionsPath = new URL("../crates/bunwasm-runtime/src/js/fs_options.ts", import.meta.url);
  const helpers = host.existsSync(fsOptionsPath) ? runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${host.readFileSync(fsOptionsPath, "utf8")}`), { Date })({}) : null;
  const buffersReaddirSource = host.readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_buffers_readdir.ts", import.meta.url), "utf8");
  const buffersReaddir = runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${buffersReaddirSource}`),
    { Uint8Array, ArrayBuffer, DataView },
  )();
  const fileHandles = loadFileHandleModule();
  const { fs } = factory({ native, describe: String,
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    require(name: string) {
      if (name === "buffer") return { Buffer };
      if (name === "path") return path;
      if (name === "fs_watch") return () => ({});
      if (name === "fs_options") return helpers;
      if (name === "fs_buffers_readdir") return buffersReaddir;
      if (name === "fs_file_handle") return fileHandles;
      if (name === "inspect") return { nodeInspect: inspect };
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
  test(`${mode.name} copy below a regular file retains ENOTDIR`, async () => {
    const { fs, root } = fixture();
    const from = path.join(root, "source");
    const parent = path.join(root, "file-parent");
    const to = path.join(parent, "asset");
    host.writeFileSync(from, "asset");
    host.writeFileSync(parent, "not a directory");
    await expect(mode.copy(host, from, to)).rejects.toMatchObject({ code: "ENOTDIR" });
    execFileSync("node", ["--input-type=module", "-e", `
      import * as fs from "node:fs";
      import assert from "node:assert/strict";
      await assert.rejects((${mode.copy.toString()})(fs, process.argv[1], process.argv[2]), { code: "ENOTDIR" });
    `, from, to]);
    await expect(mode.copy(fs, from, to)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(host.readFileSync(parent, "utf8")).toBe("not a directory");
  });

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

test("an abstract socket name is not a filesystem path: unlink rejects its NUL before any native call", () => {
  const { fs, native } = fixture();
  const unlink = Object.assign(() => { throw new Error("unlink reached the native filesystem"); });
  Object.assign(native, { unlink, rm: unlink });
  expect(() => fs.unlinkSync("\0nuxt-vite-node.sock")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
});

test("writevSync uses intrinsic view metadata, handles detached DataViews, and snapshots length once", () => {
  const { fs, root } = fixture();
  const out = path.join(root, "writev-intrinsic.bin");
  const backing = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35]);
  const ta = backing.subarray(1, 4);
  Object.defineProperty(ta, "byteLength", { value: 0 });
  Object.defineProperty(ta, "byteOffset", { value: 99 });
  Object.defineProperty(ta, "buffer", { value: { detached: true } });

  const dv = new DataView(backing.buffer, 0, 3);
  Object.defineProperty(dv, "byteLength", { value: 0 });
  Object.defineProperty(dv, "byteOffset", { value: 99 });
  Object.defineProperty(dv, "buffer", { value: { detached: true } });

  const detachedAb = new ArrayBuffer(8);
  const detachedDv = new DataView(detachedAb);
  detachedAb.transfer();

  const list: ArrayBufferView[] = [ta, dv, detachedDv];
  Object.defineProperty(list, 1, {
    enumerable: true,
    configurable: true,
    get() {
      list.push(Buffer.from("EXTRA"));
      return dv;
    },
  });

  const fd = fs.openSync(out, "w");
  try {
    expect(fs.writevSync(fd, list)).toBe(6);
  } finally {
    fs.closeSync(fd);
  }
  expect(host.readFileSync(out, "utf8")).toBe("234123");
});

test("recursive readdir error paths and Dirent parentPath match Bun for sync and async", async () => {
  const { fs, root } = fixture();
  const walk = path.join(root, "walk");
  host.mkdirSync(path.join(walk, "sub"), { recursive: true });
  host.writeFileSync(path.join(walk, "sub", "f.txt"), "x");
  host.symlinkSync("sub", path.join(walk, "alias"));

  const withSlash = `${walk}/`;
  const dirents = fs.readdirSync(withSlash, { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath: string }>;
  const map = Object.fromEntries(dirents.map(d => [`${d.parentPath}|${d.name}`, true]));
  expect(map[`${walk}|sub`]).toBe(true);
  expect(map[`${walk}/sub|f.txt`]).toBe(true);
  expect(map[`${walk}/alias|f.txt`]).toBe(true);

  host.symlinkSync("loop", path.join(walk, "sub", "loop"));
  let syncErr: NodeJS.ErrnoException | undefined;
  try {
    fs.readdirSync(walk, { recursive: true });
  } catch (err) {
    syncErr = err as NodeJS.ErrnoException;
  }
  expect(syncErr?.code).toBe("ELOOP");
  expect(syncErr?.path).toBe(walk);
  expect(syncErr?.syscall).toBe("scandir");

  const cbErr = await new Promise<NodeJS.ErrnoException | null>(resolve => fs.readdir(walk, { recursive: true }, resolve));
  expect(cbErr?.code).toBe("ELOOP");
  expect(cbErr?.path).toBe(path.join(walk, "sub", "loop"));
  expect(cbErr?.syscall).toBe("open");

  let promErr: NodeJS.ErrnoException | undefined;
  try {
    await fs.promises.readdir(walk, { recursive: true });
  } catch (err) {
    promErr = err as NodeJS.ErrnoException;
  }
  expect(promErr?.code).toBe("ELOOP");
  expect(promErr?.path).toBe(path.join(walk, "sub", "loop"));
  expect(promErr?.syscall).toBe("open");
});

test("fs.promises preserves frozen error identity and existing stack frames", async () => {
  const { fs, root } = fixture();
  const frozen = Object.freeze(Object.assign(new Error("frozen failure"), { stack: "Error: frozen failure\n    at origin" }));
  let caught: unknown;
  try {
    await fs.promises.readFile(path.join(root, "x"), {
      get encoding() {
        throw frozen;
      },
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBe(frozen);

  const mutable = Object.assign(new Error("mutable failure"), { stack: "Error: mutable failure\n    at innerOrigin (foo.ts:1:1)" });
  let caughtMutable: Error | undefined;
  async function outerCaller() {
    await fs.promises.readFile(path.join(root, "x"), {
      get encoding() {
        throw mutable;
      },
    });
  }
  try {
    await outerCaller();
  } catch (err) {
    caughtMutable = err as Error;
  }
  expect(caughtMutable).toBe(mutable);
  expect(caughtMutable?.stack).toContain("at innerOrigin (foo.ts:1:1)");

  // Directly verify attachAsyncStack appends frames on mutable errors and skips frozen/non-writable ones.
  const buffersReaddirSource = host.readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_buffers_readdir.ts", import.meta.url), "utf8");
  const buffersReaddir = runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${buffersReaddirSource}`),
    { Uint8Array, ArrayBuffer, DataView },
  )();
  const syntheticCaptured = "Error\n    at promisifySync\n    at async outerFrame (app.ts:10:5)";
  const frozenDirect = Object.freeze(Object.assign(new Error("boom"), { stack: "Error: boom\n    at innerFrame (lib.ts:2:3)" }));
  expect(() => buffersReaddir.attachAsyncStack(frozenDirect, syntheticCaptured)).not.toThrow();
  expect(frozenDirect.stack).toBe("Error: boom\n    at innerFrame (lib.ts:2:3)");
  const mutableDirect = Object.assign(new Error("boom"), { stack: "Error: boom\n    at innerFrame (lib.ts:2:3)" });
  buffersReaddir.attachAsyncStack(mutableDirect, syntheticCaptured);
  expect(mutableDirect.stack).toContain("at innerFrame (lib.ts:2:3)");
  expect(mutableDirect.stack).toContain("at async outerFrame (app.ts:10:5)");
});

test("fs.symlink delivers a single argument callback on 3-arg and 4-arg calls", async () => {
  const { fs, root } = fixture();
  const target = path.join(root, "target.txt");
  host.writeFileSync(target, "ok");
  const args3 = await new Promise<unknown[]>(resolve => {
    fs.symlink(target, path.join(root, "l3"), function (...args: unknown[]) { resolve(args); });
  });
  expect(args3).toEqual([undefined]);
  const args4 = await new Promise<unknown[]>(resolve => {
    fs.symlink(target, path.join(root, "l4"), "file", function (...args: unknown[]) { resolve(args); });
  });
  expect(args4).toEqual([undefined]);
});

test("FileHandle GC finalizer closes leaked fds with ERR_INVALID_STATE and never closes reused fds", async () => {
  const registrations: Array<{ held: unknown; token: unknown }> = [];
  let onCollect: ((held: unknown) => void) | undefined;
  class FakeRegistry {
    constructor(cb: (held: unknown) => void) { onCollect = cb; }
    register(_target: object, held: unknown, token: unknown) { registrations.push({ held, token }); }
    unregister(token: unknown) {
      const idx = registrations.findIndex(r => r.token === token);
      if (idx >= 0) registrations.splice(idx, 1);
    }
  }
  const fhSource = host.readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_file_handle.ts", import.meta.url), "utf8");
  const factory = runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${fhSource}`),
    { TextEncoder, DOMException, FinalizationRegistry: FakeRegistry },
  );
  const { EventEmitter } = await import("node:events");
  const createFileHandles = factory({
    describe: String,
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "streams") return { ReadableStream };
      throw new Error(name);
    },
  });
  const closedFds: number[] = [];
  const deferred: (() => void)[] = [];
  const { FileHandle } = createFileHandles({
    Buffer,
    closeSync: (fd: number) => closedFds.push(fd),
    later: (fn: () => void) => deferred.push(fn),
  });

  // Dropped handle: registered, collected -> closes fd and schedules ERR_INVALID_STATE with path.
  new FileHandle(42, "/tmp/leaked.txt");
  expect(registrations.length).toBe(1);
  onCollect!(registrations[0]!.held);
  expect(closedFds).toEqual([42]);
  expect(deferred.length).toBe(1);
  expect(() => deferred.shift()!()).toThrow(/ERR_INVALID_STATE|File descriptor: 42 \(\/tmp\/leaked\.txt\)/);

  // Explicitly closed handle: unregistered before close so a reused fd is never closed.
  closedFds.length = 0;
  registrations.length = 0;
  const h = new FileHandle(43, "/tmp/closed.txt");
  expect(registrations.length).toBe(1);
  const heldBeforeClose = registrations[0]!.held;
  await h.close();
  expect(closedFds).toEqual([43]);
  expect(registrations.length).toBe(0);
  // Even if finalizer somehow ran with the old held state, it must not close reused fd 43.
  onCollect!(heldBeforeClose);
  expect(closedFds).toEqual([43]);
  expect(deferred.length).toBe(0);
});
