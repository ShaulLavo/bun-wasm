import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext, runInThisContext } from "node:vm";

const host = globalThis.WebAssembly;
const factory = runInThisContext(stripTypeScriptTypes(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/webassembly.ts", import.meta.url), "utf8")));
const encodeName = (name: string) => [name.length].concat(Array.from(new TextEncoder().encode(name)));
const section = (id: number, data: number[]) => [id, data.length].concat(data);
const exportEntry = (name: string, kind: number, index: number) => encodeName(name).concat([kind, index]);
const fixture = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
  section(1, [3, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 1, 0x7f, 1, 0x7f]),
  section(2, [1].concat(encodeName("env"), encodeName("memory"), [2, 1, 1, 3])),
  section(3, [3, 0, 1, 2]),
  section(7, [5].concat(exportEntry("memory", 2, 0), exportEntry("alias", 2, 0), exportEntry("read", 0, 0), exportEntry("write", 0, 1), exportEntry("grow", 0, 2))),
  section(10, [3, 7, 0, 0x41, 0, 0x2d, 0, 0, 0x0b, 9, 0, 0x41, 0, 0x20, 0, 0x3a, 0, 0, 0x0b, 6, 0, 0x20, 0, 0x40, 0, 0x0b]),
));
const initialization = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
  section(2, [1].concat(encodeName("env"), encodeName("memory"), [2, 1, 1, 3])),
  section(11, [1, 0, 0x41, 1, 0x0b, 1, 99]),
));

type Resource = { memory: WebAssembly.Memory; buffer: ArrayBuffer; generation: bigint };
function sourceApi() {
  const modules: WebAssembly.Module[] = [];
  const instances: WebAssembly.Instance[] = [];
  const resources: Resource[] = [];
  let allocations = 0;
  const callables: Function[] = [];
  const descriptions: { id: number; params: string[]; results: string[] }[] = [];
  function resource(id: number) {
    const value = resources[id];
    assert.ok(value);
    return value;
  }
  function intern(memory: WebAssembly.Memory) {
    const id = resources.findIndex(value => value.memory === memory);
    if (id !== -1) return id;
    resources.push({ memory, buffer: memory.buffer, generation: 0n });
    return resources.length - 1;
  }
  function exported(id: number, name: string) {
    const value = instances[id]?.exports[name];
    assert.ok(value instanceof host.Memory);
    return value;
  }
  function observe(value: Resource) {
    if (value.buffer === value.memory.buffer) return;
    value.buffer = value.memory.buffer;
    value.generation++;
  }
  const native = {
    compile(bytes: Uint8Array<ArrayBuffer>) {
      const module = new host.Module(bytes);
      modules.push(module);
      return { id: modules.length - 1, imports: host.Module.imports(module), exports: host.Module.exports(module).map(entry => ({
        ...entry, params: entry.name === "read" ? [] : ["i32"], results: entry.name === "write" ? [] : ["i32"],
      })) };
    },
    validate(bytes: Uint8Array<ArrayBuffer>) { return host.validate(bytes); },
    createMemory(initial: number, maximum?: number) {
      allocations++;
      return intern(new host.Memory({ initial, maximum }));
    },
    readMemory(id: number) {
      const value = resource(id);
      observe(value);
      return { bytes: new Uint8Array(value.memory.buffer).slice(), generation: value.generation };
    },
    writeMemory(id: number, bytes: Uint8Array) { new Uint8Array(resource(id).memory.buffer).set(bytes); },
    growMemory(id: number, delta: number) {
      const value = resource(id);
      const old = value.memory.grow(delta);
      observe(value);
      return old;
    },
    instantiate(id: number, bindings: number[]) {
      const module = modules[id];
      assert.ok(module);
      const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
      host.Module.imports(module).forEach((entry, index) => {
        (imports[entry.module] ??= {})[entry.name] = resource(bindings[index]!).memory;
      });
      instances.push(new host.Instance(module, imports));
      return instances.length - 1;
    },
    memoryIdentity(id: number, name: string) { return intern(exported(id, name)); },
    functionIdentity(id: number, name: string) {
      const fn = instances[id]?.exports[name];
      assert.equal(typeof fn, "function");
      if (typeof fn !== "function") throw new Error("Expected exported function");
      const prior = callables.indexOf(fn);
      if (prior !== -1) return descriptions[prior];
      const info = { id: callables.length, params: name === "read" ? [] : ["i32"], results: name === "write" ? [] : ["i32"] };
      callables.push(fn);
      descriptions.push(info);
      return info;
    },
    functionInfo(id: number) {
      const info = descriptions[id];
      assert.ok(info);
      return info;
    },
    call(id: number, args: number[]) {
      const fn = callables[id];
      assert.ok(fn);
      const value: unknown = fn(...args);
      return { values: value === undefined ? [] : [value] };
    },
  };
  const api: typeof WebAssembly = factory({ native: { wasm: native } });
  return { api, allocations: () => allocations };
}

function memoryBytes(memory: WebAssembly.Memory) { return new Uint8Array(memory.buffer); }
function functions(instance: WebAssembly.Instance) {
  const { read, write, grow } = instance.exports;
  assert.equal(typeof read, "function");
  assert.equal(typeof write, "function");
  assert.equal(typeof grow, "function");
  if (typeof read !== "function" || typeof write !== "function" || typeof grow !== "function") throw new Error("Expected functions");
  return { read, write, grow };
}

for (const backend of ["host", "source"]) {
  test(`${backend}: standalone grow preserves bytes, detaches at zero, and failure preserves buffer`, () => {
    const api = backend === "host" ? host : sourceApi().api;
    const memory = new api.Memory({ initial: 1, maximum: 2 });
    const first = memory.buffer;
    memoryBytes(memory)[0] = 42;
    assert.equal(memory.grow(0), 1);
    assert.equal(first.byteLength, 0);
    assert.equal(memoryBytes(memory)[0], 42);
    const second = memory.buffer;
    assert.equal(memory.grow(1), 1);
    assert.equal(second.byteLength, 0);
    assert.equal(memoryBytes(memory)[0], 42);
    assert.equal(memoryBytes(memory)[65_536], 0);
    const current = memory.buffer;
    assert.throws(() => memory.grow(1), RangeError);
    assert.equal(memory.buffer, current);
    assert.equal(current.byteLength, 131_072);
  });

  test(`${backend}: imported memory aliases across instances without overwriting JS or guest writes`, () => {
    const api = backend === "host" ? host : sourceApi().api;
    const memory = new api.Memory({ initial: 1, maximum: 3 });
    memoryBytes(memory)[0] = 41;
    const module = new api.Module(fixture);
    const first = new api.Instance(module, { env: { memory } });
    const second = new api.Instance(module, { env: { memory } });
    assert.equal(first.exports.memory, memory);
    assert.equal(first.exports.alias, memory);
    assert.equal(second.exports.memory, memory);
    const a = functions(first), b = functions(second);
    assert.equal(a.read(), 41);
    b.write(42);
    assert.equal(memoryBytes(memory)[0], 42);
    memoryBytes(memory)[0] = 43;
    assert.equal(a.read(), 43);
    const previous = memory.buffer;
    assert.equal(b.grow(1), 1);
    assert.equal(previous.byteLength, 0);
    assert.equal(memory.buffer.byteLength, 131_072);
    assert.equal(a.read(), 43);
    new api.Instance(new api.Module(initialization), { env: { memory } });
    assert.equal(memoryBytes(memory)[0], 43);
    assert.equal(memoryBytes(memory)[1], 99);
    assert.throws(() => new api.Instance(module, { env: { memory: 0 } }), api.LinkError);
    assert.throws(() => new api.Instance(module, { env: { memory: new api.Memory({ initial: 0, maximum: 3 }) } }), api.LinkError);
    assert.throws(() => new api.Instance(module, { env: { memory: new api.Memory({ initial: 1, maximum: 4 }) } }), api.LinkError);
  });
}

test("source: invalid descriptors fail before native allocation with host error classes", () => {
  const { api, allocations } = sourceApi();
  const invalid: { descriptor: unknown; error: ErrorConstructor }[] = [
    { descriptor: undefined, error: TypeError }, { descriptor: null, error: TypeError },
    { descriptor: {}, error: TypeError }, { descriptor: { initial: NaN }, error: TypeError },
    { descriptor: { initial: -.5 }, error: TypeError }, { descriptor: { initial: Infinity }, error: TypeError },
    { descriptor: { initial: 65537 }, error: RangeError },
    { descriptor: { initial: 0, maximum: 65537 }, error: RangeError },
    { descriptor: { initial: 2, maximum: 1 }, error: RangeError },
  ];
  for (const { descriptor, error } of invalid) {
    assert.throws(() => Reflect.construct(api.Memory, [descriptor]), error);
  }
  assert.equal(allocations(), 0);
  let maximumReads = 0;
  const descriptor = { initial: 0, get maximum() { maximumReads++; return 1; } };
  const memory = new api.Memory(descriptor);
  assert.equal(maximumReads, 1);
  assert.throws(() => Reflect.apply(api.Memory.prototype.grow, {}, [0]), TypeError);
  for (const delta of [undefined, NaN, -.5, Infinity, 4294967296]) {
    assert.throws(() => Reflect.apply(memory.grow, memory, [delta]), TypeError);
  }
  assert.throws(() => new api.Memory({ initial: 1, maximum: 2, shared: true }), /Shared WebAssembly memories are not supported/);
  assert.equal(allocations(), 1);
});

test("source: resource identity registry does not retain an unreachable Memory wrapper", async context => {
  const gc: unknown = Reflect.get(globalThis, "gc");
  if (typeof gc !== "function") { context.skip("run Node with --expose-gc"); return; }
  const { api } = sourceApi();
  let memory: WebAssembly.Memory | undefined = new api.Memory({ initial: 0 });
  const reference = new WeakRef(memory);
  memory = undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    gc();
    if (reference.deref() === undefined) break;
  }
  assert.equal(reference.deref(), undefined);
});


test("source: BufferSource views retain offsets, snapshots, and current-main realm rules", () => {
  const { api } = sourceApi();
  const backing = new Uint8Array(fixture.length + 8);
  backing.set(fixture, 4);
  const view = new Uint8Array(backing.buffer, 4, fixture.length);
  const data = new DataView(backing.buffer, 4, fixture.length);
  assert.equal(api.validate(view), true);
  assert.equal(api.validate(data), true);
  const module = new api.Module(view);
  view.fill(0);
  assert.deepEqual(api.Module.exports(module), host.Module.exports(new host.Module(fixture)));
  assert.equal(api.validate(view), false);
  assert.equal(api.validate(fixture.buffer), true);
  assert.throws(() => Reflect.construct(api.Module, [Array.from(fixture)]), TypeError);
  const foreignView = runInNewContext("new Uint8Array(bytes)", { bytes: Array.from(fixture) });
  const foreignBuffer = Reflect.get(foreignView, "buffer");
  assert.equal(api.validate(foreignView), true);
  assert.throws(() => Reflect.construct(api.Module, [foreignBuffer]), TypeError);
  assert.equal(backing.byteLength, fixture.length + 8);
});


for (const backend of ["host", "source"]) {
  test(`${backend}: reject invalid initial before accessing maximum`, () => {
    const source = sourceApi();
    const api = backend === "host" ? host : source.api;
    const reads: string[] = [];
    const sentinel = new Error("maximum getter must not run");
    const descriptor = {
      get initial() { reads.push("initial"); return 65_537; },
      get maximum(): number { reads.push("maximum"); throw sentinel; },
    };
    assert.throws(() => new api.Memory(descriptor), RangeError);
    assert.deepEqual(reads, ["initial"]);
    assert.equal(source.allocations(), 0);
  });

  test(`${backend}: preserve an initial getter throw without reading maximum`, () => {
    const source = sourceApi();
    const api = backend === "host" ? host : source.api;
    const reads: string[] = [];
    const sentinel = new Error("initial getter failed");
    const descriptor = {
      get initial(): number { reads.push("initial"); throw sentinel; },
      get maximum() { reads.push("maximum"); return 1; },
    };
    assert.throws(() => new api.Memory(descriptor), error => error === sentinel);
    assert.deepEqual(reads, ["initial"]);
    assert.equal(source.allocations(), 0);
  });

  test(`${backend}: preserve a maximum getter throw after a valid initial`, () => {
    const source = sourceApi();
    const api = backend === "host" ? host : source.api;
    const reads: string[] = [];
    const sentinel = new Error("maximum getter failed");
    const descriptor = {
      get initial() { reads.push("initial"); return 0; },
      get maximum(): number { reads.push("maximum"); throw sentinel; },
      get shared() { reads.push("shared"); return false; },
    };
    assert.throws(() => new api.Memory(descriptor), error => error === sentinel);
    assert.deepEqual(reads, ["initial", "maximum"]);
    assert.equal(source.allocations(), 0);
  });
}
