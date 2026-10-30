import type { Page } from "playwright";
import { emptyCounters, type MemoryCounters, type TelemetryEngine } from "../../web/src/memory-telemetry.ts";

export interface RootInventory {
  authority: "runtime-supervisor";
  complete: true;
  runtimeId: string;
  rootId: string;
  rootPid: number;
  members: readonly { pid: number; parentPid: number; telemetryId: string | null; terminal: boolean }[];
}
type Snapshot = MemoryCounters & { id: string; engine: string; terminal: boolean; time: number };
export type Attribution = { kind: "unknown"; rootId: string | null; reason: string }
  | { kind: "root"; rootId: string; runtimeId: string; rootPid: number };

export async function sample({ page, phase, engine, rootId }: { page: Page; phase: string; engine: TelemetryEngine; rootId?: string }) {
  const refresh = !/fail|error|trap|oom|terminal/i.test(phase);
  const retained: unknown = await page.evaluate(async ({ engine, refresh, rootId }) => {
    const scoped: unknown = Reflect.get(globalThis, "__bunMemorySnapshotEnvelope");
    if (typeof scoped === "function") return await scoped({ engine, refresh, rootId });
    const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
    return typeof getter === "function" ? await getter(engine, refresh) : [];
  }, { engine, refresh, rootId });
  if (Array.isArray(retained)) return selectMemorySnapshots(retained, engine, rootId);
  if (!retained || typeof retained !== "object" || !("processes" in retained) || !Array.isArray(retained.processes)) return selectMemorySnapshots([], engine, rootId);
  return selectMemorySnapshots(retained.processes, engine, rootId, "roots" in retained ? retained.roots : undefined);
}

export function selectMemorySnapshots(all: readonly unknown[], engine: TelemetryEngine, rootId?: string, roots?: unknown) {
  const processes = all.filter(isSnapshot);
  const resolved = resolveAttribution(processes, engine, rootId, roots);
  const attribution = resolved.attribution;
  const attributedProcesses = resolved.inventory ? resolved.inventory.members.flatMap(member => {
    const snapshot = processes.find(process => process.id === member.telemetryId);
    return snapshot ? [snapshot] : [];
  }) : [];
  const activeIds = new Set(resolved.inventory?.members.filter(member => !member.terminal).map(member => member.telemetryId));
  const counters = attribution.kind === "root" ? aggregate(attributedProcesses.filter(process => activeIds.has(process.id))) : { ...emptyCounters };
  const failed = attributedProcesses.find(process => process.failedAllocation !== null);
  return {
    ...counters, memoryLimitBytes: attributedProcesses.length > 1 ? null : counters.memoryLimitBytes,
    failedAllocation: failed?.failedAllocation ?? null, failureProcessId: failed?.id ?? null,
    attribution, processes, rawProcesses: all.slice(), attributedProcesses,
    observedFailures: processes.filter(process => process.failedAllocation !== null)
      .map(process => ({ processId: process.id, engine: process.engine, failedAllocation: process.failedAllocation })),
    notes: attribution.kind === "unknown"
      ? `Aggregate unknown: ${attribution.reason}. Complete raw process observations are preserved. Command order, job identity and timestamps are not process ancestry. Cached engine counters are last-good values, not failure-time heap measurements. No forced GC.`
      : counters.notes,
  };
}
function resolveAttribution(processes: readonly Snapshot[], engine: TelemetryEngine, rootId: string | undefined, roots: unknown): { attribution: Attribution; inventory: RootInventory | null } {
  const unknown = (reason: string) => ({ attribution: { kind: "unknown", rootId: rootId ?? null, reason } satisfies Attribution, inventory: null });
  if (!Array.isArray(roots)) return unknown("authoritative root process inventory is unavailable");
  if (!roots.every(isRootInventory)) return unknown("root inventory is malformed or incomplete");
  if (!rootId) return unknown("caller root identity was not supplied");
  const matches = roots.filter(isRootInventory).filter(root => root.rootId === rootId);
  if (matches.length !== 1) return unknown("caller root inventory is missing or ambiguous");
  const inventory = matches[0]!;
  if (!validAncestry(inventory)) return unknown("root inventory has incomplete or cyclic parent edges");
  const root = processes.find(process => process.id === rootId);
  const rootMember = inventory.members.find(member => member.pid === inventory.rootPid);
  if (!root || rootMember?.telemetryId !== rootId || root.engine !== engine) return unknown("caller root snapshot does not match the authoritative root");
  if (new Set(inventory.members.map(member => member.telemetryId)).size !== inventory.members.length) return unknown("root inventory repeats a telemetry identity");
  if (inventory.members.some(member => member.telemetryId === null || processes.filter(process => process.id === member.telemetryId).length !== 1)) return unknown("root inventory contains a process without unique telemetry");
  return { attribution: { kind: "root", rootId, runtimeId: inventory.runtimeId, rootPid: inventory.rootPid }, inventory };
}
function isRootInventory(value: unknown): value is RootInventory {
  if (!value || typeof value !== "object") return false;
  if (!("complete" in value) || value.complete !== true) return false;
  if (!("authority" in value) || value.authority !== "runtime-supervisor" || !("runtimeId" in value) || typeof value.runtimeId !== "string") return false;
  if (!("rootId" in value) || typeof value.rootId !== "string" || !("rootPid" in value) || !pid(value.rootPid)) return false;
  if (!("members" in value) || !Array.isArray(value.members) || !value.members.length) return false;
  return value.members.every(member => Boolean(member && typeof member === "object" && "pid" in member && pid(member.pid)
    && "parentPid" in member && typeof member.parentPid === "number" && counter(member.parentPid)
    && "telemetryId" in member && (member.telemetryId === null || typeof member.telemetryId === "string")
    && "terminal" in member && typeof member.terminal === "boolean"));
}
function validAncestry(root: RootInventory): boolean {
  const parents = new Map(root.members.map(member => [member.pid, member.parentPid]));
  if (parents.size !== root.members.length || !parents.has(root.rootPid)) return false;
  return root.members.every(member => reachesRoot(member.pid, root.rootPid, parents));
}
function reachesRoot(start: number, rootPid: number, parents: ReadonlyMap<number, number>): boolean {
  const visited = new Set<number>();
  let current = start;
  while (current !== rootPid) {
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = parents.get(current);
    if (parent === undefined || parent === 0) return false;
    current = parent;
  }
  return true;
}

function pid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function counter(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  if (!("id" in value) || typeof value.id !== "string" || !("engine" in value) || typeof value.engine !== "string") return false;
  if (!("terminal" in value) || typeof value.terminal !== "boolean" || !("time" in value) || typeof value.time !== "number") return false;
  const keys = ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"];
  if (!keys.every(key => counter(Reflect.get(value, key)))) return false;
  if (!("failedAllocation" in value) || !("notes" in value) || typeof value.notes !== "string") return false;
  if (value.failedAllocation === null) return true;
  return typeof value.failedAllocation === "object" && "bytes" in value.failedAllocation && counter(value.failedAllocation.bytes)
    && "category" in value.failedAllocation && typeof value.failedAllocation.category === "string";
}

export function aggregate(snapshots: readonly MemoryCounters[]): MemoryCounters {
  if (!snapshots.length) return { ...emptyCounters };
  const sum = (key: Exclude<keyof MemoryCounters, "notes" | "failedAllocation">) => {
    if (snapshots.some(snapshot => snapshot[key] === null)) return null;
    return snapshots.reduce((bytes, snapshot) => bytes + (snapshot[key] ?? 0), 0);
  };
  return {
    wasmCapacityBytes: sum("wasmCapacityBytes"), memoryLimitBytes: snapshots.length === 1 ? snapshots[0]!.memoryLimitBytes : null,
    allocatorLiveBytes: sum("allocatorLiveBytes"), allocatorPeakBytes: sum("allocatorPeakBytes"), jsHeapBytes: sum("jsHeapBytes"),
    arrayBufferBytes: sum("arrayBufferBytes"), swcBytes: sum("swcBytes"), failedAllocation: null,
    notes: "Active members of the explicitly selected root are summed once. Independent process limits are not shared headroom. Peak is an upper bound from individual high-water marks. Terminal and failed members remain in attributedProcesses. Engine counters are cached last-good values. No forced GC.",
  };
}
