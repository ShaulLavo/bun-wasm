import { expect, test } from "bun:test";
import { MemFS } from "../src/fs";
import { Wasi } from "../src/wasi";

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
  fd_renumber: "ii",
  fd_filestat_get: "ii",
  fd_seek: "ijii",
  fd_tell: "ii",
  fd_close: "i",
  fd_read: "iiii",
  fd_write: "iiii",
  fd_pwrite: "iiiji",
};

function uleb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

const name = (value) => uleb(value.length).concat(Array.from(encoder.encode(value)));
const vector = (items) => uleb(items.length).concat(items.flat());
const section = (id, bytes) => [id].concat(uleb(bytes.length), bytes);

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

const module = syscallModule();
function host(preopens = { "/allowed": "/allowed" }, options = {}) {
  const fs = new MemFS();
  fs.writeFile("/allowed/inside", "inside");
  fs.mkdirp("/allowed/sub");
  fs.writeFile("/outside", "outside");
  fs.mkdirp("/outside-dir");
  fs.writeFile("/allowed-sibling/secret", "secret");
  const wasi = new Wasi({ args: [], env: {}, fs, preopens, stdout() {}, stderr() {}, sleep() {}, ...options });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  expect(wasi.start(instance)).toBe(0);
  const calls = instance.exports;
  const view = new DataView(calls.memory.buffer);
  function path(text, ptr = 256) {
    const bytes = encoder.encode(text);
    new Uint8Array(calls.memory.buffer).set(bytes, ptr);
    return bytes.length;
  }
  function open(text, fd = 3, flags = 0) {
    const result = calls.path_open(fd, 0, 256, path(text), flags, (1n << 29n) - 1n, (1n << 29n) - 1n, 0, 1024);
    return { result, fd: view.getUint32(1024, true) };
  }
  return { fs, calls, view, path, open };
}

const pathCalls = {
  path_open: (h, len) => h.calls.path_open(3, 0, 256, len, 9, 0n, 0n, 0, 1024),
  path_filestat_get: (h, len) => h.calls.path_filestat_get(3, 0, 256, len, 1024),
  path_filestat_set_times: (h, len) => h.calls.path_filestat_set_times(3, 0, 256, len, 0n, 123n, 4),
  path_create_directory: (h, len) => h.calls.path_create_directory(3, 256, len),
  path_remove_directory: (h, len) => h.calls.path_remove_directory(3, 256, len),
  path_unlink_file: (h, len) => h.calls.path_unlink_file(3, 256, len),
  path_readlink: (h, len) => h.calls.path_readlink(3, 256, len, 1024, 32, 1088),
  path_rename_source: (h, len) => h.calls.path_rename(3, 256, len, 3, 512, h.path("inside", 512)),
  path_rename_target: (h, len) => h.calls.path_rename(3, 512, h.path("inside", 512), 3, 256, len),
  path_link_source: (h, len) => h.calls.path_link(3, 0, 256, len, 3, 512, h.path("linked", 512)),
  path_link_target: (h, len) => h.calls.path_link(3, 0, 512, h.path("inside", 512), 3, 256, len),
};

for (const [call, invoke] of Object.entries(pathCalls)) {
  for (const path of ["../outside", "../outside-dir", "/outside", "/allowed/inside", "../allowed/inside", "sub/../../outside", "../../outside", "../allowed-sibling/secret"]) {
    test(`${call} confines ${path} to the directory fd`, () => {
      const h = host();
      const before = structuredClone(h.fs.root);
      h.view.setUint32(1024, 0xfeedface, true);
      expect(invoke(h, h.path(path))).toBe(63);
      expect(h.fs.root).toEqual(before);
      expect(h.view.getUint32(1024, true)).toBe(0xfeedface);
    });
  }
}

test("relative dot segments stay usable inside a directory capability", () => {
  const h = host();
  expect(h.open("sub/.././inside").result).toBe(0);
  expect(h.open("sub//../inside").result).toBe(0);
  expect(h.open(".", 3, 2).result).toBe(0);
});

test("opened subdirectories cannot climb back to the preopen", () => {
  const h = host();
  const sub = h.open("sub", 3, 2);
  expect(sub.result).toBe(0);
  expect(h.open("../inside", sub.fd).result).toBe(63);
  expect(h.open("../sub", sub.fd, 2).result).toBe(63);
});

test("the root preopen rejects absolute paths and parent traversal", () => {
  const h = host({ "/": "/" });
  expect(h.open("allowed/inside").result).toBe(0);
  expect(h.open("/allowed/inside").result).toBe(63);
  expect(h.open("../allowed/inside").result).toBe(63);
});

test("invalid and nondirectory fds keep their errors for path calls", () => {
  const h = host();
  expect(h.open("../outside", 99).result).toBe(8);
  expect(h.open("/outside", 1).result).toBe(54);
});

test("unsupported symlinks cannot introduce an escape", () => {
  const h = host();
  expect(h.calls.path_symlink(256, h.path("../outside"), 3, 512, h.path("link", 512))).toBe(58);
  expect(h.fs.lookup("/allowed/link")).toBeUndefined();
});

for (const fd of [0, 1, 2, 3]) {
  test(`fd_renumber(${fd}, ${fd}) preserves the descriptor`, () => {
    const h = host();
    expect(h.calls.fd_renumber(fd, fd)).toBe(0);
    expect(h.calls.fd_filestat_get(fd, 1024)).toBe(0);
  });
}

test("self-renumber preserves an open file's cursor", () => {
  const h = host();
  const file = h.open("inside");
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 2n, 0, 1024)).toBe(0);
  expect(h.calls.fd_renumber(file.fd, file.fd)).toBe(0);
  expect(h.calls.fd_tell(file.fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(2n);
  expect(h.calls.fd_close(file.fd)).toBe(0);
  expect(h.calls.fd_renumber(file.fd, file.fd)).toBe(8);
  expect(h.calls.fd_renumber(99, 99)).toBe(8);
});

test("renumbering distinct descriptors still replaces the target", () => {
  const h = host();
  expect(h.calls.fd_renumber(1, 2)).toBe(0);
  expect(h.calls.fd_filestat_get(1, 1024)).toBe(8);
  expect(h.calls.fd_filestat_get(2, 1024)).toBe(0);
});

test("zero-length writes past EOF do not extend a file or change its cursor", () => {
  const h = host();
  const file = h.open("inside");
  expect(file.result).toBe(0);
  expect(h.calls.fd_seek(file.fd, 100n, 0, 1024)).toBe(0);
  const before = structuredClone(h.fs.root);
  h.view.setUint32(128, 256, true);
  h.view.setUint32(132, 0, true);
  expect(h.calls.fd_write(file.fd, 128, 1, 1024)).toBe(0);
  expect(h.view.getUint32(1024, true)).toBe(0);
  expect(h.fs.root).toEqual(before);
  expect(h.calls.fd_tell(file.fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(100n);
  expect(h.calls.fd_pwrite(file.fd, 128, 1, 200n, 1024)).toBe(0);
  expect(h.fs.root).toEqual(before);
});

test("zero-length stdin reads do not call a blocking source", () => {
  const h = host(undefined, { stdin() { throw new Error("zero-byte read reached stdin"); } });
  h.view.setUint32(128, 256, true);
  h.view.setUint32(132, 0, true);
  expect(h.calls.fd_read(0, 128, 1, 1024)).toBe(0);
  expect(h.view.getUint32(1024, true)).toBe(0);
  expect(h.calls.fd_read(0, 128, 0, 1024)).toBe(0);
});
