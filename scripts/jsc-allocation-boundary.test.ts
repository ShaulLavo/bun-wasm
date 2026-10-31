import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allocationBoundaryBytes, allocationBoundaryDiagnostics, allocationBoundaryFromCounters, boundaryGenerationFindings, readAllocationBoundary,
  type AllocationBoundary } from "../web/src/jsc-allocation-boundary.ts";
import { createMemoryReader } from "../web/src/memory-telemetry.ts";
import { qualifyBinary, qualifyReadout } from "./jsc-allocation-boundary-qualify.ts";

// Synthetic records and modules: they exercise the reader and qualifier, never a real guest.
const root = resolve(import.meta.dir, "..");
const unknown = 0xffffffffffffffffn;
const slotWords = 39;
const allWords = (1n << 39n) - 1n;
const RECORD = 1024;
const VM = 5000;
const GENERATION = 0x1f2e3d4c5b6a7;
const allocationBoundaryCounters = allocationBoundaryDiagnostics(GENERATION);

type SlotValues = Partial<Record<number, bigint>>;
function slot(values: SlotValues): bigint[] {
  return Array.from({ length: slotWords }, (_, index) => values[index] ?? (index < 2 ? 0n : unknown));
}
function recorded(requestBytes: bigint, coreDelta: { failures: bigint; allocations: bigint }, extra: SlotValues = {}): bigint[] {
  const observations = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index + 13, 0n]));
  return slot({ ...observations, 0: 1n, 1: allWords, 2: 1n, 3: 7n, 4: requestBytes, 5: requestBytes, 6: 1n, 7: 1n, 8: BigInt(VM), 9: 6000n,
    10: 0n, 11: 0n, 12: 0n, 13: 8192n, 21: 1073741824n, 22: 10000n, 23: 12000n, 24: 65536n,
    25: 3n, 26: 40n, 27: 10n, 30: 11008n, 31: 12000n, 32: 65536n, 33: 3n + coreDelta.failures,
    34: 40n + coreDelta.allocations, 35: 10n, 38: BigInt(GENERATION), ...extra });
}
function record(options: { state?: bigint; rejection?: bigint; misses?: bigint; generation?: bigint; control?: bigint[]; subject?: bigint[]; last?: bigint[] } = {}): bigint[] {
  const control = options.control ?? recorded(1001n, { failures: 0n, allocations: 1n });
  const last = options.last ?? options.subject ?? control;
  return [1n, BigInt(allocationBoundaryBytes), options.state ?? 2n, options.rejection ?? 0n, 1n, BigInt(VM), 6000n, 1001n,
    last[2] ?? 0n, options.subject ? 1n : 0n, options.misses ?? 0n, options.generation ?? BigInt(GENERATION)]
    .concat(last, control, options.subject ?? slot({}));
}

function fixture(words: bigint[]) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  words.forEach((value, index) => view.setBigUint64(RECORD + index * 8, value, true));
  return { memory, view, exports: { jsc_allocation_boundary: () => RECORD } };
}

test("the reader decodes the fixed record and leaves unobserved words null", () => {
  const trapped = slot({ 0: 1n, 1: allWords & ~((3n << 11n) | (0xffn << 30n)), 4: 25297737n, 11: 0n, 30: 9n, 38: BigInt(GENERATION) });
  const words = record({ subject: trapped, last: slot({}) });
  expect(words.length * 8).toBe(allocationBoundaryBytes);
  const { memory, exports } = fixture(words);
  const boundary = readAllocationBoundary(memory, exports, GENERATION);
  expect(boundary?.state).toBe(2);
  expect(boundary?.generation).toBe(GENERATION);
  expect(boundary?.expectedGeneration).toBe(GENERATION);
  expect(boundary?.subject.generation).toBe(GENERATION);
  expect(boundary?.control.requestBytes).toBe(1001);
  expect(boundary?.control["coreAfter.allocations"]).toBe(41);
  expect(boundary?.last.recorded).toBe(0);
  expect(boundary?.last.requestBytes).toBeNull();
  expect(boundary?.subject.requestBytes).toBe(25297737);
  expect(boundary?.subject.errnoAfterCall).toBeNull();
  expect(boundary?.subject["coreAfter.live"]).toBeNull();
  expect(readAllocationBoundary(memory, {}, GENERATION)).toBeNull();
  expect(allocationBoundaryCounters(memory, {})).toEqual({});
  const counters = allocationBoundaryCounters(memory, exports);
  expect(counters["allocationBoundary.expectedGeneration"]).toBe(GENERATION);
  expect(counters["allocationBoundary.generation"]).toBe(GENERATION);
  expect(allocationBoundaryFromCounters(counters)).toEqual(boundary);
  expect(allocationBoundaryFromCounters({})).toBeNull();
});

test("the reader rejects a different ABI, size or pointer instead of decoding it", () => {
  for (const [index, value] of [[0, 2n], [1, 192n]] as const) {
    const f = fixture(record());
    f.view.setBigUint64(RECORD + index * 8, value, true);
    expect(() => readAllocationBoundary(f.memory, f.exports, GENERATION)).toThrow("ABI");
  }
  const f = fixture(record());
  expect(() => readAllocationBoundary(f.memory, { jsc_allocation_boundary: () => RECORD + 4 }, GENERATION)).toThrow("bounds");
  expect(() => readAllocationBoundary(f.memory, { jsc_allocation_boundary: () => 65536 - 8 }, GENERATION)).toThrow("bounds");
});

function decoded(generation: number | null, words: bigint[]): AllocationBoundary {
  const f = fixture(words);
  const boundary = readAllocationBoundary(f.memory, f.exports, generation);
  if (!boundary) throw new Error("missing fixture record");
  return boundary;
}

test("a record is evidence only for the instance whose generation it acknowledges", () => {
  expect(boundaryGenerationFindings([decoded(GENERATION, record())])).toEqual([[]]);
  expect(boundaryGenerationFindings([decoded(null, record())])).toEqual([["the host gave this instance no generation"]]);
  expect(boundaryGenerationFindings([decoded(GENERATION, record({ generation: 0xffffffffffffffffn }))])).toEqual([["the record acknowledges no generation"]]);
  expect(boundaryGenerationFindings([decoded(GENERATION + 1, record())])).toEqual([["the record acknowledges another instance's generation"]]);
  const stale = recorded(1001n, { failures: 0n, allocations: 1n }, { 38: BigInt(GENERATION + 1) });
  expect(boundaryGenerationFindings([decoded(GENERATION, record({ control: stale, subject: stale }))])).toEqual([[
    "the control slot was not written under the record's generation", "the subject slot was not written under the record's generation"]]);
  // The same record read for two instances: one of them is a copy.
  const copied = boundaryGenerationFindings([decoded(GENERATION, record()), decoded(GENERATION + 1, record())]);
  expect(copied).toEqual([["the generation appears in another instance's record"],
    ["the record acknowledges another instance's generation", "the generation appears in another instance's record"]]);
  const f = fixture(record());
  const counters = allocationBoundaryDiagnostics(GENERATION + 1)(f.memory, f.exports);
  const carried = allocationBoundaryFromCounters(counters);
  expect(carried && boundaryGenerationFindings([carried])).toEqual([["the record acknowledges another instance's generation"]]);
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
  expect(executor).toContain('return (await import("./jsc-allocation-boundary.js")).allocationBoundaryDiagnostics(generation);');
  expect(JSON.parse(source("package.json")).files).toContain("web/src/jsc-allocation-boundary.ts");
});

test("the side exports a cached record and arms only in its own VM before program code", () => {
  expect(source("scripts/build-engine-jsc.sh")).toContain("--export=jsc_memory_telemetry --export=jsc_memory_telemetry_refresh --export=jsc_allocation_boundary ");
  const vm = source("crates/bunwasm-engine-jsc/src/vm.rs");
  expect(vm).toMatch(/pub extern "C" fn jsc_allocation_boundary\(\) -> \*const BunjscAllocationBoundary \{\s+unsafe \{ bunjsc_allocation_boundary\(\) \}\s+\}/);
  expect(vm).toContain('std::env::var_os("BUN_WASM_JSC_ALLOCATION_BOUNDARY")');
  expect(vm).toContain('std::env::var("BUN_WASM_JSC_ALLOCATION_BOUNDARY_GENERATION")');
  expect(vm).toContain("bunjsc_allocation_boundary_qualify(context, generation)");
  expect(vm).toMatch(/qualify_allocation_boundary\(c\);\s+#\[cfg\(test\)\]\s+install_regression_natives\(&Jsc\);\s+Jsc\s+\}/);
  const helpers = source("crates/bunwasm-jsc/cpp/helpers.cpp");
  expect(helpers).toMatch(/BunjscAllocationBoundary\* bunjsc_allocation_boundary\(\)\s+\{\s+return &bunjscAllocationBoundary;\s+\}/);
  expect(helpers).toContain("JSUint8Array::create(globalObject, structure, bunjscBoundaryControlLength)");
  expect(helpers).toContain("bunjsc_boundary_arm_control(&vm, globalObject, generation, sampleCoreAllocator)");
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
  const engineCounters: Record<string, number | null> = { failedAllocationSequence: failure ? 8 : 0, ...allocationBoundaryCounters(f.memory, f.exports) };
  return { id, engine: "jsc", engineFailure: failure, engineCounters };
}
const subjectFailure = recorded(25297737n, { failures: 1n, allocations: 0n }, { 2: 2n, 3: 8n, 12: 1n });
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
  const other = qualifyReadout([snapshot(record({ subject: recorded(4096n, { failures: 0n, allocations: 0n }, { 2: 2n, 3: 8n, 12: 1n }) }), typedArrayFailure)], false);
  expect(other.processes[0]?.findings).toEqual(["subject does not match the cached JSC failure sequence and bytes"]);
  expect(other.processes[0]?.wrappedLibcNull).toBeNull();
  const noWrappedFailure = recorded(25297737n, { failures: 0n, allocations: 0n }, { 2: 2n, 3: 8n, 12: 1n });
  const valid = qualifyReadout([snapshot(record({ subject: noWrappedFailure }), typedArrayFailure)], true);
  expect(valid.pass).toBe(true);
  expect(valid.processes[0]?.wrappedLibcNull).toBe(false);
});


function alteredCounter(key: string, value: number | null) {
  const result = snapshot(record());
  result.engineCounters[`allocationBoundary.${key}`] = value;
  return result;
}

test.each([
  ["abiVersion", 2], ["byteLength", 192], ["coreSamplerBound", 0], ["armedAttempts", 2],
  ["controlLength", 999], ["expectedVmAddress", 0], ["expectedGlobalObjectAddress", 0],
  ["generation", 0], ["expectedGeneration", 0], ["expectedGeneration", GENERATION + 1],
  ["control.generation", GENERATION + 1], ["control.availability", 0], ["control.availability", Number(allWords) + 1],
  ["control.recorded", 0], ["control.attempt", 2], ["control.requestSequence", 0],
  ["control.elementCount", 999], ["control.elementSize", 2], ["control.zeroFill", 0],
  ["control.globalObjectAddress", 9999], ["control.vmAddress", VM + 1], ["control.resultNull", 1],
  ["control.coreBefore.failures", null], ["control.heap.capacity", null], ["control.requestBytes", -1],
  ["control.requestBytes", Number.NaN], ["control.requestBytes", Number.POSITIVE_INFINITY],
  ["control.requestBytes", 1001.5], ["control.requestBytes", Number.MAX_SAFE_INTEGER + 1], ["control.errnoAfterCall", 0x100000000],
] satisfies Array<[string, number | null]>)('readout rejects malformed control field %s=%s', (key, value) => {
  expect(qualifyReadout([alteredCounter(key, value)], false).pass).toBe(false);
});

test.each([
  ["vmAddress", VM + 1], ["globalObjectAddress", 9999], ["generation", GENERATION + 1],
  ["availability", 0], ["resultNull", 0], ["attempt", 1], ["requestSequence", 7],
  ["elementCount", 999], ["elementSize", 3], ["zeroFill", 2],
] satisfies Array<[string, number]>)('readout rejects malformed subject field %s=%s', (key, value) => {
  const result = snapshot(record({ subject: subjectFailure }), typedArrayFailure);
  result.engineCounters[`allocationBoundary.subject.${key}`] = value;
  expect(qualifyReadout([result], true).pass).toBe(false);
});

test.each([undefined, 1, [], {}, { category: "jsc.typedArray", bytes: "bad" },
  { category: "", bytes: 7 }, { category: "jsc.typedArray", bytes: -1 },
  { category: "jsc.typedArray", bytes: Number.NaN }].map(engineFailure => ({ engineFailure })))('malformed failure data is not normalized to no failure: %j', ({ engineFailure }) => {
  expect(qualifyReadout([{ ...snapshot(record()), engineFailure }], false).pass).toBe(false);
});

test("readout rejects copied generations across instances and duplicate actor snapshots", () => {
  expect(qualifyReadout([snapshot(record()), snapshot(record(), null, "p2")], false).pass).toBe(false);
  expect(qualifyReadout([snapshot(record()), snapshot(record())], false).pass).toBe(false);
});

test("one acknowledged control permits later successful oversize attempts", () => {
  const last = recorded(2048n, { failures: 0n, allocations: 1n }, { 2: 2n, 3: 8n });
  expect(qualifyReadout([snapshot(record({ last }))], false).pass).toBe(true);
  const afterSubject = recorded(2048n, { failures: 0n, allocations: 1n }, { 2: 3n, 3: 9n });
  expect(qualifyReadout([snapshot(record({ subject: subjectFailure, last: afterSubject }), typedArrayFailure)], true).pass).toBe(true);
});


test("a pending latest attempt keeps only observed fields and never supplies a subject", () => {
  const beforeOnly = allWords & ~((3n << 11n) | (0xffn << 30n));
  const after = Object.fromEntries([11, 12].concat(Array.from({ length: 8 }, (_, index) => index + 30)).map(index => [index, unknown]));
  const last = recorded(2048n, { failures: 0n, allocations: 0n }, { ...after, 1: beforeOnly, 2: 2n, 3: 8n });
  expect(qualifyReadout([snapshot(record({ last }))], false).pass).toBe(true);
  expect(qualifyReadout([snapshot(record({ last }))], true).pass).toBe(false);
});
