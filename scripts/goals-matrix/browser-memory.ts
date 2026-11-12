import type { ScopedTransport } from "./transport";
import type { MemoryProcessEnvelope, MemoryProcessRow, MemoryCensus, MemoryOutcome, FailedAllocation, FrozenAllocatorFailure } from "../../web/src/memory-telemetry";

async function browserTrapFacts(): Promise<string> {
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") return "\n\nBrowser core trap memory snapshots unavailable: diagnostic hook is unavailable.\n";
  const snapshots: unknown = await getter("browser", false);
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid Browser memory snapshots");
  const traps = snapshots.filter((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== "object" || !("engine" in snapshot) || snapshot.engine !== "browser" || !("engineCounters" in snapshot)) return false;
    const counters: unknown = snapshot.engineCounters;
    return counters !== null && typeof counters === "object" && "browserCallTrapCapacityBytes" in counters;
  });
  return traps.length ? `\n\nBrowser core trap memory snapshots:\n${JSON.stringify(traps)}\n` : "";
}

/** Read the retained trap observations while the owned host page is still available. */
export async function browserTrapLog(transport: Pick<ScopedTransport, "useHost" | "evaluate">, engine: string): Promise<string> {
  if (engine !== "browser") return "";
  try {
    await transport.useHost();
    return await transport.evaluate<string>(`(${browserTrapFacts.toString()})()`, { observation: true });
  } catch { return "\n\nBrowser core trap memory snapshots unavailable: host observation failed.\n"; }
}

export type ProcessMemoryState = "unbound" | "pending" | "missing" | "invalid" | "read-failed" | "unsupported" | "cached-live" | "failed-request" | "no-failed-request";
export function classifyMemoryProcess(row: MemoryProcessRow): ProcessMemoryState {
  if (!row.binding) return "unbound";
  if (row.status === "invalid" || row.status === "read-failed") return row.status;
  if (row.endedAt === null) return "pending";
  if (row.status !== "sampled") return "missing";
  const sample = row.sample;
  if (!sample || sample.wasmCapacityBytes === null) return "missing";
  if (sample.libcTelemetry?.allocator !== "read" || sample.libcTelemetry.failure !== "read") return "unsupported";
  if (!sample.terminal) return "cached-live";
  return sample.allocatorFailure || sample.frozenAllocatorFailure ? "failed-request" : "no-failed-request";
}
type UnavailableReason = "getter-unavailable" | "shared-buffers-unavailable" | "host-read-failed" | "invalid-observation" | "unsupported-schema" | "output-truncated";
export type EngineMemoryObservation = { status: "unavailable"; reason: UnavailableReason }
  | { status: "observed"; observation: MemoryProcessEnvelope };
const memoryLogPrefix = "\n\nSpiderMonkey process memory observation:\n";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function counter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nullableCounter(value: unknown): value is number | null { return value === null || counter(value); }
function opaqueId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:._-]{1,128}$/.test(value); }
function allocation(value: unknown): value is FailedAllocation | null {
  return value === null || record(value) && nullableCounter(value.bytes) && typeof value.category === "string"
    && /^(none|unknown|libc\.(malloc|calloc|realloc|aligned_alloc|posix_memalign))$/.test(value.category);
}
function frozenAllocation(value: unknown): value is FrozenAllocatorFailure | null {
  if (value === null) return true;
  if (!record(value) || !allocation(value) || value.reason !== "unknown") return false;
  return [value.previousUsableBytes, value.allocatorLiveBytes, value.allocatorPeakBytes, value.wasmCapacityBeforeBytes, value.wasmCapacityAfterBytes].every(nullableCounter);
}
function outcome(value: unknown): value is MemoryOutcome {
  if (!record(value)) return false;
  if (value.kind === "pending") return true;
  if (value.kind === "unavailable") return value.reason === "read-failed" || value.reason === "unbound";
  if (value.kind !== "observed") return false;
  const exit = value.value;
  if (exit === null) return true;
  if (!record(exit) || !counter(exit.code)) return false;
  if (exit.kind === "exited" || exit.kind === "signaled") return counter(exit.status);
  return exit.kind === "start-failed" && exit.status === null && typeof exit.error === "string"
    && ["ENOENT", "EACCES", "ENOTDIR", "ELOOP", "ENOEXEC", "ENOMEM", "EAGAIN", "EIO"].includes(exit.error);
}
function sample(value: unknown): value is NonNullable<MemoryProcessRow["sample"]> {
  if (!record(value) || !counter(value.time) || typeof value.terminal !== "boolean") return false;
  if (![value.wasmCapacityBytes, value.memoryLimitBytes, value.allocatorLiveBytes, value.allocatorPeakBytes].every(nullableCounter)) return false;
  const support = value.libcTelemetry;
  if (support !== undefined && (!record(support) || !["read", "unsupported"].includes(String(support.allocator)) || !["read", "unsupported"].includes(String(support.failure)))) return false;
  return allocation(value.allocatorFailure) && frozenAllocation(value.frozenAllocatorFailure);
}
function processRow(value: unknown): value is MemoryProcessRow {
  if (!record(value) || !opaqueId(value.id) || !["quickjs", "jsc", "browser", "spidermonkey"].includes(String(value.engine))) return false;
  const binding = value.binding;
  if (binding !== null && (!record(binding) || !opaqueId(binding.runtimeId) || ![binding.pid, binding.parentPid, binding.job].every(counter))) return false;
  if (![value.launchedAt, value.launchSequence].every(counter) || ![value.endedAt, value.endSequence].every(nullableCounter)) return false;
  if (!outcome(value.outcome) || !["pending", "sampled", "missing", "invalid", "read-failed"].includes(String(value.status))) return false;
  return value.engineHeap === "unsupported" && (value.sample === null || sample(value.sample));
}
function worker(value: unknown): boolean {
  return record(value) && [value.pid, value.parentPid, value.rootPid, value.job].every(counter) && opaqueId(value.directory)
    && nullableCounter(value.bytes) && (value.engine === null || ["quickjs", "jsc", "browser", "spidermonkey"].includes(String(value.engine)));
}
function census(value: unknown): value is MemoryCensus {
  return record(value) && opaqueId(value.runtimeId) && [value.time, value.sequence, value.truncated, value.unknownBytes].every(counter)
    && ["observed", "not-registered", "disposed", "read-failed"].includes(String(value.state)) && value.aliasing === "uncertain"
    && nullableCounter(value.knownSampledBytesSubtotal) && Array.isArray(value.workers) && value.workers.length <= 128 && value.workers.every(worker);
}
function envelope(value: unknown): value is MemoryProcessEnvelope {
  if (!record(value) || value.schema !== 1 || !counter(value.time) || !counter(value.sequence) || typeof value.sharedBuffers !== "boolean" || typeof value.incomplete !== "boolean") return false;
  if (!Array.isArray(value.processes) || value.processes.length > 256 || !value.processes.every(processRow)) return false;
  if (!Array.isArray(value.runtimes) || value.runtimes.length > 272 || !value.runtimes.every(census)) return false;
  if (!Array.isArray(value.censuses) || value.censuses.length > 16 || !value.censuses.every(cleanupCensus)) return false;
  const loss = value.loss;
  return record(loss) && [loss.active, loss.terminal, loss.runtimes, loss.censuses, loss.outputCensuses, loss.outputWorkerRows, loss.outputProcesses].every(counter);
}
function cleanupCensus(value: unknown): boolean {
  return census(value) && "boundary" in value && value.boundary === "adapter-cleanup" && "telemetryId" in value && opaqueId(value.telemetryId);
}

/** Strip extra boundary data, including arbitrary contexts, before serializing the log. */
function projectObservation(value: MemoryProcessEnvelope): MemoryProcessEnvelope {
  const processes = value.processes.map(row => ({ id: row.id, engine: row.engine, binding: row.binding ? { runtimeId: row.binding.runtimeId,
    pid: row.binding.pid, parentPid: row.binding.parentPid, job: row.binding.job } : null,
    launchedAt: row.launchedAt, launchSequence: row.launchSequence, endedAt: row.endedAt, endSequence: row.endSequence,
    outcome: projectOutcome(row.outcome), status: row.status, sample: projectSample(row.sample), engineHeap: row.engineHeap }));
  return { schema: 1, time: value.time, sequence: value.sequence, sharedBuffers: value.sharedBuffers, incomplete: value.incomplete, processes,
    runtimes: value.runtimes.map(projectCensus), censuses: value.censuses.map(row => ({ ...projectCensus(row), boundary: row.boundary, telemetryId: row.telemetryId })),
    loss: { active: value.loss.active, terminal: value.loss.terminal, runtimes: value.loss.runtimes,
      censuses: value.loss.censuses, outputCensuses: value.loss.outputCensuses, outputWorkerRows: value.loss.outputWorkerRows, outputProcesses: value.loss.outputProcesses } };
}
function projectOutcome(value: MemoryOutcome): MemoryOutcome {
  if (value.kind === "pending") return { kind: "pending" };
  if (value.kind === "unavailable") return { kind: "unavailable", reason: value.reason };
  const exit = value.value;
  if (!exit) return { kind: "observed", value: null };
  return { kind: "observed", value: exit.kind === "start-failed" ? { kind: exit.kind, code: exit.code, status: null, error: exit.error }
    : { kind: exit.kind, code: exit.code, status: exit.status } };
}
function projectSample(value: MemoryProcessRow["sample"]): MemoryProcessRow["sample"] {
  if (!value) return null;
  const frozen = value.frozenAllocatorFailure;
  return { time: value.time, terminal: value.terminal, wasmCapacityBytes: value.wasmCapacityBytes, memoryLimitBytes: value.memoryLimitBytes,
    allocatorLiveBytes: value.allocatorLiveBytes, allocatorPeakBytes: value.allocatorPeakBytes,
    allocatorFailure: value.allocatorFailure ? { bytes: value.allocatorFailure.bytes, category: value.allocatorFailure.category } : null,
    frozenAllocatorFailure: frozen ? { bytes: frozen.bytes, category: frozen.category, previousUsableBytes: frozen.previousUsableBytes,
      allocatorLiveBytes: frozen.allocatorLiveBytes, allocatorPeakBytes: frozen.allocatorPeakBytes, wasmCapacityBeforeBytes: frozen.wasmCapacityBeforeBytes,
      wasmCapacityAfterBytes: frozen.wasmCapacityAfterBytes, reason: "unknown" } : null,
    libcTelemetry: value.libcTelemetry ? { allocator: value.libcTelemetry.allocator, failure: value.libcTelemetry.failure } : undefined };
}
function projectCensus(value: MemoryCensus): MemoryCensus {
  return { runtimeId: value.runtimeId, time: value.time, sequence: value.sequence, state: value.state, truncated: value.truncated,
    unknownBytes: value.unknownBytes, knownSampledBytesSubtotal: value.knownSampledBytesSubtotal, aliasing: value.aliasing,
    workers: value.workers.map(row => ({ pid: row.pid, parentPid: row.parentPid, rootPid: row.rootPid, job: row.job, directory: row.directory, bytes: row.bytes, engine: row.engine })) };
}

export function decodeMemoryObservation(value: unknown): EngineMemoryObservation {
  try {
    if (record(value) && "schema" in value && value.schema !== 1) return { status: "unavailable", reason: "unsupported-schema" };
    if (!envelope(value)) return { status: "unavailable", reason: "invalid-observation" };
    if (!value.sharedBuffers) return { status: "unavailable", reason: "shared-buffers-unavailable" };
    const observation = projectObservation(value);
    if (new TextEncoder().encode(JSON.stringify(observation)).byteLength > 524288) return { status: "unavailable", reason: "output-truncated" };
    return { status: "observed", observation };
  } catch { return { status: "unavailable", reason: "invalid-observation" }; }
}
function retainedProcessFacts(): unknown {
  const getter: unknown = Reflect.get(globalThis, "__bunMemoryProcesses");
  if (typeof getter !== "function") return null;
  return getter();
}
export async function readEngineMemory(transport: Pick<ScopedTransport, "useHost" | "evaluate">): Promise<EngineMemoryObservation> {
  try {
    await transport.useHost();
    const value = await transport.evaluate<unknown>(`(${retainedProcessFacts.toString()})()`, { observation: true });
    return value === null ? { status: "unavailable", reason: "getter-unavailable" } : decodeMemoryObservation(value);
  } catch { return { status: "unavailable", reason: "host-read-failed" }; }
}
export async function engineMemoryLog(transport: Pick<ScopedTransport, "useHost" | "evaluate">, engine: string): Promise<string> {
  if (engine === "browser") return browserTrapLog(transport, engine);
  if (engine !== "spidermonkey") return "";
  const read = await readEngineMemory(transport);
  if (read.status === "unavailable") return memoryLogPrefix + JSON.stringify(read) + "\n";
  const observation = read.observation;
  const serialized = JSON.stringify({ status: "observed", ...observation,
    processes: observation.processes.filter(row => row.engine === "spidermonkey").map(row => ({ ...row, state: classifyMemoryProcess(row) })) });
  if (new TextEncoder().encode(serialized).byteLength > 524288) return memoryLogPrefix + JSON.stringify({ status: "unavailable", reason: "output-truncated" }) + "\n";
  return memoryLogPrefix + serialized + "\n";
}
export function memoryBudgetFallback(engine: string, boundary: "failure" | "final"): string {
  if (engine === "browser") return `\n\nBrowser core trap memory snapshots unavailable within the ${boundary} observation budget.\n`;
  return engine === "spidermonkey" ? memoryLogPrefix + JSON.stringify({ status: "unavailable", reason: "observation-budget" }) + "\n" : "";
}
