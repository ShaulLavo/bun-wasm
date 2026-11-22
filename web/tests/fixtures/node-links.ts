// Runs under Node: drives Node WASI's path calls through installNodeLinks and prints the
// observed results as JSON for node-links.test.ts.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { installNodeLinks } from "../../scripts/node-links.ts";

const parent = mkdtempSync(join(tmpdir(), "bun-wasm-node-links-"));
try {
  const root = join(parent, "root");
  mkdirSync(join(root, "tmp/d"), { recursive: true });
  writeFileSync(join(root, "tmp/d/a.txt"), "inside");
  const outside = join(parent, "outside.txt");
  writeFileSync(outside, "outside");
  // Links a host program could follow out of the preopen.
  symlinkSync(outside, join(root, "host-absolute"));
  symlinkSync(parent, join(root, "host-parent"));
  const climb = "../".repeat(40) + parent.slice(1);
  symlinkSync(climb, join(root, "host-climb"));

  const preopens = { "/": root };
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens, returnOnExit: true });
  // A module that only exports one page of memory.
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  const calls = wasi.wasiImport as unknown as Record<string, (...args: unknown[]) => number>;
  installNodeLinks(wasi.wasiImport as never, () => memory, preopens);
  wasi.initialize(instance);

  const encoder = new TextEncoder();
  const view = () => new DataView(memory.buffer);
  const put = (at: number, text: string): [number, number] => {
    const encoded = encoder.encode(text);
    new Uint8Array(memory.buffer).set(encoded, at);
    new Uint8Array(memory.buffer)[at + encoded.length] = 0;
    return [at, encoded.length];
  };
  const symlink = (target: string, path: string) => calls.path_symlink!(...put(1024, target), 3, ...put(1536, path));
  const readlink = (path: string) => {
    const errno = calls.path_readlink!(3, ...put(1024, path), 2048, 256, 128);
    return errno || new TextDecoder().decode(new Uint8Array(memory.buffer, 2048, view().getUint32(128, true)));
  };
  /** [filetype, size] or an errno. */
  const stat = (fd: number, follow: boolean, path: string) => {
    const errno = calls.path_filestat_get!(fd, follow ? 1 : 0, ...put(1024, path), 2048);
    return errno || [view().getUint8(2064), Number(view().getBigUint64(2080, true))];
  };
  const open = (fd: number, follow: boolean, path: string, oflags = 0) => {
    const errno = calls.path_open!(fd, follow ? 1 : 0, ...put(1024, path), oflags, 2n | 1n << 21n, 0n, 0, 128);
    return errno ? -errno : view().getUint32(128, true);
  };
  const call = (name: string, path: string) => calls[name]!(3, ...put(1024, path));

  const results: Record<string, unknown> = {};
  results.create = symlink("/tmp/d/a.txt", "tmp/d/abs");
  results.stored = readlinkSync(join(root, "tmp/d/abs"));
  results.readlink = readlink("tmp/d/abs");
  results.lstat = stat(3, false, "tmp/d/abs");
  results.stat = stat(3, true, "tmp/d/abs");
  const file = open(3, true, "tmp/d/abs");
  results.fileSize = file > 0 && calls.fd_filestat_get!(file, 2048) === 0 ? Number(view().getBigUint64(2080, true)) : file;
  results.dirlink = symlink("/tmp/d", "dirlink");
  results.through = stat(3, false, "dirlink/a.txt");
  results.trailing = (stat(3, false, "dirlink/") as number[])[0];
  results.readThrough = readlink("dirlink/abs");
  results.mkdir = call("path_create_directory", "dirlink/made");
  results.made = existsSync(join(root, "tmp/d/made"));
  results.rmdir = call("path_remove_directory", "dirlink/made");
  const directory = open(3, true, "dirlink", 2);
  results.dotDot = stat(directory, true, "../d/abs");
  results.close = calls.fd_close!(directory);

  results.climbing = ["../outside.txt", "/../outside.txt", "tmp/../../../outside.txt", "..", "/.."].map((target, index) => symlink(target, `climb${index}`));
  results.confined = ["climb0", "climb1", "climb2", "climb3/outside.txt", "climb4/outside.txt", "host-absolute", "host-parent/outside.txt",
    "host-climb/outside.txt", "../outside.txt", "tmp/../../outside.txt"].map(path => [stat(3, true, path), open(3, true, path)]);
  results.landed = [call("path_create_directory", "climb3/made"), existsSync(join(root, "made")), existsSync(join(parent, "made"))];
  results.placed = [symlink("x", "climb4/placed"), lstatSync(join(root, "placed")).isSymbolicLink(), existsSync(join(parent, "placed"))];
  // A directory renamed under an open descriptor, by this process and by another (the host):
  // a climbing link at its new place and a real directory at its old one never escape.
  for (const [name, rename] of [["guest", (from: string, to: string) => calls.path_rename!(3, ...put(1024, from), 3, ...put(1536, to))],
    ["host", (from: string, to: string) => { renameSync(join(root, from), join(root, to)); return 0; }]] as const) {
    mkdirSync(join(root, `${name}-a`));
    const moved = open(3, false, `${name}-a`, 2);
    const renamed = rename(`${name}-a`, `${name}-b`);
    mkdirSync(join(root, `${name}-a/x`), { recursive: true });
    symlinkSync(climb, join(root, `${name}-b/x`));
    results[`${name}Rename`] = [renamed, stat(moved, true, "x/outside.txt"), open(moved, true, "x/outside.txt"), calls.fd_close!(moved)];
  }
  results.loop = [symlink("/b", "a"), symlink("/a", "b"), stat(3, true, "a"), open(3, true, "a/x")];
  console.log(JSON.stringify(results));
} finally {
  rmSync(parent, { recursive: true, force: true });
}
