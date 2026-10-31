// Qualifies a built JSC side and its run readout for the allocation-boundary diagnostic
// (docs/bun-patches/jsc-memory-telemetry.md). Read-only: it never runs a guest.
//
//   bun scripts/jsc-allocation-boundary-qualify.ts binary <core.wasm> <engine.wasm>
//   bun scripts/jsc-allocation-boundary-qualify.ts readout <snapshots.json> [--require-subject]
//
// `binary` checks the imported and exported function types and the shared errno cell.
// `readout` checks memory snapshots from a run with BUN_WASM_JSC_ALLOCATION_BOUNDARY=1.
// Each prints a JSON verdict and exits 1 unless it passes.
import { readFileSync } from "node:fs";
import { allocationBoundaryFromCounters, boundaryRejections, boundaryStates, type AllocationBoundary, type BoundarySlot } from "../web/src/jsc-allocation-boundary.ts";

type ValueType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref";
interface FunctionType { params: ValueType[]; results: ValueType[] }
type Entity = { kind: "function"; type: FunctionType } | { kind: "global"; type: ValueType; mutable: boolean } | { kind: "table" | "memory" | "tag" };
interface ModuleSurface { imports: Map<string, Entity>; exports: Map<string, Entity> }

const valueTypes = new Map<number, ValueType>([[0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"], [0x7b, "v128"], [0x70, "funcref"], [0x6f, "externref"]]);
const pointerGetter: FunctionType = { params: [], results: ["i32"] };

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean { return this.offset >= this.bytes.length; }
  byte(): number {
    const value = this.bytes[this.offset++];
    if (value === undefined) throw new RangeError("Truncated wasm module");
    return value;
  }
  u32(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return result;
    }
    throw new RangeError("Invalid LEB128");
  }
  name(): string {
    const length = this.u32();
    const start = this.offset;
    this.offset += length;
    return new TextDecoder().decode(this.bytes.subarray(start, this.offset));
  }
  valueType(): ValueType {
    const type = valueTypes.get(this.byte());
    if (!type) throw new TypeError("Unsupported wasm value type");
    return type;
  }
  limits(): void {
    const flags = this.byte();
    this.u32();
    if (flags & 1) this.u32();
  }
  section(): Reader {
    const length = this.u32();
    const start = this.offset;
    this.offset += length;
    return new Reader(this.bytes.subarray(start, this.offset));
  }
}

function functionType(reader: Reader): FunctionType {
  if (reader.byte() !== 0x60) throw new TypeError("Unsupported wasm type form");
  const params = Array.from({ length: reader.u32() }, () => reader.valueType());
  return { params, results: Array.from({ length: reader.u32() }, () => reader.valueType()) };
}

function importEntity(reader: Reader, types: readonly FunctionType[]): Entity {
  const kind = reader.byte();
  if (kind === 0x00) return { kind: "function", type: knownType(types, reader.u32()) };
  if (kind === 0x03) return { kind: "global", type: reader.valueType(), mutable: reader.byte() === 1 };
  if (kind === 0x01) { reader.valueType(); reader.limits(); return { kind: "table" }; }
  if (kind === 0x02) { reader.limits(); return { kind: "memory" }; }
  reader.byte(); reader.u32();
  return { kind: "tag" };
}

function knownType(types: readonly FunctionType[], index: number): FunctionType {
  const type = types[index];
  if (!type) throw new RangeError(`Missing wasm type ${index}`);
  return type;
}

/** Imports with their types, and exported functions and globals with theirs. */
function moduleSurface(bytes: Uint8Array): ModuleSurface {
  if (bytes.length < 8 || bytes.subarray(0, 8).join() !== "0,97,115,109,1,0,0,0") throw new TypeError("Not a wasm module");
  const reader = new Reader(bytes);
  reader.offset = 8;
  const types: FunctionType[] = [];
  const functions: FunctionType[] = [];
  const globals: { type: ValueType; mutable: boolean }[] = [];
  const surface: ModuleSurface = { imports: new Map(), exports: new Map() };
  const exported: { name: string; kind: number; index: number }[] = [];
  while (!reader.done) {
    const id = reader.byte();
    const section = reader.section();
    if (id === 1) for (let count = section.u32(); count > 0; count--) types.push(functionType(section));
    if (id === 2) readImports(section, types, surface, functions, globals);
    if (id === 3) for (let count = section.u32(); count > 0; count--) functions.push(knownType(types, section.u32()));
    if (id === 6) readGlobalTypes(section, globals);
    if (id === 7) for (let count = section.u32(); count > 0; count--) exported.push({ name: section.name(), kind: section.byte(), index: section.u32() });
  }
  for (const entry of exported) {
    const entity = exportedEntity(entry.kind, entry.index, functions, globals);
    if (entity) surface.exports.set(entry.name, entity);
  }
  return surface;
}

function readImports(section: Reader, types: readonly FunctionType[], surface: ModuleSurface, functions: FunctionType[], globals: { type: ValueType; mutable: boolean }[]): void {
  for (let count = section.u32(); count > 0; count--) {
    const name = `${section.name()}.${section.name()}`;
    const entity = importEntity(section, types);
    surface.imports.set(name, entity);
    if (entity.kind === "function") functions.push(entity.type);
    if (entity.kind === "global") globals.push({ type: entity.type, mutable: entity.mutable });
  }
}

// Only the global's type is needed; its constant initializer is skipped up to `end`.
function readGlobalTypes(section: Reader, globals: { type: ValueType; mutable: boolean }[]): void {
  for (let count = section.u32(); count > 0; count--) {
    globals.push({ type: section.valueType(), mutable: section.byte() === 1 });
    skipConstantExpression(section);
  }
}

const lebImmediates = new Set([0x23, 0x41, 0x42, 0xd2]); // global.get, i32/i64.const, ref.func
const fixedImmediates = new Map([[0x43, 4], [0x44, 8], [0xd0, 1]]); // f32/f64.const, ref.null
const extendedConstants = new Set([0x6a, 0x6b, 0x6c, 0x7c, 0x7d, 0x7e]); // i32/i64 add, sub, mul

function skipConstantExpression(section: Reader): void {
  for (let opcode = section.byte(); opcode !== 0x0b; opcode = section.byte()) {
    if (lebImmediates.has(opcode)) skipLeb(section);
    else if (fixedImmediates.has(opcode)) section.offset += fixedImmediates.get(opcode) ?? 0;
    else if (!extendedConstants.has(opcode)) throw new TypeError(`Unsupported global initializer 0x${opcode.toString(16)}`);
  }
}

function skipLeb(section: Reader): void {
  while (section.byte() & 0x80) continue;
}

function exportedEntity(kind: number, index: number, functions: readonly FunctionType[], globals: readonly { type: ValueType; mutable: boolean }[]): Entity | null {
  if (kind === 0x00) return { kind: "function", type: knownType(functions, index) };
  const global = globals[index];
  if (kind === 0x03 && global) return { kind: "global", ...global };
  return null;
}

function sameFunction(entity: Entity | undefined, type: FunctionType): boolean {
  if (entity?.kind !== "function") return false;
  return entity.type.params.join() === type.params.join() && entity.type.results.join() === type.results.join();
}

/** Findings for the changed side's diagnostic imports and export against the core it links with. */
export function qualifyBinary(core: Uint8Array, side: Uint8Array): string[] {
  const coreSurface = moduleSurface(core);
  const sideSurface = moduleSurface(side);
  const findings: string[] = [];
  for (const name of ["jsc_allocation_boundary", "jsc_memory_telemetry", "jsc_memory_telemetry_refresh"]) {
    if (!sameFunction(sideSurface.exports.get(name), pointerGetter)) findings.push(`side does not export ${name} as () -> i32`);
  }
  for (const name of ["bun_memory_telemetry", "bun_memory_failure_telemetry"]) {
    if (!sameFunction(sideSurface.imports.get(`env.${name}`), pointerGetter)) findings.push(`side does not import env.${name} as () -> i32`);
    if (!sameFunction(coreSurface.exports.get(name), pointerGetter)) findings.push(`core does not export ${name} as () -> i32`);
  }
  const errno = sideSurface.imports.get("GOT.mem.errno");
  if (errno?.kind !== "global" || errno.type !== "i32") findings.push("side does not import the core errno cell as GOT.mem.errno i32");
  const cell = coreSurface.exports.get("errno");
  if (cell?.kind !== "global" || cell.type !== "i32" || cell.mutable) findings.push("core does not export errno as an immutable i32 address");
  return findings;
}

interface ProcessVerdict { id: string; findings: string[]; control: BoundarySlot | null; subject: BoundarySlot | null; wrappedLibcNull: boolean | null }

function delta(slot: BoundarySlot, field: "failures" | "allocations"): number | null {
  const before = slot[`coreBefore.${field}`];
  const after = slot[`coreAfter.${field}`];
  return before === null || after === null ? null : after - before;
}

function controlFindings(record: AllocationBoundary): string[] {
  const findings: string[] = [];
  const state = boundaryStates[record.state ?? -1] ?? "unknown";
  const rejection = boundaryRejections[record.rejection ?? -1] ?? "unknown";
  if (state !== "subjectArmed" || rejection !== "none") findings.push(`state ${state}, rejection ${rejection}`);
  const control = record.control;
  if (control.recorded !== 1 || control.resultNull !== 0 || control.requestBytes !== record.controlLength) findings.push("control is not one successful exact request");
  if (record.expectedVmAddress === null || control.vmAddress !== record.expectedVmAddress) findings.push("control VM is not the armed VM");
  if (delta(control, "failures") !== 0 || delta(control, "allocations") !== 1) findings.push("control core counters do not show one allocation and no new failure");
  if (record.coverageMisses !== 0) findings.push(`${record.coverageMisses ?? "unknown"} oversize calls in another VM`);
  return findings;
}

function subjectFindings(record: AllocationBoundary, snapshot: Snapshot): string[] {
  const failure = snapshot.engineFailure;
  if (failure?.category !== "jsc.typedArray") return [];
  const subject = record.subject;
  if (subject.recorded !== 1) return ["the JSC typed-array failure has no latched subject"];
  const findings: string[] = [];
  if (subject.vmAddress !== record.expectedVmAddress) findings.push("subject VM is not the armed VM");
  if (subject.requestSequence !== snapshot.engineCounters.failedAllocationSequence || subject.requestBytes !== failure.bytes) {
    findings.push("subject does not match the cached JSC failure sequence and bytes");
  }
  return findings;
}

interface Snapshot { id: string; engine: string; engineFailure: { bytes: number | null; category: string } | null; engineCounters: Record<string, number | null> }

function parseSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const id: unknown = Reflect.get(value, "id");
  const engine: unknown = Reflect.get(value, "engine");
  const counters: unknown = Reflect.get(value, "engineCounters");
  const failure: unknown = Reflect.get(value, "engineFailure");
  if (typeof id !== "string" || typeof engine !== "string" || !counters || typeof counters !== "object") return null;
  if (!Object.values(counters).every(entry => entry === null || typeof entry === "number")) return null;
  return { id, engine, engineCounters: Object.fromEntries(Object.entries(counters)), engineFailure: parseFailure(failure) };
}

function parseFailure(value: unknown): Snapshot["engineFailure"] {
  if (!value || typeof value !== "object") return null;
  const bytes: unknown = Reflect.get(value, "bytes");
  const category: unknown = Reflect.get(value, "category");
  if (typeof category !== "string" || !(bytes === null || typeof bytes === "number")) return null;
  return { bytes, category };
}

function verdict(snapshot: Snapshot): ProcessVerdict {
  const record = allocationBoundaryFromCounters(snapshot.engineCounters);
  if (!record) return { id: snapshot.id, findings: ["no allocation-boundary record: the process was not armed or not read"], control: null, subject: null, wrappedLibcNull: null };
  const findings = controlFindings(record).concat(subjectFindings(record, snapshot));
  const subject = record.subject.recorded === 1 ? record.subject : null;
  // Only an exact core delta ties a null result to the wrapped libc entry; it proves nothing about why.
  const wrappedLibcNull = subject ? delta(subject, "failures") === 1 && delta(subject, "allocations") === 0 : null;
  return { id: snapshot.id, findings, control: record.control, subject, wrappedLibcNull };
}

/** Every JSC process must carry an acknowledged control; any JSC typed-array failure must match its subject. */
export function qualifyReadout(snapshots: readonly unknown[], requireSubject: boolean) {
  const parsed = snapshots.map(parseSnapshot);
  const findings = parsed.some(snapshot => !snapshot) ? ["a snapshot is malformed"] : [];
  const processes = parsed.filter((snapshot): snapshot is Snapshot => snapshot?.engine === "jsc").map(verdict);
  if (!processes.length) findings.push("no JSC process snapshots");
  if (requireSubject && !processes.some(process => process.subject)) findings.push("no process latched a subject");
  const pass = !findings.length && processes.every(process => !process.findings.length);
  return { pass, findings, processes };
}

function main(argv: readonly string[]): number {
  const [mode, first, second] = argv;
  if (mode === "binary" && first && second) {
    const findings = qualifyBinary(readFileSync(first), readFileSync(second));
    console.log(JSON.stringify({ pass: !findings.length, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  if (mode === "readout" && first) {
    const data: unknown = JSON.parse(readFileSync(first, "utf8"));
    const result = qualifyReadout(Array.isArray(data) ? data : [], second === "--require-subject");
    console.log(JSON.stringify(result, null, 2));
    return result.pass ? 0 : 1;
  }
  console.error("Usage: jsc-allocation-boundary-qualify.ts binary <core.wasm> <engine.wasm> | readout <snapshots.json> [--require-subject]");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
