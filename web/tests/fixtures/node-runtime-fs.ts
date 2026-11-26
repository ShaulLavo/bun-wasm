import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createNodeProcess, type NodeWasiImports } from "../../scripts/node-process.ts";
import { compileSections, section, utf8Name } from "../../src/nested/binary.ts";

// Original minimal guest linking the exact runtime_fs imports a Bun guest declares, re-exported
// so the checks call them through a real instance:
// (module
//   (import "runtime_fs" "watch_open" (func $open (param i32 i32 i32) (result i32)))
//   (import "runtime_fs" "watch_read" (func $read (param i32 i32 i32 i32) (result i32)))
//   (import "runtime_fs" "watch_close" (func $close (param i32) (result i32)))
//   (memory (export "memory") 1)
//   (func (export "_start"))
//   (func (export "open") (param i32 i32 i32) (result i32) local.get 0 local.get 1 local.get 2 call $open)
//   (func (export "read") (param i32 i32 i32 i32) (result i32) local.get 0 local.get 1 local.get 2 local.get 3 call $read)
//   (func (export "close") (param i32) (result i32) local.get 0 call $close))
const guest = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,24,4,96,3,127,127,127,1,127,96,4,127,127,127,127,1,127,96,1,127,1,127,96,0,0,2,74,3,10,114,117,110,
  116,105,109,101,95,102,115,10,119,97,116,99,104,95,111,112,101,110,0,0,10,114,117,110,116,105,109,101,95,102,115,10,119,97,
  116,99,104,95,114,101,97,100,0,1,10,114,117,110,116,105,109,101,95,102,115,11,119,97,116,99,104,95,99,108,111,115,101,0,2,
  3,5,4,3,0,1,2,5,3,1,0,1,7,41,5,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,3,4,111,112,101,110,0,4,4,114,101,
  97,100,0,5,5,99,108,111,115,101,0,6,10,35,4,2,0,11,10,0,32,0,32,1,32,2,16,0,11,12,0,32,0,32,1,32,2,32,3,16,1,11,6,0,32,0,
  16,2,11,
]));
interface WatchExports {
  memory: WebAssembly.Memory;
  open(fd: number, flags: number, out: number): number;
  read(id: number, buf: number, len: number, out: number): number;
  close(id: number): number;
}
const EAGAIN = 6, EBADF = 8, EFAULT = 21, EINVAL = 28, ENOTSUP = 58, PAGE = 65536, UNTOUCHED = 0xdeadbeef;
const scratch = mkdtempSync(join(process.argv[2] ?? tmpdir(), "bun-wasm-node-runtime-fs-"));
const owned: ReturnType<typeof createNodeProcess>[] = [];
function host(preopens?: Record<string, string>) {
  const created = createNodeProcess({ transport: createWorkerProcessTransport(), preopenCount: 1, preopens,
    postMessage() {}, finish(code): never { throw new Error(`unexpected exit ${code}`); } });
  owned.push(created);
  const wasi = new WASI({ version: "preview1", preopens: { "/": scratch }, env: {}, args: [], returnOnExit: true });
  return { created, wasi, imports: wasi.getImportObject() as NodeWasiImports };
}
try {
  writeFileSync(join(scratch, "file.txt"), "watched");

  const { created, wasi, imports } = host();
  let instance: WebAssembly.Instance | undefined;
  const { proc } = created.install(imports, () => instance!);
  instance = new WebAssembly.Instance(guest, imports);
  assert.deepEqual(Object.keys(imports.runtime_fs!).toSorted(), ["path_permissions_get", "path_probe", "path_realpath", "watch_close", "watch_next", "watch_open", "watch_read", "watch_ready"]);
  const permissions = imports.runtime_fs!.path_permissions_get;
  if (typeof permissions !== "function") throw new Error("missing path_permissions_get import");
  assert.equal(permissions(-1, -1, -1, -1, -1), ENOTSUP);
  wasi.start(instance as Parameters<typeof wasi.start>[0]);
  const readiness = compileSections(
    section(1, [1, 0x60, 0, 1, 0x7f]),
    section(2, [1].concat(utf8Name("runtime_fs"), utf8Name("watch_ready"), [0, 0])),
    section(7, [1].concat(utf8Name("ready"), [0, 0])),
  );
  const ready = new WebAssembly.Instance(readiness, imports).exports.ready;
  assert.equal(typeof ready, "function");
  if (typeof ready !== "function") throw new Error("missing readiness export");
  assert.equal(ready(), 0);
  const guestFs = instance.exports as unknown as WatchExports;
  const view = () => new DataView(guestFs.memory.buffer);
  const name = new TextEncoder().encode("file.txt");
  new Uint8Array(guestFs.memory.buffer).set(name, 256);
  const pathOpen = imports.wasi_snapshot_preview1.path_open! as (...args: (number | bigint)[]) => number;
  assert.equal(pathOpen(3, 0, 256, name.length, 0, 2n, 0n, 0, 128), 0);
  const file = view().getUint32(128, true);
  assert.equal(proc.pipe!(0), 0);
  const pipe = view().getUint32(0, true);

  // Waffle's Wasi over a filesystem without `watches`: validated descriptors report ENOTSUP and
  // write no id; ids never exist, so read and close are EBADF.
  const open = (fd: number, flags: number, out = 64) => {
    view().setUint32(64, UNTOUCHED, true);
    const errno = guestFs.open(fd, flags, out);
    assert.equal(view().getUint32(64, true), UNTOUCHED, "watch_open writes no id when it fails");
    return errno;
  };
  assert.deepEqual([open(3, 0), open(3, 1), open(file, 0)], [ENOTSUP, ENOTSUP, ENOTSUP]);
  assert.deepEqual([open(3, 2), open(pipe, 0), open(99, 0), open(3, 0, PAGE - 2)], [EINVAL, EINVAL, EBADF, EFAULT]);
  assert.deepEqual([guestFs.read(1, 512, 64, 128), guestFs.read(1, PAGE - 8, 64, 128), guestFs.read(1, 512, 64, PAGE - 2), guestFs.read(1, 512, 64, 520)], [EBADF, EFAULT, EFAULT, EINVAL]);
  assert.equal(guestFs.close(1), EBADF);
  // watch_next validates its spans, then reports nothing ready with out_id 0.
  const next = imports.runtime_fs!.watch_next as (outId: number, buf: number, len: number, out: number) => number;
  view().setUint32(64, UNTOUCHED, true);
  assert.equal(next(64, 512, 64, 128), EAGAIN);
  assert.equal(view().getUint32(64, true), 0, "watch_next clears out_id when nothing is ready");
  assert.deepEqual([next(PAGE - 2, 512, 64, 128), next(64, PAGE - 8, 64, 128), next(64, 512, 64, 64), next(520, 512, 64, 128)],
    [EFAULT, EFAULT, EINVAL, EINVAL]);

  // path_realpath (Waffle docs/host-abi.md): without a guest namespace a valid descriptor is
  // ENOTSUP; pointers, overlapping outputs and descriptors are checked first.
  const realpath = imports.runtime_fs!.path_realpath as (...args: number[]) => number;
  new Uint8Array(guestFs.memory.buffer).set(name, 256);
  assert.deepEqual([realpath(3, 256, name.length, 512, 64, 128), realpath(99, 256, name.length, 512, 64, 128),
    realpath(3, PAGE - 2, 8, 512, 64, 128), realpath(3, 256, name.length, 512, 64, 512)], [ENOTSUP, EBADF, EFAULT, EINVAL]);
  new Uint8Array(guestFs.memory.buffer).set([0xff], 256);
  assert.equal(realpath(3, 256, 1, 512, 64, 128), EINVAL);

  // With the guest namespace it answers in one call: links followed, the guest path back.
  mkdirSync(join(scratch, "real/dir"), { recursive: true });
  writeFileSync(join(scratch, "real/dir/file.txt"), "x");
  symlinkSync("real/dir", join(scratch, "link"));
  const named = host({ "/": scratch });
  let namedInstance: WebAssembly.Instance | undefined;
  named.created.install(named.imports, () => namedInstance!);
  namedInstance = new WebAssembly.Instance(guest, named.imports);
  named.wasi.start(namedInstance as Parameters<typeof wasi.start>[0]);
  const namedMemory = (namedInstance.exports as unknown as WatchExports).memory;
  const resolveReal = (path: string, capacity = 64) => {
    const input = new TextEncoder().encode(path);
    new Uint8Array(namedMemory.buffer).set(input, 256);
    const errno = (named.imports.runtime_fs!.path_realpath as (...args: number[]) => number)(3, 256, input.length, 512, capacity, 128);
    const used = new DataView(namedMemory.buffer).getUint32(128, true);
    return [errno, new TextDecoder().decode(new Uint8Array(namedMemory.buffer, 512, errno === 0 ? used : 0)), used];
  };
  assert.deepEqual(resolveReal("link/file.txt"), [0, "/real/dir/file.txt", 18]);
  assert.deepEqual(resolveReal("link/file.txt", 4), [42, "", 18]);
  symlinkSync("real/dir/file.txt/", join(scratch, "slashed"));
  assert.deepEqual([resolveReal("link/missing")[0], resolveReal("real/dir/file.txt/")[0], resolveReal("/real")[0]], [44, 54, 63]);
  assert.deepEqual([resolveReal("real/dir/file.txt/.")[0], resolveReal("slashed")[0], resolveReal("link/.")[1]], [54, 54, "/real/dir"]);

  // path_probe (Waffle docs/host-abi.md): checks a NUL-terminated candidate list in order.
  const probe = (paths: string[], kind: number, fd = 3) => {
    const input = new TextEncoder().encode(paths.map(path => path + "\0").join(""));
    new Uint8Array(namedMemory.buffer).set(input, 256);
    new DataView(namedMemory.buffer).setUint32(128, UNTOUCHED, true);
    const errno = (named.imports.runtime_fs!.path_probe as (...args: number[]) => number)(fd, 256, input.length, kind, 128);
    return [errno, new DataView(namedMemory.buffer).getUint32(128, true)];
  };
  assert.deepEqual(probe(["missing", "link/file.txt", "real/dir"], 1), [0, 1]);
  assert.deepEqual(probe(["real/dir/file.txt", "link"], 2), [0, 1]);
  assert.deepEqual(probe(["missing", "real/dir/file.txt/"], 1), [0, 0xffffffff]);
  assert.deepEqual(probe(["real/dir"], 2, 99), [EBADF, UNTOUCHED]);
  // Leading U+FEFF (UTF-8 BOM) is part of the filename, never stripped.
  writeFileSync(join(scratch, "module.js"), "x");
  assert.deepEqual(probe(["\uFEFFmodule.js"], 1), [0, 0xffffffff]);
  writeFileSync(join(scratch, "\uFEFFmodule.js"), "x");
  assert.deepEqual(probe(["\uFEFFmodule.js"], 1), [0, 0]);
  // More than 64 pathnames is rejected with EINVAL.
  assert.deepEqual(probe(Array.from({ length: 65 }, () => "missing"), 1), [EINVAL, UNTOUCHED]);

  // A guest that fails before wasi.start() still releases its process host; the unstarted Node
  // WASI keeps its preopen, so release must not surface ERR_WASI_NOT_STARTED.
  const unstarted = host();
  unstarted.created.install(unstarted.imports, () => { throw new Error("never instantiated"); });
  owned.splice(owned.indexOf(unstarted.created), 1);
  unstarted.created.dispose();
  console.log("Node runtime_fs links, answers Waffle's unwatchable-filesystem errnos and releases unstarted hosts");
} catch (error) {
  // Report the check that failed even when releasing its hosts fails too.
  console.error(error);
  process.exitCode = 1;
} finally {
  try { for (const each of owned.toReversed()) each.dispose(); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
