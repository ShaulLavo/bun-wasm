import { readTelemetryRecord, telemetryCount, type EngineDiagnostics } from "./memory-telemetry.js";

// Host reader for the JSC allocation-boundary record (docs/bun-patches/jsc-memory-telemetry.md).
// Loaded only for a JSC process run with BUN_WASM_JSC_ALLOCATION_BOUNDARY=1.
export const allocationBoundaryExport = "jsc_allocation_boundary";
export const allocationBoundaryBytes = 1000;
export const boundaryStates = ["disarmed", "controlArmed", "subjectArmed", "rejected"] as const;
export const boundaryRejections = ["none", "controlNotObserved", "controlAttempts", "coverageMiss", "controlFailed",
  "controlRequest", "controlIdentity", "coreUnavailable", "coreFailureCount", "coreAllocationCount"] as const;
const headerFields = ["abiVersion", "byteLength", "state", "rejection", "coreSamplerBound", "expectedVmAddress",
  "expectedGlobalObjectAddress", "controlLength", "armedAttempts", "subjectFailures", "coverageMisses"] as const;
const coreFields = ["live", "peak", "capacity", "failures", "allocations", "frees", "firstFailureSize", "firstFailureCategory"] as const;
type CoreField = (typeof coreFields)[number];
const requestFields = ["recorded", "availability", "attempt", "requestSequence", "requestBytes", "elementCount", "elementSize",
  "zeroFill", "vmAddress", "globalObjectAddress", "errnoBefore", "errnoAfterCall", "resultNull", "heap.capacity",
  "heap.extraMemory", "heap.arrayBufferBytes", "heap.totalBytesAllocated", "heap.bytesAllocatedThisCycle",
  "heap.allocationBudgetThisCycle", "heap.maxHeapSize", "heap.sizeAfterLastCollection", "heap.ramSize"] as const;
type SlotField = (typeof requestFields)[number] | `coreBefore.${CoreField}` | `coreAfter.${CoreField}`;
const slotFields = new Array<SlotField>().concat(requestFields,
  coreFields.map(field => `coreBefore.${field}` as const), coreFields.map(field => `coreAfter.${field}` as const));
const slotNames = ["last", "control", "subject"] as const;
const words = headerFields.length + slotNames.length * slotFields.length;
if (words * 8 !== allocationBoundaryBytes) throw new Error("JSC allocation boundary layout drifted");

export type BoundarySlot = Record<SlotField, number | null>;
export interface AllocationBoundary extends Record<(typeof headerFields)[number], number | null> {
  last: BoundarySlot;
  control: BoundarySlot;
  subject: BoundarySlot;
}

// Every key in `names` is assigned, so the record is complete.
function recordOf<K extends string>(names: readonly K[], value: (name: K, index: number) => number | null): Record<K, number | null> {
  const record = {} as Record<K, number | null>;
  names.forEach((name, index) => { record[name] = value(name, index); });
  return record;
}

/** Unobserved slot words (availability bit clear) and unknown values are null; nothing is zero-filled. */
function decodeSlot(data: readonly bigint[], start: number): BoundarySlot {
  const availability = data[start + 1] ?? 0n;
  const observed = (index: number) => index < 2 || ((availability >> BigInt(index)) & 1n) === 1n;
  return recordOf(slotFields, (_, index) => observed(index) ? telemetryCount(data[start + index]) : null);
}

export function decodeAllocationBoundary(data: readonly bigint[]): AllocationBoundary {
  if (data.length !== words) throw new RangeError("Invalid JSC allocation boundary length");
  const slot = (index: number) => decodeSlot(data, headerFields.length + index * slotFields.length);
  return { ...recordOf(headerFields, (_, index) => telemetryCount(data[index])), last: slot(0), control: slot(1), subject: slot(2) };
}

export function readAllocationBoundary(memory: WebAssembly.Memory, exports: WebAssembly.Exports): AllocationBoundary | null {
  const data = readTelemetryRecord(memory, exports, allocationBoundaryExport, allocationBoundaryBytes);
  return data ? decodeAllocationBoundary(data) : null;
}

const prefix = "allocationBoundary";

/** Flat `allocationBoundary.*` engine counters. An absent export adds no keys, so readers see no coverage. */
export const allocationBoundaryCounters: EngineDiagnostics = (memory, exports) => {
  const record = readAllocationBoundary(memory, exports);
  if (!record) return {};
  const counters: Record<string, number | null> = {};
  for (const field of headerFields) counters[`${prefix}.${field}`] = record[field];
  for (const name of slotNames) {
    for (const field of slotFields) counters[`${prefix}.${name}.${field}`] = record[name][field];
  }
  return counters;
};

/** The record carried in a snapshot's engine counters, or null when the process had no reader. */
export function allocationBoundaryFromCounters(counters: Readonly<Record<string, number | null>>): AllocationBoundary | null {
  if (!(`${prefix}.abiVersion` in counters)) return null;
  const value = (key: string) => counters[key] ?? null;
  const slot = (name: (typeof slotNames)[number]) => recordOf(slotFields, field => value(`${prefix}.${name}.${field}`));
  return { ...recordOf(headerFields, field => value(`${prefix}.${field}`)), last: slot("last"), control: slot("control"), subject: slot("subject") };
}
