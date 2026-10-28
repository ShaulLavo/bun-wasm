import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tty from "node:tty";
import dns from "node:dns";
import { runInThisContext } from "node:vm";

const root = process.env.WASI_SOURCE_ROOT ?? process.cwd();
const directory = path.join(root, "crates/bunwasm-runtime/generated/builtins");
const evaluated: number[] = [];
let fsConstantReads = 0;
type Row = Record<string, unknown>;

function record(value: unknown): Row {
  assert.ok(value !== null && typeof value === "object");
  return value as Row;
}
function callable(value: unknown): (...args: unknown[]) => unknown {
  assert.ok(typeof value === "function");
  return value as (...args: unknown[]) => unknown;
}
function factory(name: string, types = false) {
  const source = name === "builtins.js" && process.env.WASI_REGISTRATION_SOURCE
    ? process.env.WASI_REGISTRATION_SOURCE : path.join(root, `crates/bunwasm-runtime/src/js/${name}`);
  const text = fs.readFileSync(source, "utf8");
  const emitted = types ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${text}`) : text;
  return callable(runInThisContext(emitted));
}
const globals = factory("bun_builtin_globals.ts", true)();
let builtins: Row;
let loader: Row;
const native = {
  bunBuiltinNames() {
    const catalog = record(JSON.parse(fs.readFileSync(path.join(directory, "catalog.json"), "utf8")));
    assert.ok(Array.isArray(catalog.modules));
    return catalog.modules.map((entry: unknown) => {
      const name = record(entry).name;
      assert.ok(typeof name === "string");
      return name;
    });
  },
  bunBuiltinSource(id: number) {
    const source = path.join(directory, `${id}.js`);
    if (!fs.existsSync(source)) return undefined;
    evaluated.push(id);
    return fs.readFileSync(source, "utf8");
  },
  evalScript(source: string) { return runInThisContext(source); },
};
function builtin(name: string): unknown {
  if (name === "node:fs") return fs;
  if (name === "node:path") return path;
  if (name === "node:tty") return tty;
  return callable(builtins[name])();
}
function requireInternal(name: string): unknown {
  if (name === "dns") return dns;
  if (name === "bun_builtins") return loader;
  if (name === "node_fs") { fsConstantReads++; return { fs }; }
  throw new Error(`Unexpected internal module ${name}`);
}
const internal = { native, bunBuiltinGlobals: globals, builtin, require: requireInternal, builtinFactories: {} };
builtins = record(factory("builtins.js")(internal));
loader = record(factory("bun_builtins.ts", true)(internal));
assert.equal(fsConstantReads, 0);
const { WASI } = record(builtin("node:wasi"));
assert.ok(typeof WASI === "function");
assert.equal(fsConstantReads, 1);
assert.equal(record(builtin("node:wasi")).WASI, WASI);
assert.equal(fsConstantReads, 1);

type Wasi = {
  wasiImport: Record<string, WebAssembly.ImportValue>;
  FD_MAP: Map<number, { real: number }>;
  start(instance: WebAssembly.Instance): void;
  initialize(instance: WebAssembly.Instance): void;
};
function isWasi(value: unknown): value is Wasi {
  const candidate = record(value);
  if (!(candidate.FD_MAP instanceof Map) || typeof candidate.start !== "function") return false;
  if (typeof candidate.initialize !== "function") return false;
  const imports = record(candidate.wasiImport);
  const entries: [unknown, unknown][] = Array.from(candidate.FD_MAP);
  return Object.values(imports).every(value => typeof value === "function")
    && entries.every(([key, entry]) => typeof key === "number" && typeof record(entry).real === "number");
}
function wasi(options: object): Wasi {
  const instance: unknown = Reflect.construct(callable(WASI), [options]);
  assert.ok(isWasi(instance));
  return instance;
}

type Parameter = "i32" | "i64";
const signatures: { name: string; params: Parameter[] }[] = [
  { name: "args_sizes_get", params: ["i32", "i32"] },
  { name: "args_get", params: ["i32", "i32"] },
  { name: "environ_sizes_get", params: ["i32", "i32"] },
  { name: "environ_get", params: ["i32", "i32"] },
  { name: "random_get", params: ["i32", "i32"] },
  { name: "fd_write", params: ["i32", "i32", "i32", "i32"] },
  { name: "fd_read", params: ["i32", "i32", "i32", "i32"] },
  { name: "fd_close", params: ["i32"] },
  { name: "path_open", params: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] },
];
function u32(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 127;
    remaining >>>= 7;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}
function text(value: string) {
  const bytes = Array.from(Buffer.from(value));
  return u32(bytes.length).concat(bytes);
}
function section(id: number, bytes: number[]) { return [id].concat(u32(bytes.length), bytes); }
function moduleBytes() {
  const types = signatures.flatMap(({ params }) => [0x60].concat(u32(params.length), params.map(type => type === "i64" ? 0x7e : 0x7f), [1, 0x7f]));
  const imports = signatures.flatMap(({ name }, index) => text("wasi_snapshot_preview1").concat(text(name), [0], u32(index)));
  const exports = text("memory").concat([2, 0], signatures.flatMap(({ name }, index) => text(name).concat([0], u32(signatures.length + index))));
  const bodies = signatures.flatMap(({ params }, index) => {
    const body = [0].concat(params.flatMap((_param, position) => [0x20].concat(u32(position))), [0x10], u32(index), [0x0b]);
    return u32(body.length).concat(body);
  });
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, u32(signatures.length).concat(types)),
    section(2, u32(signatures.length).concat(imports)),
    section(3, u32(signatures.length).concat(signatures.flatMap((_entry, index) => u32(index)))),
    section(5, [1, 0, 1]),
    section(7, u32(signatures.length + 1).concat(exports)),
    section(10, u32(signatures.length).concat(bodies)),
  ));
}
const module = new WebAssembly.Module(moduleBytes());
function reactorModule() {
  const body = [0, 0x41, 0, 0x41, 4, 0x10, 0, 0x1a, 0x0b];
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    section(2, [1].concat(text("wasi_snapshot_preview1"), text("args_sizes_get"), [0, 0])),
    section(3, [1, 1]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_initialize"), [0, 1])),
    section(10, [1].concat(u32(body.length), body)),
  )));
}
function checkReactor() {
  const api = wasi({ args: ["reactor", "é"], preopens: {} });
  const instance = new WebAssembly.Instance(reactorModule(), { wasi_snapshot_preview1: api.wasiImport });
  const memory = instance.exports.memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  const view = new DataView(memory.buffer);
  assert.equal(view.getUint32(0, true), 0);
  assert.equal(api.initialize(instance), undefined);
  assert.equal(view.getUint32(0, true), 2);
  assert.equal(view.getUint32(4, true), 11);
  assert.throws(() => api.initialize(instance), { code: "ERR_WASI_ALREADY_STARTED" });
  assert.throws(() => api.start(instance), { code: "ERR_WASI_ALREADY_STARTED" });
  const started = wasi({ preopens: {} });
  started.start(new WebAssembly.Instance(module, { wasi_snapshot_preview1: started.wasiImport }));
  assert.throws(() => started.initialize(instance), { code: "ERR_WASI_ALREADY_STARTED" });
  const withoutInitializer = wasi({ preopens: {} });
  withoutInitializer.initialize(new WebAssembly.Instance(module, { wasi_snapshot_preview1: withoutInitializer.wasiImport }));
  const invalid = (exports: unknown) => () => {
    const api = wasi({ preopens: {} });
    Reflect.apply(api.initialize, api, [{ exports }]);
  };
  assert.throws(invalid({ memory, _start() { throw new Error("must not run command"); } }), TypeError);
  assert.throws(invalid({ memory, _initialize: 1 }), TypeError);
  assert.throws(invalid({}), /memory/);
  assert.throws(invalid(null), /exports/);
  const throwing = wasi({ preopens: {} });
  const failure = new Error("reactor failure");
  const throwingInstance = { exports: { memory, _initialize() { throw failure; } } };
  assert.throws(() => Reflect.apply(throwing.initialize, throwing, [throwingInstance]), failure);
  assert.throws(() => Reflect.apply(throwing.initialize, throwing, [throwingInstance]), { code: "ERR_WASI_ALREADY_STARTED" });
  console.log("PASS Bun WASI reactor initialization: actual import, optional initializer, validation, one lifecycle");
}
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-wasi-host-"));
const handles: Wasi[] = [];
function closeWasi(api: Wasi) {
  for (const { real } of api.FD_MAP.values()) {
    if (real > 2) fs.closeSync(real);
  }
}
try {
  checkReactor();
  const api = wasi({ args: ["runner", "é"], env: { TEST: "✓" }, preopens: { "/sandbox": scratch } });
  handles.push(api);
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: api.wasiImport });
  api.start(instance);
  const memory = instance.exports.memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  function invoke(name: string, ...args: (number | bigint)[]) { return callable(instance.exports[name])(...args); }
  assert.equal(invoke("args_sizes_get", 0, 4), 0);
  assert.equal(view.getUint32(0, true), 2);
  assert.equal(view.getUint32(4, true), 10);
  assert.equal(invoke("args_get", 8, 32), 0);
  assert.equal(Buffer.from(bytes.subarray(32, 42)).toString(), "runner\0é\0");
  assert.equal(invoke("environ_sizes_get", 0, 4), 0);
  assert.equal(view.getUint32(0, true), 1);
  assert.equal(view.getUint32(4, true), 9);
  assert.equal(invoke("environ_get", 8, 32), 0);
  assert.equal(Buffer.from(bytes.subarray(32, 41)).toString(), "TEST=✓\0");
  assert.equal(invoke("random_get", 128, 32), 0);
  assert.ok(bytes.subarray(128, 160).some(byte => byte !== 0));
  fs.writeFileSync(path.join(scratch, "value.txt"), "before");
  bytes.set(Buffer.from("value.txt"), 256);
  assert.equal(invoke("path_open", 3, 0, 256, 9, 0, 66n, 0n, 0, 64), 0);
  const output = view.getUint32(64, true);
  bytes.set(Buffer.from("native"), 512);
  view.setUint32(128, 512, true);
  view.setUint32(132, 6, true);
  assert.equal(invoke("fd_write", output, 128, 1, 96), 0);
  assert.equal(view.getUint32(96, true), 6);
  assert.equal(invoke("fd_close", output), 0);
  assert.equal(fs.readFileSync(path.join(scratch, "value.txt"), "utf8"), "native");
  assert.equal(invoke("path_open", 3, 0, 256, 9, 0, 2n, 0n, 0, 64), 0);
  const input = view.getUint32(64, true);
  bytes.fill(0, 512, 518);
  assert.equal(invoke("fd_read", input, 128, 1, 96), 0);
  assert.equal(view.getUint32(96, true), 6);
  assert.equal(Buffer.from(bytes.subarray(512, 518)).toString(), "native");
  assert.equal(invoke("fd_close", input), 0);
  assert.equal(invoke("fd_read", input, 128, 1, 96), 8);
  assert.equal(invoke("fd_close", 3), 0);
  assert.deepEqual(evaluated, [188]);
  console.log("PASS Bun WASI through real host WebAssembly: args, UTF-8 env, random, preopen, path_open, fd_write/read/close, EBADF; generated modules=[188]");
} finally {
  handles.forEach(closeWasi);
  fs.rmSync(scratch, { recursive: true, force: true });
}
