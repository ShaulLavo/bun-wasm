import { strict as assert } from "node:assert";

type Wasi = {
  wasiImport: Record<string, WebAssembly.ImportValue>;
  view?: DataView;
  start(instance: WebAssembly.Instance): void;
  setMemory(memory: WebAssembly.Memory): void;
};

function isWasi(value: unknown): value is Wasi {
  if (value === null || typeof value !== "object") return false;
  if (!("start" in value) || typeof value.start !== "function") return false;
  if (!("setMemory" in value) || typeof value.setMemory !== "function") return false;
  if ("view" in value && value.view !== undefined && !(value.view instanceof DataView)) return false;
  if (!("wasiImport" in value) || value.wasiImport === null || typeof value.wasiImport !== "object") return false;
  return Object.values(value.wasiImport).every(entry => typeof entry === "function");
}

function wasi(constructor: unknown): Wasi {
  assert.equal(typeof constructor, "function");
  if (typeof constructor !== "function") throw new Error("Missing WASI constructor");
  const api: unknown = Reflect.construct(constructor, [{ preopens: {} }]);
  assert.ok(isWasi(api));
  return api;
}

function text(value: string) { return [value.length].concat(Array.from(Buffer.from(value))); }
function section(id: number, bytes: number[]) { return [id, bytes.length].concat(bytes); }
function body(code: number[]) { return [code.length + 2, 0].concat(code, [0x0b]); }

function moduleBytes(shared: boolean) {
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [3, 0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    section(2, [2].concat(text("wasi_snapshot_preview1"), text("clock_time_get"), [0, 0],
      text("env"), text("memory"), [2, shared ? 3 : 1, 1, 4])),
    section(3, [3, 1, 1, 2]),
    section(7, [4].concat(text("memory"), [2, 0], text("clock"), [0, 1], text("growClock"), [0, 2], text("_start"), [0, 3])),
    section(10, [3].concat(
      body([0x41, 1, 0x42, 0, 0x20, 0, 0x10, 0]),
      body([0x41, 1, 0x40, 0, 0x1a, 0x20, 0, 0x10, 1]),
      body([]))),
  ));
}

function guest(constructor: unknown, memory: WebAssembly.Memory, shared: boolean) {
  const api = wasi(constructor);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(shared)), {
    wasi_snapshot_preview1: api.wasiImport, env: { memory },
  });
  api.start(instance);
  const { clock, growClock } = instance.exports;
  assert.ok(typeof clock === "function" && typeof growClock === "function");
  return { api, clock, growClock };
}

function written(memory: WebAssembly.Memory, ptr: number) {
  return new DataView(memory.buffer).getBigUint64(ptr, true) !== 0n;
}

export function checkMemoryGrowth(constructor: unknown, memory: WebAssembly.Memory, shared: boolean) {
  const { api, clock, growClock } = guest(constructor, memory, shared);
  const first = memory.buffer;
  assert.equal(first.byteLength, 65536);
  assert.equal(clock(8), 0);
  assert.ok(written(memory, 8));
  const view = api.view;
  assert.equal(clock(16), 0);
  assert.equal(api.view, view);
  assert.equal(memory.buffer, first);
  assert.equal(growClock(65544), 0);
  const current = memory.buffer;
  assert.notEqual(current, first);
  assert.equal(first.byteLength, shared ? 65536 : 0);
  assert.equal(current.byteLength, 131072);
  assert.equal(api.view?.buffer, current);
  assert.ok(written(memory, 65544));
  assert.equal(clock(24), 0);
  assert.ok(written(memory, 24));
  console.log(`PASS WASI ${shared ? "shared" : "unshared"} memory growth`);
}

export function checkMemoryRebinding(constructor: unknown) {
  const previous = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const { api, clock } = guest(constructor, previous, false);
  assert.equal(clock(8), 0);
  const next = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  api.setMemory(next);
  assert.equal(clock(65544), 0);
  assert.ok(written(next, 65544));
  assert.equal(clock(16), 0);
  assert.ok(written(next, 16));
  assert.equal(written(previous, 16), false);
  assert.equal(api.view?.buffer, next.buffer);
  console.log("PASS WASI memory rebinding");
}
