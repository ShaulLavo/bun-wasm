import { expect } from "bun:test";
import { MemFS } from "../src/fs";
import { Wasi, type WasiOptions } from "waffle/core";

const encoder = new TextEncoder();
const signatures = {
  path_open: "iiiiijjii",
  path_filestat_get: "iiiii",
  path_filestat_set_times: "iiiijji",
  path_create_directory: "iii",
  path_remove_directory: "iii",
  path_unlink_file: "iii",
  path_readlink: "iiiiii",
  path_rename: "iiiiii",
  path_link: "iiiiiii",
  path_symlink: "iiiii",
  fd_fdstat_get: "ii",
  fd_fdstat_set_rights: "ijj",
  poll_oneoff: "iiii",
  fd_pread: "iiiji",
  fd_readdir: "iiiji",
  fd_renumber: "ii",
  fd_filestat_get: "ii",
  fd_seek: "ijii",
  fd_tell: "ii",
  fd_close: "i",
  fd_read: "iiii",
  fd_write: "iiii",
  fd_pwrite: "iiiji",
};

function uleb(value: number) {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

const name = (value: string) => uleb(value.length).concat(Array.from(encoder.encode(value)));
const vector = (items: number[][]) => uleb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(uleb(bytes.length), bytes);

function syscallModule() {
  const entries = Object.entries(signatures);
  const types = entries.map(([, params]) => [0x60, params.length].concat(Array.from(params, (p) => p === "j" ? 0x7e : 0x7f), [1, 0x7f]));
  const imports = entries.map(([key], i) => name("wasi_snapshot_preview1").concat(name(key), [0], uleb(i)));
  const exports = entries.map(([key], i) => name(key).concat([0], uleb(i)));
  exports.push(name("memory").concat([2, 0]), name("_start").concat([0], uleb(entries.length)));
  return new WebAssembly.Module(new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, vector(types.concat([[0x60, 0, 0]]))),
      section(2, vector(imports)),
      section(3, [1].concat(uleb(entries.length))),
      section(5, [1, 0, 1]),
      section(7, vector(exports)),
      section(10, [1, 2, 0, 0x0b]),
    ),
  ));
}

type Syscall = (...args: (number | bigint)[]) => number;
type Calls = Record<keyof typeof signatures, Syscall> & { memory: WebAssembly.Memory };
function checkedExports(exports: WebAssembly.Exports): Calls {
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("missing syscall fixture memory");
  for (const key of Object.keys(signatures)) {
    if (typeof exports[key] !== "function") throw new Error(`missing syscall fixture export ${key}`);
  }
  return exports as Calls;
}

const module = syscallModule();
export function host(preopens: Record<string, string> = { "/allowed": "/allowed" }, options: Partial<WasiOptions> = {}) {
  const fs = new MemFS();
  fs.writeFile("/allowed/inside", "inside");
  fs.mkdirp("/allowed/sub");
  fs.writeFile("/outside", "outside");
  fs.mkdirp("/outside-dir");
  fs.writeFile("/allowed-sibling/secret", "secret");
  const wasi = new Wasi({ args: [], env: {}, fs, preopens, stdout() {}, stderr() {}, sleep() {}, ...options });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  expect(wasi.start(instance)).toBe(0);
  const calls = checkedExports(instance.exports);
  const view = new DataView(calls.memory.buffer);
  function path(text: string, ptr = 256) {
    const bytes = encoder.encode(text);
    new Uint8Array(calls.memory.buffer).set(bytes, ptr);
    return bytes.length;
  }
  function open(text: string, fd = 3, flags = 0) {
    const result = calls.path_open(fd, 0, 256, path(text), flags, (1n << 29n) - 1n, (1n << 29n) - 1n, 0, 1024);
    return { result, fd: view.getUint32(1024, true) };
  }
  return { fs, calls, view, path, open };
}
