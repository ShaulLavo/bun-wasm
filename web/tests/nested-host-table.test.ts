// Exported funcref tables through the real NestedHost and Waffle's real group owner, on modules
// assembled from nested-table.wat and nested-table-peer.wat.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { section, unsigned, utf8Name } from "../src/nested/binary";
import { readModuleInfo } from "../src/nested/module-info";
import { BACKEND, BAD_FRAME, MAX_RESOURCES, PENDING_EXCEPTION, type Binding, type Reply, type WasmNumber } from "../src/nested/wire";
import { count, counters, errorText, group, handle, type Member, type ReplyOf } from "./nested-host-owner";

function load(path: string) { return new Uint8Array(readFileSync(`${import.meta.dir}/${path}.wasm`)); }
const tableModule = load("nested-table"), peerModule = load("nested-table-peer");
const fixtures = "../../tests/fixtures/shared-wasm-memory";
const RANGE = { category: "RangeError", message: "WebAssembly table index or size out of range" };
const BINARY = { params: ["i32", "i32"], results: ["i32"] };

function compile(member: Member, bytes: Uint8Array): Reply {
  const [, , pointer] = member.raw(GroupOp.CREATE, bytes.length, 16);
  new Uint8Array(member.owner.handle.buffer(), pointer!, bytes.length).set(bytes);
  return member.send({ Compile: { pointer: pointer!, length: bytes.length } });
}
function instantiate(member: Member, module: number, bindings: Binding[]): number {
  const memory = handle(member.send({ Reserve: { initial: 1, maximum: 1 } }));
  return handle(member.send({ Instantiate: { module, memory, bindings, invocation: 1 } }));
}
function callback(name: string, id: number): Binding { return { Callback: { module: "env", name, id } }; }
const FIRST = 11, CALLBACK = 12;

interface Nested { readonly member: Member; readonly module: number; readonly instance: number; readonly table: number; }
function start(member: Member = group().join()): Nested {
  const module = handle(compile(member, tableModule));
  const instance = instantiate(member, module, [callback("first", FIRST), callback("callback", CALLBACK)]);
  return { member, module, instance, table: tableOf(member, instance, "table") };
}
function tableOf(member: Member, instance: number, name: string) { return handle(member.send({ TableExport: { instance, name } })); }
function exported(member: Member, instance: number, name: string) { return (member.send({ Function: { instance, name } }) as ReplyOf<"Function">).Function; }
function entry({ member, table }: Nested, index: number) { return member.send({ TableGet: { table, index } }); }
function entryFunction(nested: Nested, index: number) { return (entry(nested, index) as ReplyOf<"Function">).Function; }
function set({ member, table }: Nested, index: number, fn: number | null) { return member.send({ TableSet: { table, index, function: fn } }); }
function grow({ member, table }: Nested, delta: number, fn: number | null) { return member.send({ TableGrow: { table, delta, function: fn } }); }
function length({ member, table }: Nested) { return count(member.send({ TableLength: { table } })); }
function call(member: Member, fn: number, args: WasmNumber[]) { return member.send({ Call: { function: fn, arguments: args, invocation: 7 } }); }
function values(reply: Reply) { return (reply as ReplyOf<"Values">).Values; }
function failure(reply: Reply) { return (reply as ReplyOf<"Error">).Error; }
function i32(value: number): WasmNumber { return { I32: value }; }
function f64(value: number): WasmNumber { return { F64: new BigUint64Array(new Float64Array([value]).buffer)[0]!.toString() }; }
function f64Value(value: WasmNumber) { return new Float64Array(new BigUint64Array([BigInt((value as { F64: string }).F64)]).buffer)[0]; }
/** `call(index, left, right)` runs a real call_indirect in the table's own instance. */
function indirect({ member, instance }: Nested, index: number, left: number, right: number) {
  return call(member, exported(member, instance, "call").id, [i32(index), i32(left), i32(right)]);
}

describe("compiling a module that exports a table", () => {
  test("is admitted, and each exported table's element type is read from its bytes", () => {
    const member = group().join();
    expect(handle(compile(member, tableModule)) >>> 0).toBeGreaterThanOrEqual(BACKEND);
    const { tables } = readModuleInfo(tableModule);
    expect(Array.from(tables)).toEqual([["table", "funcref"], ["__indirect_function_table", "funcref"], ["loose", "funcref"], ["externs", "externref"]]);
    expect(Array.from(readModuleInfo(load(`${fixtures}/table-externref`)).tables)).toEqual([["table", "externref"]]);
  });

});

describe("table identity", () => {
  test("one table is one handle under every export name, and each instance has its own", () => {
    const first = start();
    const { member, module, instance, table } = first;
    expect(table >>> 0).toBeGreaterThanOrEqual(BACKEND);
    expect(tableOf(member, instance, "__indirect_function_table")).toBe(table);
    expect(tableOf(member, instance, "table")).toBe(table);
    expect(tableOf(member, instance, "loose")).not.toBe(table);
    const second = instantiate(member, module, [callback("first", FIRST), callback("callback", CALLBACK)]);
    expect(tableOf(member, second, "table")).not.toBe(table);
    expect(member.host.snapshot()).toMatchObject({ instances: 2, tables: 3 });
  });

  test("refuses a missing table, a function named as one, an externref table and unknown handles", () => {
    const { member, instance, table } = start();
    const refused = (name: string) => errorText(member.send({ TableExport: { instance, name } }));
    expect(refused("absent")).toBe("missing nested table");
    expect(refused("add")).toBe("missing nested table");
    expect(refused("externs")).toBe("unsupported nested table element");
    expect(errorText(member.send({ TableExport: { instance: instance + 1, name: "table" } }))).toBe("invalid instance");
    expect(errorText(member.send({ TableLength: { table: table + 1 } }))).toBe("invalid nested table");
    expect(errorText(member.send({ TableGet: { table: table & ~BACKEND, index: 0 } }))).toBe("mixed-backend WebAssembly resource");
    expect(member.host.snapshot().tables).toBe(1);
  });

  test("a table takes no group region, hold or charge", () => {
    const nested = start();
    const { member, instance } = nested;
    const ledger = () => ({ ...counters(member.owner), committed: member.owner.snapshot().committedBytes });
    const before = ledger();
    const loose: Nested = { ...nested, table: tableOf(member, instance, "loose") };
    expect(count(grow(nested, 2, entryFunction(nested, 1).id))).toBe(7);
    expect(count(grow(loose, 1024, null))).toBe(1);
    expect(count(set(nested, 6, null))).toBe(0);
    expect(ledger()).toEqual(before);
  });

  test("handles are bounded by the resource limit, and a known table still answers at the limit", () => {
    const first = start();
    const { member } = first;
    const module = handle(compile(member, peerModule));
    const memory = handle(member.send({ Reserve: { initial: 1, maximum: 1 } }));
    const bindings: Binding[] = [{ Function: { module: "peer", name: "add", id: exported(member, first.instance, "add").id } }];
    const instances = Array.from({ length: MAX_RESOURCES - 1 }, () => handle(member.send({ Instantiate: { module, memory, bindings, invocation: 1 } })));
    const tables = instances.map(instance => tableOf(member, instance, "table"));
    expect(new Set(tables.concat(first.table)).size).toBe(MAX_RESOURCES);
    expect(member.host.snapshot().tables).toBe(MAX_RESOURCES);
    expect(errorText(member.send({ TableExport: { instance: first.instance, name: "loose" } }))).toBe("nested resource limit");
    expect(tableOf(member, first.instance, "__indirect_function_table")).toBe(first.table);
    expect(count(member.send({ TableLength: { table: tables.at(-1)! } }))).toBe(3);
  });
});

function crowdedTable(): Uint8Array {
  const count = 4100;
  const codes = [0x7f, 0x7e, 0x7d, 0x7c];
  const signatures = Array.from({ length: count }, (_, index) => [0x60, 1, 0x7f, 7].concat(
    Array.from({ length: 7 }, (_, shift) => codes[(index >>> (shift * 2)) & 3]!),
  ));
  const types = unsigned(count + 1).concat(signatures.flat(), [0x60, 1, 0x7c, 1, 0x7c]);
  const imports = [2].concat(utf8Name("env"), utf8Name("first"), [0, 0],
    utf8Name("env"), utf8Name("callback"), [0], unsigned(count));
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
    section(1, types), section(2, imports), section(4, [1, 0x70, 0, 2]),
    section(7, [1].concat(utf8Name("table"), [1, 0])), section(9, [1, 0, 0x41, 0, 0x0b, 2, 1, 0]),
  ));
}

describe("table entries", () => {
  test("signature probes have a bounded cache without refusing a late match or probing known functions", () => {
    const member = group().join();
    const module = handle(compile(member, crowdedTable()));
    const instance = instantiate(member, module, [callback("first", FIRST), callback("callback", CALLBACK)]);
    const nested = { member, module, instance, table: tableOf(member, instance, "table") };
    let calls = 0;
    member.dispatch = () => { calls++; return 0; };
    const first = entry(nested, 0);
    expect(first).toMatchObject({ Function: { params: ["f64"], results: ["f64"] } });
    const cache = Reflect.get(Reflect.get(member.host, "functionTypes"), "importers");
    expect(cache.size).toBeLessThanOrEqual(64);
    // The earliest failed signature can be compiled again after eviction.
    expect(entry(nested, 1)).toMatchObject({ Function: { params: ["i32"], results: Array(7).fill("i32") } });
    expect(cache.size).toBeLessThanOrEqual(64);
    const original = WebAssembly.Instance;
    let probes = 0;
    WebAssembly.Instance = new Proxy(original, { construct(target, args) { probes++; return Reflect.construct(target, args); } });
    try { expect(entry(nested, 0)).toEqual(first); }
    finally { WebAssembly.Instance = original; }
    expect(probes).toBe(0);
    expect(calls).toBe(0);
    expect(member.host.snapshot()).toMatchObject({ modules: 1, instances: 1, tables: 1, functions: 2 });
  });

  test("an entry is the function its export names, and an empty slot is Null", () => {
    const nested = start();
    const add = exported(nested.member, nested.instance, "add");
    expect(add).toMatchObject(BINARY);
    expect(entry(nested, 0)).toEqual({ Function: add });
    expect(entry(nested, 0)).toEqual({ Function: add });
    expect(entry(nested, 6)).toBe("Null");
    expect(length(nested)).toBe(7);
  });

  test("an entry first met in the table keeps one id and is the function its export names", () => {
    const nested = start();
    const first = entryFunction(nested, 0);
    expect(first).toMatchObject(BINARY);
    expect(exported(nested.member, nested.instance, "add")).toEqual(first);
    expect(nested.member.host.snapshot().functions).toBe(1);
  });

  test("an unexported entry has its own exact type and is callable", () => {
    const nested = start();
    const hidden = entryFunction(nested, 1);
    expect(hidden).toMatchObject(BINARY);
    expect(hidden.id).not.toBe(entryFunction(nested, 0).id);
    expect(entryFunction(nested, 1).id).toBe(hidden.id);
    expect(values(call(nested.member, hidden.id, [i32(9), i32(4)]))).toEqual([{ I32: 5 }]);
    const wide = entryFunction(nested, 3);
    expect(wide).toMatchObject({ params: ["i64", "i32"], results: ["i64"] });
    expect(values(call(nested.member, wide.id, [{ I64: "-5" }, i32(3)]))).toEqual([{ I64: -2 } as unknown as WasmNumber]);
  });

  test("an imported callback kept in the table has its import's type and reaches the dispatcher", () => {
    const nested = start();
    const frames: number[][] = [];
    nested.member.dispatch = (invocation, id, pointer) => {
      const view = new DataView(nested.member.owner.handle.buffer());
      frames.push([invocation, id, view.getUint32(pointer, true), view.getUint32(pointer + 4, true)]);
      view.setFloat64(pointer + 16, view.getFloat64(pointer + 16, true) * 2, true);
      return 0;
    };
    const kept = entryFunction(nested, 2);
    expect(kept).toMatchObject({ params: ["f64"], results: ["f64"] });
    expect(values(call(nested.member, kept.id, [f64(2.5)])).map(f64Value)).toEqual([5]);
    expect(frames).toEqual([[7, CALLBACK, 1, 1]]);
    // The other import has another type, and is its own function.
    const other = entryFunction(nested, 5);
    expect(other).toMatchObject(BINARY);
    expect(other.id).not.toBe(kept.id);
    expect(entryFunction(nested, 2).id).toBe(kept.id);
  });

  test("a callback entry reports a pending exception and a bad frame as the callback itself does", () => {
    const nested = start();
    const kept = entryFunction(nested, 2);
    nested.member.dispatch = () => PENDING_EXCEPTION;
    expect(call(nested.member, kept.id, [f64(1)])).toBe("PendingException");
    nested.member.dispatch = () => BAD_FRAME;
    expect(failure(call(nested.member, kept.id, [f64(1)]))).toEqual({ category: "RuntimeError", message: "nested execution failed: invalid engine callback frame" });
    nested.member.dispatch = () => 0;
    expect(values(call(nested.member, kept.id, [f64(1.5)])).map(f64Value)).toEqual([1.5]);
    expect(nested.member.host.snapshot()).toMatchObject({ coreFailed: false, activeInvocations: 0 });
  });

  test("a reference-typed entry cannot cross, and leaves no function behind", () => {
    const nested = start();
    for (let round = 0; round < 2; round++) {
      expect(failure(entry(nested, 4))).toEqual({ category: "RuntimeError", message: "reference/SIMD values cannot cross this nested JS ABI" });
    }
    expect(nested.member.host.snapshot().functions).toBe(0);
  });

  test("an index at or past the length is a RangeError", () => {
    const nested = start();
    for (const index of [7, 8, 9, 0xffff_ffff]) expect(failure(entry(nested, index))).toEqual(RANGE);
  });
});

describe("writing a table", () => {
  test("set stores a function or null, and the instance's own call_indirect sees it", () => {
    const nested = start();
    const hidden = entryFunction(nested, 1);
    expect(failure(indirect(nested, 6, 9, 4)).category).toBe("RuntimeError");
    expect(count(set(nested, 6, hidden.id))).toBe(0);
    expect(entry(nested, 6)).toEqual({ Function: hidden });
    expect(values(indirect(nested, 6, 9, 4))).toEqual([{ I32: 5 }]);
    expect(count(set(nested, 6, null))).toBe(0);
    expect(entry(nested, 6)).toBe("Null");
    expect(failure(indirect(nested, 6, 9, 4)).category).toBe("RuntimeError");
  });

  test("a write made by the instance itself is what the next read returns", () => {
    const nested = start();
    const { member, instance } = nested;
    const hidden = entryFunction(nested, 1);
    expect(values(call(member, exported(member, instance, "clear").id, [i32(0)]))).toEqual([]);
    expect(entry(nested, 0)).toBe("Null");
    expect(values(call(member, exported(member, instance, "store").id, [i32(0)]))).toEqual([]);
    expect(entry(nested, 0)).toEqual({ Function: hidden });
  });

  test("refuses an index past the length, an unknown function and another backend's function", () => {
    const nested = start();
    const add = entryFunction(nested, 0);
    for (const index of [7, 0xffff_ffff]) expect(failure(set(nested, index, add.id))).toEqual(RANGE);
    expect(failure(set(nested, 7, null))).toEqual(RANGE);
    expect(errorText(set(nested, 0, add.id + 40))).toBe("invalid nested function");
    expect(errorText(set(nested, 0, add.id & ~BACKEND))).toBe("mixed-backend WebAssembly resource");
    expect(errorText(grow(nested, 1, add.id + 40))).toBe("invalid nested function");
    expect(entry(nested, 0)).toEqual({ Function: add });
    expect(length(nested)).toBe(7);
  });

  test("grow returns the old length, fills the new slots and stops at the declared maximum", () => {
    const nested = start();
    const { member, instance } = nested;
    const add = entryFunction(nested, 0);
    const size = () => values(call(member, exported(member, instance, "size").id, []));
    expect(count(grow(nested, 0, null))).toBe(7);
    expect(count(grow(nested, 1, null))).toBe(7);
    expect(entry(nested, 7)).toBe("Null");
    expect(count(grow(nested, 1, add.id))).toBe(8);
    expect(entry(nested, 8)).toEqual({ Function: add });
    expect(values(indirect(nested, 8, 3, 4))).toEqual([{ I32: 7 }]);
    for (const delta of [1, 0xffff_ffff]) expect(failure(grow(nested, delta, null))).toEqual(RANGE);
    expect(length(nested)).toBe(9);
    expect(size()).toEqual([{ I32: 9 }]);
  });

  test("a table with no declared maximum grows, and the engine's own limit is a RangeError", () => {
    const { member, instance } = start();
    const loose: Nested = { member, module: 0, instance, table: tableOf(member, instance, "loose") };
    expect(count(grow(loose, 4095, null))).toBe(1);
    expect(length(loose)).toBe(4096);
    expect(failure(grow(loose, 0xffff_ffff, null))).toEqual(RANGE);
    expect(length(loose)).toBe(4096);
  });
});

describe("tables across instances", () => {
  function peer(first: Nested) {
    const { member } = first;
    const add = exported(member, first.instance, "add");
    const instance = instantiate(member, handle(compile(member, peerModule)), [{ Function: { module: "peer", name: "add", id: add.id } }]);
    return { add, second: { member, module: 0, instance, table: tableOf(member, instance, "table") } satisfies Nested };
  }

  test("an imported function kept in another instance's table is still that one function", () => {
    const first = start();
    const { add, second } = peer(first);
    expect(entry(second, 0)).toEqual({ Function: add });
    expect(entryFunction(second, 1)).toMatchObject({ params: ["i32"], results: ["i32"] });
    expect(entry(second, 2)).toBe("Null");
  });

  test("a function set into another instance's table is called there with its own type", () => {
    const first = start();
    const { second } = peer(first);
    const double = entryFunction(second, 1);
    expect(count(set(first, 6, double.id))).toBe(0);
    expect(entry(first, 6)).toEqual({ Function: double });
    expect(values(call(first.member, double.id, [i32(21)]))).toEqual([{ I32: 42 }]);
    // call_indirect checks the real signature: a unary function is not the binary type it asks for.
    expect(failure(indirect(first, 6, 1, 2)).category).toBe("RuntimeError");
    const hidden = entryFunction(first, 1);
    expect(count(set(second, 2, hidden.id))).toBe(0);
    expect(entry(second, 2)).toEqual({ Function: hidden });
  });

  test("a second member has its own tables and function ids", () => {
    const { join } = group();
    const sender = join();
    const first = start(sender), other = start(join(sender));
    expect(count(set(first, 6, entryFunction(first, 1).id))).toBe(0);
    expect(entry(other, 6)).toBe("Null");
    expect(other.member.host.snapshot()).toMatchObject({ tables: 1, functions: 0 });
  });
});
