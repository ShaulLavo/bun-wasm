import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allocationBoundaryBytes, allocationBoundaryCounters, allocationBoundaryFromCounters, readAllocationBoundary } from "../web/src/jsc-allocation-boundary.ts";
import { createMemoryReader } from "../web/src/memory-telemetry.ts";
import { qualifyBinary, qualifyReadout } from "./jsc-allocation-boundary-qualify.ts";

// Synthetic records and modules: they exercise the reader and qualifier, never a real guest.
const root = resolve(import.meta.dir, "..");
const unknown = 0xffffffffffffffffn;
const slotWords = 38;
const allWords = (1n << 38n) - 1n;
const RECORD = 1024;
const VM = 5000;

type SlotValues = Partial<Record<number, bigint>>;
function slot(values: SlotValues): bigint[] {
  return Array.from({ length: slotWords }, (_, index) => values[index] ?? (index < 2 ? 0n : unknown));
}
function recorded(requestBytes: bigint, coreDelta: { failures: bigint; allocations: bigint }, extra: SlotValues = {}): bigint[] {
  return slot({ 0: 1n, 1: allWords, 2: 1n, 3: 7n, 4: requestBytes, 5: requestBytes, 6: 1n, 7: 1n, 8: BigInt(VM), 9: 6000n,
    10: 0n, 11: 0n, 12: 0n, 25: 3n, 26: 40n, 33: 3n + coreDelta.failures, 34: 40n + coreDelta.allocations, ...extra });
}
function record(options: { state?: bigint; rejection?: bigint; misses?: bigint; control?: bigint[]; subject?: bigint[] } = {}): bigint[] {
  const control = options.control ?? recorded(1001n, { failures: 0n, allocations: 1n });
  return [1n, BigInt(allocationBoundaryBytes), options.state ?? 2n, options.rejection ?? 0n, 1n, BigInt(VM), 6000n, 1001n, 1n, 0n,
    options.misses ?? 0n].concat(slot({}), control, options.subject ?? slot({}));
}

function fixture(words: bigint[]) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  words.forEach((value, index) => view.setBigUint64(RECORD + index * 8, value, true));
  return { memory, view, exports: { jsc_allocation_boundary: () => RECORD } };
}

test("the reader decodes the fixed record and leaves unobserved words null", () => {
  const trapped = slot({ 0: 1n, 1: allWords & ~((3n << 11n) | (0xffn << 30n)), 4: 25297737n, 11: 0n, 30: 9n });
  const words = record({ subject: trapped });
  expect(words.length * 8).toBe(allocationBoundaryBytes);
  const { memory, exports } = fixture(words);
  const boundary = readAllocationBoundary(memory, exports);
  expect(boundary?.state).toBe(2);
  expect(boundary?.control.requestBytes).toBe(1001);
  expect(boundary?.control["coreAfter.allocations"]).toBe(41);
  expect(boundary?.last.recorded).toBe(0);
  expect(boundary?.last.requestBytes).toBeNull();
  expect(boundary?.subject.requestBytes).toBe(25297737);
  expect(boundary?.subject.errnoAfterCall).toBeNull();
  expect(boundary?.subject["coreAfter.live"]).toBeNull();
  expect(readAllocationBoundary(memory, {})).toBeNull();
  expect(allocationBoundaryCounters(memory, {})).toEqual({});
  const counters = allocationBoundaryCounters(memory, exports);
  expect(allocationBoundaryFromCounters(counters)).toEqual(boundary);
  expect(allocationBoundaryFromCounters({})).toBeNull();
});

test("the reader rejects a different ABI, size or pointer instead of decoding it", () => {
  for (const [index, value] of [[0, 2n], [1, 192n]] as const) {
    const f = fixture(record());
    f.view.setBigUint64(RECORD + index * 8, value, true);
    expect(() => readAllocationBoundary(f.memory, f.exports)).toThrow("ABI");
  }
  const f = fixture(record());
  expect(() => readAllocationBoundary(f.memory, { jsc_allocation_boundary: () => RECORD + 4 })).toThrow("bounds");
  expect(() => readAllocationBoundary(f.memory, { jsc_allocation_boundary: () => 65536 - 8 })).toThrow("bounds");
});

function telemetryFixture(words: bigint[]) {
  const f = fixture(words);
  const put = (base: number, values: readonly bigint[]) => values.forEach((value, index) => f.view.setBigUint64(base + index * 8, value, true));
  put(128, [1n, 80n, 100n, 200n, 25297737n, 2n, 1n, 41n, 4n, 65536n]);
  put(2048, [1n, 192n, 3n].concat(Array.from({ length: 17 }, () => unknown), [25297737n, 1n, 9n, unknown]));
  let refreshes = 0;
  const core = { exports: { memory: f.memory, bun_memory_telemetry: () => 128 } };
  const side = { exports: { ...f.exports, jsc_memory_telemetry: () => 2048,
    jsc_memory_telemetry_refresh: () => { refreshes++; throw new WebAssembly.RuntimeError("unreachable"); } } };
  return { core, side, refreshes: () => refreshes };
}

test("after an allocation failure the cached record stays readable without entering the side", () => {
  const f = telemetryFixture(record({ subject: recorded(25297737n, { failures: 1n, allocations: 0n }, { 7: 1n, 12: 1n }) }));
  const reader = createMemoryReader("jsc", f.core, f.side, null, undefined, allocationBoundaryCounters);
  const failed = reader.sample(true);
  expect(f.refreshes()).toBe(0);
  expect(failed.engineFailure).toEqual({ bytes: 25297737, category: "jsc.typedArray" });
  expect(failed.engineCounters.failedAllocationSequence).toBe(9);
  expect(failed.engineCounters["allocationBoundary.subject.requestBytes"]).toBe(25297737);
  expect(reader.finish().engineCounters["allocationBoundary.subject.resultNull"]).toBe(1);
});

test("a reader without the diagnostic keeps the existing JSC counters unchanged", () => {
  const f = telemetryFixture(record());
  const plain = createMemoryReader("jsc", f.core, f.side, null).sample();
  expect(Object.keys(plain.engineCounters).some(key => key.startsWith("allocationBoundary."))).toBe(false);
  const armed = createMemoryReader("jsc", f.core, f.side, null, undefined, allocationBoundaryCounters).sample();
  expect(Object.fromEntries(Object.entries(armed.engineCounters).filter(([key]) => !key.startsWith("allocationBoundary.")))).toEqual(plain.engineCounters);
});

const source = (path: string) => readFileSync(join(root, path), "utf8");

test("normal bundles load the diagnostic reader lazily and only for an armed JSC process", () => {
  expect(source("web/src/memory-telemetry.ts")).not.toContain("jsc-allocation-boundary");
  const executor = source("web/src/bun-executor.ts");
  expect(executor).not.toMatch(/^import .*jsc-allocation-boundary/m);
  expect(executor).toContain('if (req.engine !== "jsc" || req.env.BUN_WASM_JSC_ALLOCATION_BOUNDARY !== "1") return undefined;');
  expect(executor).toContain('return (await import("./jsc-allocation-boundary.js")).allocationBoundaryCounters;');
  expect(JSON.parse(source("package.json")).files).toContain("web/src/jsc-allocation-boundary.ts");
});

test("the side exports a cached record and arms only in its own VM before program code", () => {
  expect(source("scripts/build-engine-jsc.sh")).toContain("--export=jsc_memory_telemetry --export=jsc_memory_telemetry_refresh --export=jsc_allocation_boundary ");
  const vm = source("crates/bunwasm-engine-jsc/src/vm.rs");
  expect(vm).toMatch(/pub extern "C" fn jsc_allocation_boundary\(\) -> \*const BunjscAllocationBoundary \{\s+unsafe \{ bunjsc_allocation_boundary\(\) \}\s+\}/);
  expect(vm).toContain('std::env::var_os("BUN_WASM_JSC_ALLOCATION_BOUNDARY")');
  expect(vm).toMatch(/qualify_allocation_boundary\(c\);\s+#\[cfg\(test\)\]\s+install_regression_natives\(&Jsc\);\s+Jsc\s+\}/);
  const helpers = source("crates/bunwasm-jsc/cpp/helpers.cpp");
  expect(helpers).toMatch(/BunjscAllocationBoundary\* bunjsc_allocation_boundary\(\)\s+\{\s+return &bunjscAllocationBoundary;\s+\}/);
  expect(helpers).toContain("JSUint8Array::create(globalObject, structure, bunjscBoundaryControlLength)");
  expect(helpers).not.toMatch(/bunjsc_refresh_memory_telemetry\(\w+\);/);
});

// Minimal valid modules: one function type, functions returning a constant.
const leb = (value: number): number[] => value < 0x80 ? [value] : [(value & 0x7f) | 0x80].concat(leb(value >>> 7));
const name = (text: string) => leb(text.length).concat(Array.from(new TextEncoder().encode(text)));
const vector = (items: readonly number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, items: readonly number[][]) => items.length ? [id].concat(leb(vector(items).length), vector(items)) : [];
const getter = [0x60, 0, 1, 0x7f];
interface ModuleShape { importedFunctions?: string[]; errnoImport?: boolean; functions: string[]; errnoExport?: { mutable: boolean }; type?: number[] }
function module(shape: ModuleShape): Uint8Array {
  const imported = shape.importedFunctions ?? [];
  const imports = imported.map(field => name("env").concat(name(field), [0, 0]))
    .concat(shape.errnoImport ? [name("GOT.mem").concat(name("errno"), [3, 0x7f, 1])] : []);
  const globals = shape.errnoExport ? [[0x7f, shape.errnoExport.mutable ? 1 : 0, 0x41, 16, 0x0b]] : [];
  const exports = shape.functions.map((exported, index) => name(exported).concat([0, imported.length + index]))
    .concat(shape.errnoExport ? [name("errno").concat([3, 0])] : []);
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(section(1, [shape.type ?? getter]), section(2, imports),
    section(3, shape.functions.map(() => [0])), section(6, globals), section(7, exports),
    section(10, shape.functions.map(() => [4, 0, (shape.type ?? getter)[3] === 0x7e ? 0x42 : 0x41, 0, 0x0b])));
  const result = new Uint8Array(bytes);
  if (!WebAssembly.validate(result)) throw new Error("invalid fixture module");
  return result;
}
const coreTelemetry = ["bun_memory_telemetry", "bun_memory_failure_telemetry"];
const sideExports = ["jsc_allocation_boundary", "jsc_memory_telemetry", "jsc_memory_telemetry_refresh"];
const core = (mutable = false, type = getter) => module({ functions: coreTelemetry, errnoExport: { mutable }, type });
const side = (shape: Partial<ModuleShape> = {}) => module({ importedFunctions: coreTelemetry, errnoImport: true, functions: sideExports, ...shape });

test("binary qualification checks imported and exported function types and the shared errno cell", () => {
  expect(qualifyBinary(core(), side())).toEqual([]);
  expect(qualifyBinary(core(), side({ functions: sideExports.slice(1) }))).toEqual(["side does not export jsc_allocation_boundary as () -> i32"]);
  expect(qualifyBinary(core(), side({ importedFunctions: coreTelemetry.slice(0, 1) }))).toEqual(["side does not import env.bun_memory_failure_telemetry as () -> i32"]);
  expect(qualifyBinary(core(), side({ errnoImport: false }))).toEqual(["side does not import the core errno cell as GOT.mem.errno i32"]);
  expect(qualifyBinary(core(true), side())).toEqual(["core does not export errno as an immutable i32 address"]);
  expect(qualifyBinary(core(false, [0x60, 0, 1, 0x7e]), side())).toEqual(["core does not export bun_memory_telemetry as () -> i32",
    "core does not export bun_memory_failure_telemetry as () -> i32"]);
  expect(() => qualifyBinary(new Uint8Array([1, 2, 3]), side())).toThrow("Not a wasm module");
});

function snapshot(words: bigint[], failure: { bytes: number; category: string } | null = null, id = "p1") {
  const f = fixture(words);
  const engineCounters = { failedAllocationSequence: 7, ...allocationBoundaryCounters(f.memory, f.exports) };
  return { id, engine: "jsc", engineFailure: failure, engineCounters };
}
const subjectFailure = recorded(25297737n, { failures: 1n, allocations: 0n }, { 12: 1n });
const typedArrayFailure = { bytes: 25297737, category: "jsc.typedArray" };

test("readout qualification needs an acknowledged control in every JSC process", () => {
  expect(qualifyReadout([snapshot(record())], false).pass).toBe(true);
  expect(qualifyReadout([snapshot(record())], true).findings).toEqual(["no process latched a subject"]);
  const missing = qualifyReadout([snapshot(record()), { id: "p2", engine: "jsc", engineFailure: null, engineCounters: {} }], false);
  expect(missing.pass).toBe(false);
  expect(missing.processes[1]?.findings).toEqual(["no allocation-boundary record: the process was not armed or not read"]);
  expect(qualifyReadout([snapshot(record({ state: 3n, rejection: 8n }))], false).processes[0]?.findings).toContain("state rejected, rejection coreFailureCount");
  expect(qualifyReadout([snapshot(record({ control: recorded(1001n, { failures: 1n, allocations: 1n }) }))], false).processes[0]?.findings)
    .toEqual(["control core counters do not show one allocation and no new failure"]);
  expect(qualifyReadout([snapshot(record({ misses: 2n }))], false).processes[0]?.findings).toEqual(["2 oversize calls in another VM"]);
  expect(qualifyReadout([{ id: "q", engine: "quickjs", engineFailure: null, engineCounters: {} }], false).findings).toEqual(["no JSC process snapshots"]);
  expect(qualifyReadout([null], false).findings).toContain("a snapshot is malformed");
});

test("a JSC typed-array failure must match the latched subject; the core delta only marks a wrapped libc null", () => {
  const matched = qualifyReadout([snapshot(record({ subject: subjectFailure }), typedArrayFailure)], true);
  expect(matched.pass).toBe(true);
  expect(matched.processes[0]?.wrappedLibcNull).toBe(true);
  const unlatched = qualifyReadout([snapshot(record(), typedArrayFailure)], false);
  expect(unlatched.processes[0]?.findings).toEqual(["the JSC typed-array failure has no latched subject"]);
  const other = qualifyReadout([snapshot(record({ subject: recorded(4096n, { failures: 0n, allocations: 0n }, { 12: 1n }) }), typedArrayFailure)], false);
  expect(other.processes[0]?.findings).toEqual(["subject does not match the cached JSC failure sequence and bytes"]);
  expect(other.processes[0]?.wrappedLibcNull).toBe(false);
});
