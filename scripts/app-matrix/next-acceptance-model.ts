export type AcceptanceEngine = "quickjs" | "jsc" | "browser";
export type Outcome = { status: "pass"; detail: string } | { status: "fail" | "blocked"; reason: string };
export type PhaseResult = Outcome & { phase: string; engine: AcceptanceEngine; observedEngine: string; durationMs: number; budgetMs: number | null };

export interface MemoryCounters {
  wasmCapacityBytes: number | null;
  memoryLimitBytes: number | null;
  allocatorLiveBytes: number | null;
  allocatorPeakBytes: number | null;
  jsHeapBytes: number | null;
  arrayBufferBytes: number | null;
  swcBytes: number | null;
  failedAllocation: { bytes: number | null; category: string } | null;
  notes: string;
}
export interface MemorySample extends MemoryCounters {
  phase: string;
  engine: AcceptanceEngine;
  time: number;
}
export const emptyMemory: MemoryCounters = {
  wasmCapacityBytes: null, memoryLimitBytes: null, allocatorLiveBytes: null, allocatorPeakBytes: null,
  jsHeapBytes: null, arrayBufferBytes: null, swcBytes: null, failedAllocation: null,
  notes: "Engine attribution hook not provided. Browser process memory is not guest live memory.",
};

export function parseMemory(input: unknown): MemoryCounters {
  if (!input || typeof input !== "object") throw new Error("Memory hook must return counters");
  const counter = (key: string): number | null => {
    const value: unknown = Reflect.get(input, key);
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid byte counter ${key}`);
    return value;
  };
  const failed: unknown = Reflect.get(input, "failedAllocation");
  const notes: unknown = Reflect.get(input, "notes");
  if (typeof notes !== "string") throw new Error("Memory hook notes must be a string");
  if (failed !== null && (!failed || typeof failed !== "object")) throw new Error("Invalid failed allocation");
  return {
    wasmCapacityBytes: counter("wasmCapacityBytes"), memoryLimitBytes: counter("memoryLimitBytes"),
    allocatorLiveBytes: counter("allocatorLiveBytes"), allocatorPeakBytes: counter("allocatorPeakBytes"),
    jsHeapBytes: counter("jsHeapBytes"), arrayBufferBytes: counter("arrayBufferBytes"), swcBytes: counter("swcBytes"),
    failedAllocation: failed === null ? null : allocation(failed), notes,
  };
}

function allocation(input: object): NonNullable<MemoryCounters["failedAllocation"]> {
  const bytes: unknown = Reflect.get(input, "bytes");
  const category: unknown = Reflect.get(input, "category");
  if (bytes !== null && (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)) throw new Error("Invalid failed allocation size");
  if (typeof category !== "string") throw new Error("Invalid failed allocation category");
  return { bytes, category };
}

export function memoryGate(samples: readonly MemorySample[], cycles: number, minHeadroomMiB: number, maxGrowthMiB: number): Outcome {
  if (cycles < 30) return { status: "blocked", reason: `Only ${cycles}/30 complete edit/revert cycles` };
  const retained = samples.filter(sample => /^cycle:\d+:idle$/.test(sample.phase));
  const warm = samples.find(sample => sample.phase === "warm:idle");
  if (!warm || retained.length < 30) return { status: "blocked", reason: "Missing post-warm-up or retained samples" };
  const required = samples.filter(sample => sample.phase === "warm:idle" || sample.phase.startsWith("cycle:") || sample.phase.startsWith("dev:cycle:"));
  if (required.some(sample => sample.wasmCapacityBytes === null || sample.memoryLimitBytes === null || sample.allocatorLiveBytes === null || sample.allocatorPeakBytes === null || sample.jsHeapBytes === null || sample.arrayBufferBytes === null || sample.swcBytes === null)) {
    return { status: "blocked", reason: "Missing capacity/live/peak/heap/ArrayBuffer/SWC attribution; unknown counters cannot pass" };
  }
  const live = (sample: MemorySample) => sample.allocatorLiveBytes ?? 0;
  const retainedCounters = ["allocatorLiveBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"] as const;
  const growing = retainedCounters.filter(key => {
    const tail = retained.slice(-10).map(sample => sample[key] ?? 0);
    const baseline = warm[key] ?? 0;
    const totalGrowth = Math.max(...tail) - baseline;
    const tailGrowth = Math.max(...tail.slice(5)) - Math.min(...tail.slice(0, 5));
    return Math.max(totalGrowth, tailGrowth) > maxGrowthMiB * 1024 * 1024;
  });
  const peaks = required.map(sample => sample.allocatorPeakBytes ?? 0);
  const peak = Math.max(...peaks);
  const headroom = Math.min(...required.map(sample => (sample.memoryLimitBytes ?? 0) - (sample.allocatorPeakBytes ?? 0)));
  const tail = retained.slice(-10).map(live);
  const growth = Math.max(...tail) - live(warm);
  const tailGrowth = Math.max(...tail.slice(5)) - Math.min(...tail.slice(0, 5));
  const MiB = 1024 * 1024;
  const detail = `peak ${(peak / MiB).toFixed(2)} MiB; retained tail ${(Math.max(...tail) / MiB).toFixed(2)} MiB; growth ${(growth / MiB).toFixed(2)} MiB; tail growth ${(tailGrowth / MiB).toFixed(2)} MiB; headroom ${(headroom / MiB).toFixed(2)} MiB`;
  if (headroom < minHeadroomMiB * MiB || growing.length > 0) return { status: "fail", reason: `${detail}; growing counters: ${growing.join(", ") || "none"}` };
  return { status: "pass", detail };
}

export function resultTable(rows: readonly PhaseResult[]): string {
  const clean = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = rows.map(row => `| ${row.engine} | ${clean(row.observedEngine)} | ${row.phase} | ${row.status} | ${row.durationMs} | ${row.budgetMs ?? "n/a"} | ${clean(row.status === "pass" ? row.detail : row.reason)} |`);
  return ["| Engine | Observed | Phase | Result | ms | Watchdog ms | Evidence |", "|---|---|---|---|---:|---:|---|"].concat(lines).join("\n") + "\n";
}
