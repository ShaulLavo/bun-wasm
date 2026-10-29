import type { Page } from "playwright";
import { emptyCounters, type MemoryCounters, type MemorySnapshot, type TelemetryEngine } from "../../web/src/memory-telemetry.ts";

export async function sample({ page, phase, engine }: { page: Page; phase: string; engine: TelemetryEngine }): Promise<MemoryCounters & { processes: unknown[] }> {
  const refresh = !/fail|error|trap|oom|terminal/i.test(phase);
  const workers = await Promise.all(page.workers().map(async worker => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([worker.evaluate(refresh => {
        const getter: unknown = Reflect.get(globalThis, "__bunMemoryTelemetry");
        return typeof getter === "function" ? getter(refresh) : null;
      }, refresh), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
    } catch { return null; }
    finally { clearTimeout(timer); }
  }));
  const retained: unknown = await page.evaluate(() => {
    const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
    return typeof getter === "function" ? getter() : [];
  });
  const records: unknown[] = Array.isArray(retained) ? retained : [];
  const all = records.concat(workers.filter(value => value !== null));
  const snapshots = all.filter(isSnapshot).filter(snapshot => snapshot.engine === engine);
  const unique = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const active = Array.from(unique.values()).filter(snapshot => !snapshot.terminal);
  const selected = active.length ? active : Array.from(unique.values()).sort((a, b) => b.time - a.time).slice(0, 1);
  const counters = aggregate(selected);
  return { ...counters, processes: selected };
}

type HookSnapshot = MemoryCounters & Pick<MemorySnapshot, "id" | "engine" | "terminal" | "time">;
function isSnapshot(value: unknown): value is HookSnapshot {
  if (value === null || typeof value !== "object") return false;
  if (!("id" in value) || typeof value.id !== "string" || !("engine" in value) || typeof value.engine !== "string") return false;
  if (!("terminal" in value) || typeof value.terminal !== "boolean" || !("time" in value) || typeof value.time !== "number") return false;
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
    wasmCapacityBytes: sum("wasmCapacityBytes"), memoryLimitBytes: sum("memoryLimitBytes"),
    allocatorLiveBytes: sum("allocatorLiveBytes"), allocatorPeakBytes: sum("allocatorPeakBytes"),
    jsHeapBytes: sum("jsHeapBytes"), arrayBufferBytes: sum("arrayBufferBytes"), swcBytes: sum("swcBytes"),
    failedAllocation: snapshots.find(snapshot => snapshot.failedAllocation)?.failedAllocation ?? null,
    notes: "Active processes summed once by identity. Peak is a sum of per-process high-water marks, not a simultaneous peak. With no live process the latest terminal snapshot is returned. Unknowns propagate. " + snapshots[0]!.notes,
  };
}
