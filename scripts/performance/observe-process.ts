import { readFile, readdir } from "node:fs/promises";
import { processTree } from "./lifecycle-process";
import { ownedCommand } from "../goals-matrix/lifetime";

type Reading = { value: string; error: null } | { value: null; error: string };
async function read(path: string): Promise<Reading> {
  try { return { value: await readFile(path, "utf8"), error: null }; }
  catch (error) { return { value: null, error: String(error) }; }
}
export function parseTaskStat(text: string) {
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const numbers = [7, 9, 11, 12, 19].map(index => Number(fields[index]));
  if (end < 0 || fields.length < 20 || numbers.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid proc task stat");
  return { name: text.slice(text.indexOf("(") + 1, end), minorFaults: numbers[0]!, majorFaults: numbers[1]!, userTicks: numbers[2]!, systemTicks: numbers[3]!, startTicks: numbers[4]! };
}
async function task(pid: number, processStartTicks: string, tid: string) {
  const beforeMs = performance.now();
  const [stat, schedstat, status] = await Promise.all([read(`/proc/${pid}/task/${tid}/stat`), read(`/proc/${pid}/task/${tid}/schedstat`), read(`/proc/${pid}/task/${tid}/status`)]);
  return { pid, processStartTicks, tid: Number(tid), beforeMs, afterMs: performance.now(), stat: stat.value === null ? stat : parseTaskStat(stat.value), schedstat, allowedCPUs: status.value === null ? status : /^Cpus_allowed_list:\s*(.+)$/m.exec(status.value)?.[1] ?? null };
}
async function processSample(identity: Awaited<ReturnType<typeof processTree>>["processes"][number]) {
  if (!identity.available || !("pid" in identity) || !identity.pid || !identity.processStartTicks) return { identity, threads: [], memory: null, taskRead: null };
  const pid = identity.pid, start = identity.processStartTicks;
  const [tids, memory] = await Promise.all([readdir(`/proc/${pid}/task`).then(value => ({ value, error: null })).catch(error => ({ value: [], error: String(error) })), read(`/proc/${pid}/smaps_rollup`)]);
  const threads = await Promise.all(tids.value.map(tid => task(pid, start, tid)));
  return { identity, threads, memory, taskRead: tids.error };
}
async function sample(root: number) {
  const beforeMs = performance.now();
  const tree = await processTree(root);
  const [processes, memoryPressure, cpuPressure, meminfo, schedstats] = await Promise.all([
    Promise.all(tree.processes.map(processSample)), read("/proc/pressure/memory"), read("/proc/pressure/cpu"), read("/proc/meminfo"), read("/proc/sys/kernel/sched_schedstats"),
  ]);
  return { beforeMs, afterMs: performance.now(), utc: new Date().toISOString(), processes, host: { memoryPressure, cpuPressure, meminfo, schedstats } };
}
type Sample = Awaited<ReturnType<typeof sample>>;
function summarizeSamples(samples: Sample[], ticksPerSecond: number) {
  const tasks = new Map<string, { first: NonNullable<Sample["processes"][number]["threads"][number]>; last: NonNullable<Sample["processes"][number]["threads"][number]>; observations: number }>();
  for (const row of samples) for (const thread of row.processes.flatMap(process => process.threads)) addTask(tasks, thread);
  const enabled = schedstatsEnabled(samples.map(row => row.host.schedstats));
  const threads = Array.from(tasks, ([identity, row]) => summarizeTask(identity, row, ticksPerSecond));
  const memory = samples.map(row => {
    const values = row.processes.map(process => process.memory?.value ?? null);
    const metric = (name: string) => values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(value ?? "")?.[1] ?? NaN), 0);
    return { beforeMs: row.beforeMs, afterMs: row.afterMs, rssKiB: metric("Rss"), pssKiB: metric("Pss") };
  });
  const intervals = threads.filter(row => row.observedCpuSeconds !== null);
  return { threads, queueControl: { status: "unavailable", provenance: null, schedstatsEnabled: enabled, reason: "No successful wait-counter positive control; queue output disabled on all hosts" }, observedCpuSeconds: intervals.length ? intervals.reduce((sum, row) => sum + (row.observedCpuSeconds ?? 0), 0) : null, memory,
    coverage: "Observed deltas only, between readable samples wholly inside the requested window when supplied. Window edges are uncovered. Newly observed is not newly created. Entire lifetimes, disappearing final reads and tails may be missing. No roles, blocked-parent claim, CPU/wall partition or additive profile decomposition. RSS may double count shared pages. Memory values are concurrent samples, not continuous peaks." };
}
type TaskRow = Sample["processes"][number]["threads"][number];
function addTask(tasks: Map<string, { first: TaskRow; last: TaskRow; observations: number }>, thread: TaskRow) {
  if (!("startTicks" in thread.stat)) return;
  const key = `${thread.pid}:${thread.processStartTicks}:${thread.tid}:${thread.stat.startTicks}`;
  const previous = tasks.get(key);
  tasks.set(key, { first: previous?.first ?? thread, last: thread, observations: (previous?.observations ?? 0) + 1 });
}
export function summarizeTask(identity: string, row: { first: TaskRow; last: TaskRow; observations: number }, ticksPerSecond: number) {
  if (!("userTicks" in row.first.stat) || !("userTicks" in row.last.stat)) throw new Error("Task summary requires stat");
  return { identity, observations: row.observations, firstObservedMs: row.first.beforeMs, lastObservedMs: row.last.afterMs,
    observedMinorFaults: row.observations > 1 ? row.last.stat.minorFaults - row.first.stat.minorFaults : null, observedMajorFaults: row.observations > 1 ? row.last.stat.majorFaults - row.first.stat.majorFaults : null,
    observedCpuSeconds: row.observations > 1 ? (row.last.stat.userTicks + row.last.stat.systemTicks - row.first.stat.userTicks - row.first.stat.systemTicks) / ticksPerSecond : null,
    observedQueueSeconds: null,
    queueReason: "No successful wait-counter positive control; queue output disabled on all hosts",
    endpoints: "First/last readable observations only; final lifetime endpoint is not guaranteed", name: row.first.stat.name };
}
export async function observeProcess(root: number, scope: string, intervalMs = 250) {
  const ticksPerSecond = Number((await ownedCommand(["getconf", "CLK_TCK"])).trim());
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new Error("Unavailable clock tick frequency");
  const samples: Sample[] = [];
  const errors: string[] = [];
  const first = await sample(root);
  const rootIdentity = first.processes.find(row => row.identity.available && row.identity.pid === root)?.identity;
  if (!rootIdentity?.available) throw new Error("Observer root unavailable");
  let stopping = false;
  const capture = async () => {
    try {
      const row = await sample(root);
      if (!row.processes.some(process => process.identity.available && process.identity.pid === root && process.identity.processStartTicks === rootIdentity.processStartTicks)) throw new Error("Observer root exited or identity changed");
      samples.push(row);
    } catch (error) { errors.push(String(error)); }
  };
  samples.push(first);
  const running = (async () => { while (!stopping) { await Bun.sleep(intervalMs); if (!stopping) await capture(); } })();
  return { async stop(window?: { beforeMs: number; afterMs: number }) {
    stopping = true; await running; await capture();
    const included = window ? samples.filter(row => row.beforeMs >= window.beforeMs && row.afterMs <= window.afterMs) : samples;
    return { kind: "proc-polling", scope, window: window ?? null, includedSamples: included.length, rootIdentity, intervalMs, ticksPerSecond, unit: { cpu: "seconds", queue: "seconds", memory: "KiB", clock: "controller performance.now ms" }, samples, errors,
      summary: summarizeSamples(included, ticksPerSecond) };
  } };
}

export function schedstatsEnabled(readings: readonly Reading[]): boolean {
  return readings.length > 1 && readings.every(reading => reading.value?.trim() === "1");
}
