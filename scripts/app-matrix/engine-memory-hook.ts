import type { Page } from "playwright";
import { emptyCounters, type MemoryCounters, type MemorySnapshot, type TelemetryEngine } from "../../web/src/memory-telemetry.ts";

export async function sample({ page, phase, engine }: { page: Page; phase: string; engine: TelemetryEngine }): Promise<ReturnType<typeof selectMemorySnapshots>> {
  const refresh = !/fail|error|trap|oom|terminal/i.test(phase);
  const retained: unknown = await page.evaluate(async ({ engine, refresh }) => {
    const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
    return typeof getter === "function" ? await getter(engine, refresh) : [];
  }, { engine, refresh });
  const all: unknown[] = Array.isArray(retained) ? retained : [];
  return selectMemorySnapshots(all, engine);
}

export function selectMemorySnapshots(all: readonly unknown[], engine: TelemetryEngine) {
  const snapshots = all.filter(isSnapshot).filter(snapshot => snapshot.engine === engine);
  const unique = Array.from(new Map(snapshots.map(snapshot => [snapshot.id, snapshot])).values());
  const latest = unique.toSorted((a, b) => b.commandSequence - a.commandSequence)[0];
  const command = unique.filter(snapshot => snapshot.commandId === latest?.commandId);
  const active = command.filter(snapshot => !snapshot.terminal);
  const selected = active.length ? active : command.toSorted((a, b) => b.time - a.time).slice(0, 1);
  const counters = aggregate(selected);
  const failed = command.find(snapshot => snapshot.failedAllocation !== null);
  return { ...counters, memoryLimitBytes: command.length > 1 ? null : counters.memoryLimitBytes, failedAllocation: failed?.failedAllocation ?? null,
    failureProcessId: failed?.id ?? null, processes: command };
}

type HookSnapshot = MemoryCounters & Pick<MemorySnapshot, "id" | "commandId" | "commandStartedAt" | "commandSequence" | "engine" | "terminal" | "time">;
function isSnapshot(value: unknown): value is HookSnapshot {
  if (value === null || typeof value !== "object") return false;
  if (!("id" in value) || typeof value.id !== "string" || !("engine" in value) || typeof value.engine !== "string") return false;
  if (!("terminal" in value) || typeof value.terminal !== "boolean" || !("time" in value) || typeof value.time !== "number") return false;
  if (!("commandId" in value) || typeof value.commandId !== "string" || !("commandStartedAt" in value) || typeof value.commandStartedAt !== "number" || !counter(value.commandStartedAt)) return false;
  if (!("commandSequence" in value) || typeof value.commandSequence !== "number" || !counter(value.commandSequence)) return false;
  const keys = ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"];
  if (!keys.every(key => counter(Reflect.get(value, key)))) return false;
  if (!("failedAllocation" in value) || !("notes" in value) || typeof value.notes !== "string") return false;
  if (value.failedAllocation === null) return true;
  return typeof value.failedAllocation === "object" && "bytes" in value.failedAllocation && counter(value.failedAllocation.bytes)
    && "category" in value.failedAllocation && typeof value.failedAllocation.category === "string";
}
function counter(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function aggregate(snapshots: readonly MemoryCounters[]): MemoryCounters {
  if (!snapshots.length) return { ...emptyCounters };
  const sum = (key: Exclude<keyof MemoryCounters, "notes" | "failedAllocation">) => {
    if (snapshots.some(snapshot => snapshot[key] === null)) return null;
    return snapshots.reduce((bytes, snapshot) => bytes + (snapshot[key] ?? 0), 0);
  };
  return {
    wasmCapacityBytes: sum("wasmCapacityBytes"), memoryLimitBytes: snapshots.length === 1 ? snapshots[0]!.memoryLimitBytes : null,
    allocatorLiveBytes: sum("allocatorLiveBytes"), allocatorPeakBytes: sum("allocatorPeakBytes"),
    jsHeapBytes: sum("jsHeapBytes"), arrayBufferBytes: sum("arrayBufferBytes"), swcBytes: sum("swcBytes"),
    failedAllocation: snapshots.find(snapshot => snapshot.failedAllocation)?.failedAllocation ?? null,
    notes: "Active processes summed once by identity. Independent process limits do not form one shared headroom budget; multiple active processes make the scalar limit unknown. Peak is a sum of per-process high-water marks, not a simultaneous peak. With no live process the latest terminal snapshot is returned. Unknowns propagate. " + snapshots[0]!.notes,
  };
}
