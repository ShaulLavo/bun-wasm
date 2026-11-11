import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected snapshot object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected snapshot list");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected snapshot text");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected snapshot integer");
  return value;
}
function time(value: unknown): number {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) throw new Error("Invalid snapshot timestamp");
  return timestamp;
}
function optionalTime(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : time(value);
}
function run(value: unknown) {
  const item = record(value);
  return { id: number(item.id), branch: text(item.head_branch), event: text(item.event), status: text(item.status), conclusion: item.conclusion, created: time(item.created_at), updated: time(item.updated_at) };
}
function job(value: unknown) {
  const item = record(value);
  const runner = item.runner_id === null ? 0 : number(item.runner_id);
  return { id: number(item.id), run: number(item.run_id), name: text(item.name), status: text(item.status), conclusion: item.conclusion, created: time(item.created_at), started: runner ? optionalTime(item.started_at) : undefined, completed: optionalTime(item.completed_at) };
}
function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function measureThroughput(value: unknown, start: string, end: string) {
  const snapshot = record(value);
  const observed = time(snapshot.observedAt);
  const windowStart = time(start), windowEnd = time(end);
  if (windowStart >= windowEnd || windowEnd > observed) throw new Error("Measurement window must end by the snapshot time");
  const runs = list(snapshot.runs).map(run);
  const jobs = list(snapshot.jobs).map(job).filter(item => item.conclusion !== "skipped");
  const inWindow = (timestamp: number) => timestamp >= windowStart && timestamp < windowEnd;
  const finished = runs.filter(item => item.status === "completed" && inWindow(item.updated));
  const hours = (windowEnd - windowStart) / 3_600_000;
  const admitted = jobs.flatMap(item => item.started !== undefined ? [{ ...item, started: item.started }] : []);
  const invalid = admitted.filter(item => item.completed === undefined ? item.status !== "in_progress" : item.completed < item.started);
  const valid = admitted.filter(item => item.completed === undefined ? item.status === "in_progress" : item.completed >= item.started);
  const started = valid.filter(item => inWindow(item.started));
  const queue = started.map(item => Math.max(0, (item.started - item.created) / 1000));
  const queued = jobs.filter(item => item.status === "queued" && item.started === undefined);
  const running = jobs.filter(item => item.status === "in_progress");
  const completed = valid.flatMap(item => item.completed !== undefined && inWindow(item.completed) ? [{ ...item, completed: item.completed }] : []);
  return {
    observedAt: new Date(observed).toISOString(), window: { start, end, hours },
    workflowRateBasis: "Workflow updated_at completion proxy; successful runs may skip native checks.",
    completedRuns: finished.filter(item => item.conclusion !== "cancelled").length,
    cancelledRuns: finished.filter(item => item.conclusion === "cancelled").length,
    completedRunsPerHour: finished.filter(item => item.conclusion !== "cancelled").length / hours,
    successfulRunsPerHour: finished.filter(item => item.conclusion === "success").length / hours,
    successfulMainRunsPerHour: finished.filter(item => item.conclusion === "success" && item.event === "push" && item.branch === "main").length / hours,
    queueSeconds: { samples: queue.length, p50: percentile(queue, 0.5), p95: percentile(queue, 0.95), max: queue.length ? queue.reduce((max, value) => Math.max(max, value), 0) : null },
    queuedJobs: queued.map(item => ({ id: item.id, run: item.run, name: item.name, waitingAtLeastSeconds: Math.max(0, (observed - item.created) / 1000) })),
    runningJobs: running.map(item => ({ id: item.id, run: item.run, name: item.name })),
    runnerMinutes: valid.reduce((sum, item) => sum + Math.max(0, Math.min(item.completed ?? observed, windowEnd) - Math.max(item.started, windowStart)) / 60_000, 0),
    completedJobSeconds: completed.map(item => ({ id: item.id, run: item.run, name: item.name, seconds: (item.completed - item.started) / 1000 })),
    invalidJobTimes: invalid.map(item => item.id),
    coverage: { runs: runs.length, jobs: jobs.length },
  };
}

if (import.meta.main) {
  const [path, start, end] = process.argv.slice(2);
  if (!path || !start || !end) throw new Error("Usage: ci-throughput.ts SNAPSHOT_JSON WINDOW_START WINDOW_END");
  console.log(JSON.stringify(measureThroughput(JSON.parse(readFileSync(path, "utf8")), start, end), null, 2));
}
