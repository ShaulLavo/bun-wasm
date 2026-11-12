import { createMemoryChannel, createMemoryPublisher, memoryChannelReady, readMemoryChannel, requestMemoryChannel } from "./memory-channel.js";
import { programCoreMemoryLimits, type CoreMemoryLimits } from "../../src/program-memory.ts";
import { isPairedEngine, type Engine } from "../../src/engine-kind.js";
import type { ProcessService } from "waffle";
import type { ProcessExit } from "waffle/proc/types";
export type TelemetryEngine = Engine;
export interface FailedAllocation { bytes: number | null; category: string }
export interface FrozenAllocatorFailure extends FailedAllocation {
  previousUsableBytes: number | null;
  allocatorLiveBytes: number | null;
  allocatorPeakBytes: number | null;
  wasmCapacityBeforeBytes: number | null;
  wasmCapacityAfterBytes: number | null;
  reason: "unknown";
}
export interface MemoryCounters {
  wasmCapacityBytes: number | null;
  memoryLimitBytes: number | null;
  allocatorLiveBytes: number | null;
  allocatorPeakBytes: number | null;
  jsHeapBytes: number | null;
  arrayBufferBytes: number | null;
  swcBytes: number | null;
  failedAllocation: FailedAllocation | null;
  notes: string;
}
export interface MemoryIdentity { id: string; commandId: string; commandStartedAt: number; commandSequence: number; incarnation?: number }
export type MemoryTelemetryTransport = MemoryIdentity & { buffer: SharedArrayBuffer; coreMemoryLimits: CoreMemoryLimits };
export interface MemorySnapshot extends MemoryCounters, MemoryIdentity {
  engine: TelemetryEngine;
  time: number;
  terminal: boolean;
  allocatorFailure: FailedAllocation | null;
  frozenAllocatorFailure: FrozenAllocatorFailure | null;
  engineFailure: FailedAllocation | null;
  engineCounters: Record<string, number | null>;
  libcTelemetry?: { allocator: "read" | "unsupported"; failure: "read" | "unsupported" };
}
export const emptyCounters: MemoryCounters = {
  wasmCapacityBytes: null, memoryLimitBytes: null, allocatorLiveBytes: null, allocatorPeakBytes: null,
  jsHeapBytes: null, arrayBufferBytes: null, swcBytes: null, failedAllocation: null,
  notes: "Memory telemetry unavailable. Unknown counters are null. No forced GC.",
};
const unknown = 0xffffffffffffffffn;
const allocatorCategories = ["none", "libc.malloc", "libc.calloc", "libc.realloc", "libc.aligned_alloc", "libc.posix_memalign"];
const quickjsCategories = ["none", "quickjs.malloc", "quickjs.calloc", "quickjs.realloc", "quickjs.arrayBuffer"];
const jscCategories = ["none", "jsc.typedArray", "jsc.arrayBuffer", "jsc.unsupportedResizableArrayBuffer"];

function count(value: bigint | undefined): number | null {
  if (value === undefined || value === unknown || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function failure(size: bigint | undefined, category: bigint | undefined, names: readonly string[]): FailedAllocation | null {
  if (category === undefined || category === 0n || category === unknown) return null;
  return { bytes: count(size), category: names[Number(category)] ?? `unknown.${category}` };
}

function read(memory: WebAssembly.Memory, exports: WebAssembly.Exports, name: string, bytes: number): bigint[] | null {
  const getter = exports[name];
  if (typeof getter !== "function") return null;
  const raw: unknown = getter();
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < -2147483648 || raw > 0xffffffff) throw new TypeError(`Invalid ${name} pointer`);
  const pointer = raw >>> 0;
  if (!pointer || pointer % 8 || pointer > memory.buffer.byteLength - bytes) throw new RangeError(`Invalid ${name} bounds`);
  const view = new DataView(memory.buffer, pointer, bytes);
  if (view.getBigUint64(0, true) !== 1n || view.getBigUint64(8, true) !== BigInt(bytes)) throw new TypeError(`Invalid ${name} ABI`);
  return Array.from({ length: bytes / 8 }, (_, index) => view.getBigUint64(index * 8, true));
}

function readFrozenAllocatorFailure(data: bigint[] | null): FrozenAllocatorFailure | null {
  if (!data) return null;
  const request = failure(data[2], data[3], allocatorCategories);
  if (!request) return null;
  return { ...request, previousUsableBytes: count(data[4]), allocatorLiveBytes: count(data[5]),
    allocatorPeakBytes: count(data[6]), wasmCapacityBeforeBytes: count(data[7]),
    wasmCapacityAfterBytes: count(data[8]), reason: "unknown" };
}

interface EngineReadout { failure: FailedAllocation | null; heap: number | null; buffers: number | null; counters: Record<string, number | null> }
function engineReadout(engine: TelemetryEngine, memory: WebAssembly.Memory, exports: WebAssembly.Exports): EngineReadout | null {
  if (engine === "quickjs") {
    const data = read(memory, exports, "quickjs_memory_telemetry", 128);
    if (!data) return null;
    return {
      failure: failure(data[8], data[9], quickjsCategories),
      heap: count(data[4]), buffers: count(data[5]),
      counters: { refreshSequence: count(data[2]), mallocBytes: count(data[3]), structuralHeapBytes: count(data[4]),
        arrayBufferBytes: count(data[5]), arrayBufferCount: count(data[6]), countersValid: count(data[11]),
        automaticGcCount: count(data[12]), mallocBytesAfterAutomaticGc: count(data[13]),
        mallocGcThreshold: count(data[14]), currentMallocBytes: count(data[15]) },
    };
  }
  if (engine !== "jsc") return null;
  const data = read(memory, exports, "jsc_memory_telemetry", 192);
  if (!data) return null;
  return {
    failure: failure(data[20], data[21], jscCategories), heap: count(data[3]), buffers: null,
    counters: { refreshSequence: count(data[2]), heapUsedBytes: count(data[3]), heapCapacityBytes: count(data[4]),
      extraMemoryBytes: count(data[5]), gcAccountedArrayBufferBytes: count(data[6]), heapAfterLastCollectionBytes: count(data[7]),
      heapBeforeLastFullCollectionBytes: count(data[8]), heapAfterLastFullCollectionBytes: count(data[9]),
      totalBytesAllocated: count(data[10]), gcMaxHeapSize: count(data[11]), smallHeapSize: count(data[12]), largeHeapSize: count(data[13]),
      gcEnabled: count(data[14]), generationalGcEnabled: count(data[15]), concurrentGcEnabled: count(data[16]),
      allocationSequence: count(data[17]), activeAllocationBytes: count(data[18]), activeAllocationCategory: count(data[19]),
      failedAllocationSequence: count(data[22]), allocationBudgetThisCycle: count(data[23]) },
  };
}

export { read as readTelemetryRecord, count as telemetryCount };
/** Opt-in cached side diagnostics merged into engine counters; loaded separately from this reader. */
export type EngineDiagnostics = (memory: WebAssembly.Memory, exports: WebAssembly.Exports) => Record<string, number | null>;

/** `limitBytes` is the core's declared memory maximum (crates/bunwasm-cli/max-memory.txt at link time). */
export function createMemoryReader(engine: TelemetryEngine, core: WebAssembly.Instance, side: WebAssembly.Instance | undefined, limitBytes: number | null, identity?: MemoryIdentity, diagnostics?: EngineDiagnostics, memory: unknown = core.exports.memory) {
  const id = identity?.id ?? crypto.randomUUID();
  const provenance = identity ? { id, commandId: identity.commandId, commandStartedAt: identity.commandStartedAt, commandSequence: identity.commandSequence, incarnation: identity.incarnation }
    : { id, commandId: id, commandStartedAt: Date.now(), commandSequence: 0 };
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError("Missing telemetry memory");
  let terminal = false;
  let failed = false;
  return {
    sample(refresh = false): MemorySnapshot {
      let data = engineReadout(engine, memory, side?.exports ?? {});
      const allocator = read(memory, core.exports, "bun_memory_telemetry", 80);
      const allocatorFailure = allocator ? failure(allocator[4], allocator[5], allocatorCategories) : null;
      const frozenRecord = read(memory, core.exports, "bun_memory_failure_telemetry", 72);
      const frozenAllocatorFailure = readFrozenAllocatorFailure(frozenRecord);
      failed ||= Boolean(allocatorFailure || frozenAllocatorFailure || data?.failure);
      if (refresh && !terminal && !failed && data !== null) {
        const getter = side?.exports[`${engine}_memory_telemetry_refresh`];
        if (typeof getter === "function") {
          failed = true;
          getter();
          failed = false;
        }
        data = engineReadout(engine, memory, side?.exports ?? {});
      }
      return {
        ...emptyCounters, ...provenance, engine, terminal, time: Date.now(),
        libcTelemetry: { allocator: allocator ? "read" : "unsupported", failure: frozenRecord ? "read" : "unsupported" },
        wasmCapacityBytes: memory.buffer.byteLength,
        memoryLimitBytes: allocator ? limitBytes : null,
        allocatorLiveBytes: allocator ? count(allocator[2]) : null,
        allocatorPeakBytes: allocator ? count(allocator[3]) : null,
        jsHeapBytes: data?.heap ?? null, arrayBufferBytes: data?.buffers ?? null,
        failedAllocation: data?.failure ?? allocatorFailure, allocatorFailure, frozenAllocatorFailure, engineFailure: data?.failure ?? null,
        engineCounters: diagnostics ? Object.assign({}, data?.counters, diagnostics(memory, side?.exports ?? {})) : data?.counters ?? {},
        notes: "Allocator counts outstanding libc usable bytes, including padding, from successful outer allocation calls. Realloc internal temporary peaks are not observed. VM counters overlap allocator bytes. JSC heap and ArrayBuffer counters are GC-accounted estimates; exact JSC backing stores and SWC bytes are unknown. Cached engine counters reflect the last normal refresh. No forced GC.",
      };
    },
    finish() { terminal = true; return this.sample(false); },
  };
}

const retained = new Map<string, MemorySnapshot>();
const channels = new Map<string, SharedArrayBuffer>();
const runtimes = new WeakMap<object, string>();
const commandTimes = new Map<string, number>();
const commandOrders = new Map<string, number>();
let commandSequence = 0;
export function memoryRuntimeId(runtime: object): string {
  const identity = runtimes.get(runtime) ?? crypto.randomUUID();
  runtimes.set(runtime, identity);
  return identity;
}
export function memoryCommandId(runtime: object, job: number): string {
  return `${memoryRuntimeId(runtime)}:${job}`;
}
export function beginMemorySnapshot(engine: TelemetryEngine, id: string, commandId = id, module?: WebAssembly.Module): MemoryTelemetryTransport | undefined {
  const commandStartedAt = commandTimes.get(commandId) ?? Date.now();
  commandTimes.set(commandId, commandStartedAt);
  const order = commandOrders.get(commandId) ?? ++commandSequence;
  commandOrders.set(commandId, order);
  const identity = { id, commandId, commandStartedAt, commandSequence: order, incarnation: ++observationSequence };
  retained.set(id, { ...emptyCounters, ...identity, engine, time: Date.now(), terminal: false,
    allocatorFailure: null, frozenAllocatorFailure: null, engineFailure: null, engineCounters: {} });
  beginProcessObservation(id, engine);
  trimTerminalSnapshots();
  if (typeof SharedArrayBuffer !== "function") return;
  const channel = createMemoryChannel();
  channels.set(id, channel);
  const coreMemoryLimits = module ? programCoreMemoryLimits(module) : { declaredMaximumBytes: null, factoryMaximumBytes: null };
  return { ...identity, buffer: channel, coreMemoryLimits };
}

export function publishBrowserCallTrap(instance: WebAssembly.Instance, index: number, transport: MemoryTelemetryTransport, post: (message: { type: "bun-memory"; snapshot: MemorySnapshot }) => void): void {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) return;
  const { id, commandId, commandStartedAt, commandSequence, incarnation, coreMemoryLimits } = transport;
  const snapshot: MemorySnapshot = {
    ...emptyCounters, id, commandId, commandStartedAt, commandSequence, incarnation, engine: "browser", time: Date.now(), terminal: false,
    wasmCapacityBytes: memory.buffer.byteLength, memoryLimitBytes: coreMemoryLimits.factoryMaximumBytes,
    allocatorFailure: null, frozenAllocatorFailure: null, engineFailure: null,
    engineCounters: { browserCallTrapIndex: index, browserCallTrapCapacityBytes: memory.buffer.byteLength,
      browserCoreDeclaredMaximumBytes: coreMemoryLimits.declaredMaximumBytes, browserCoreFactoryMaximumBytes: coreMemoryLimits.factoryMaximumBytes },
    notes: "Browser bunwasm_call trap, observed before disposal. Declared maximum comes from compiled core source. Factory maximum equals the declaration only for module-defined memory; otherwise unknown. Null means unknown. Capacity does not establish the allocator growth request, remaining usable capacity, or refusal reason.",
  };
  createMemoryPublisher(transport.buffer, { sample: () => snapshot, finish: () => snapshot }).capture(false, true);
  post({ type: "bun-memory", snapshot });
}
export function endMemorySnapshot(id: string, outcome?: () => ProcessExit | null): void {
  try { finishProcessObservation(id, outcome); }
  catch { observationError(id, "read-failed"); }
  finally { channels.delete(id); }
}

export function recordMemorySnapshot(message: unknown, expectedId?: string): boolean {
  try {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "bun-memory") return false;
    const value: unknown = Reflect.get(message, "snapshot");
    acceptProcessSnapshot(value, expectedId);
  } catch { if (expectedId) observationError(expectedId, "invalid"); }
  return true;
}

function trimTerminalSnapshots(): void {
  trimProcessObservations();
}
export function retainedMemorySnapshots(): readonly MemorySnapshot[] { return Array.from(retained.values()); }

function isMemorySnapshot(value: object): value is MemorySnapshot {
  const stringKeys = ["id", "notes", "commandId"];
  const order: unknown = Reflect.get(value, "commandSequence");
  if (typeof order !== "number" || !isCounter(order)) return false;
  const startedAt: unknown = Reflect.get(value, "commandStartedAt");
  if (typeof startedAt !== "number" || !isCounter(startedAt)) return false;
  const incarnation: unknown = Reflect.get(value, "incarnation");
  if (incarnation !== undefined && (typeof incarnation !== "number" || !isCounter(incarnation))) return false;
  const byteKeys = ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"];
  if (!stringKeys.every(key => typeof Reflect.get(value, key) === "string" && Reflect.get(value, key).length <= 8192)) return false;
  if (!byteKeys.every(key => isCounter(Reflect.get(value, key)))) return false;
  if (!["failedAllocation", "allocatorFailure", "engineFailure"].every(key => isFailure(Reflect.get(value, key)))) return false;
  if (!isFrozenAllocatorFailure(Reflect.get(value, "frozenAllocatorFailure"))) return false;
  const engine: unknown = Reflect.get(value, "engine");
  if (engine !== "browser" && !isPairedEngine(engine)) return false;
  const time: unknown = Reflect.get(value, "time");
  if (typeof Reflect.get(value, "terminal") !== "boolean" || typeof time !== "number" || !isCounter(time)) return false;
  const counters: unknown = Reflect.get(value, "engineCounters");
  const support: unknown = Reflect.get(value, "libcTelemetry");
  if (support !== undefined && (!support || typeof support !== "object"
    || !["read", "unsupported"].includes(Reflect.get(support, "allocator")) || !["read", "unsupported"].includes(Reflect.get(support, "failure")))) return false;
  return counters !== null && typeof counters === "object" && Object.keys(counters).length <= 1024
    && Object.keys(counters).every(key => key.length <= 128) && Object.values(counters).every(isCounter);
}
function isCounter(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFailure(value: unknown): value is FailedAllocation | null {
  if (value === null) return true;
  return typeof value === "object" && "bytes" in value && isCounter(value.bytes)
    && "category" in value && typeof value.category === "string" && value.category.length <= 128;
}
function isFrozenAllocatorFailure(value: unknown): value is FrozenAllocatorFailure | null {
  if (value === null) return true;
  if (!isFailure(value) || typeof value !== "object") return false;
  if (Reflect.get(value, "reason") !== "unknown") return false;
  return ["previousUsableBytes", "allocatorLiveBytes", "allocatorPeakBytes", "wasmCapacityBeforeBytes", "wasmCapacityAfterBytes"]
    .every(key => isCounter(Reflect.get(value, key)));
}

export const memoryObservationLimits = { active: 128, terminal: 128, runtimes: 16, censuses: 16, workers: 128, outputBytes: 524288 } as const;
type MemoryProcessBinding = { runtimeId: string; pid: number; parentPid: number; job: number };
export type MemoryOutcome = { kind: "pending" } | { kind: "observed"; value: ProcessExit | null }
  | { kind: "unavailable"; reason: "read-failed" | "unbound" };
type SampleStatus = "pending" | "sampled" | "missing" | "invalid" | "read-failed";
interface ProcessObservation {
  id: string;
  engine: Engine;
  binding: MemoryProcessBinding | null;
  launchedAt: number;
  launchSequence: number;
  endedAt: number | null;
  endSequence: number | null;
  outcome: MemoryOutcome;
  outcomeBoundary: "revocation" | "adapter-cleanup" | null;
  status: SampleStatus;
  sample: MemorySnapshot | null;
}
export type MemoryProcessRow = Omit<ProcessObservation, "sample"> & {
  sample: Pick<MemorySnapshot, "time" | "terminal" | "wasmCapacityBytes" | "memoryLimitBytes" | "allocatorLiveBytes" | "allocatorPeakBytes"
    | "allocatorFailure" | "frozenAllocatorFailure" | "libcTelemetry"> | null;
  engineHeap: "unsupported";
};
type MemoryWorker = { pid: number; parentPid: number; rootPid: number; job: number; directory: string; bytes: number | null; engine: Engine | null };
export type MemoryCensus = {
  runtimeId: string;
  time: number;
  sequence: number;
  state: "observed" | "not-registered" | "disposed" | "read-failed";
  workers: MemoryWorker[];
  truncated: number;
  unknownBytes: number;
  knownSampledBytesSubtotal: number | null;
  aliasing: "uncertain";
};
type CleanupCensus = MemoryCensus & { boundary: "adapter-cleanup"; telemetryId: string };
export interface MemoryProcessEnvelope {
  schema: 1;
  time: number;
  sequence: number;
  sharedBuffers: boolean;
  processes: MemoryProcessRow[];
  runtimes: MemoryCensus[];
  censuses: CleanupCensus[];
  loss: { active: number; terminal: number; runtimes: number; censuses: number; outputCensuses: number; outputWorkerRows: number; outputProcesses: number };
  incomplete: boolean;
}
const processes = new Map<string, ProcessObservation>();
const services = new Map<string, { runtime: WeakRef<{ readonly disposed: boolean }>; service: WeakRef<Pick<ProcessService, "workerMemory">> }>();
const censuses: CleanupCensus[] = [];
const observationLoss = { active: 0, terminal: 0, runtimes: 0, censuses: 0 };
let observationSequence = 0;

function beginProcessObservation(id: string, engine: Engine): void {
  const previous = processes.get(id);
  processes.set(id, { id, engine, binding: previous?.endedAt === null ? previous.binding : null,
    launchedAt: previous?.endedAt === null ? previous.launchedAt : Date.now(),
    launchSequence: previous?.endedAt === null ? previous.launchSequence : ++observationSequence,
    endedAt: null, endSequence: null, outcome: { kind: "pending" }, outcomeBoundary: null, status: "pending", sample: null });
}

/** Launcher entry only. No runtime activation; references held by diagnostics are weak. */
export function registerMemoryProcess(engine: Engine, id: string, runtime: { readonly disposed: boolean },
  process: { pid: number; parentPid: number; job: number }, service: Pick<ProcessService, "workerMemory">): void {
  try {
    if (!opaqueObservationId(id)) { observationLoss.active++; return; }
    const runtimeId = memoryRuntimeId(runtime);
    beginProcessObservation(id, engine);
    const row = processes.get(id);
    if (row) row.binding = { runtimeId, pid: process.pid, parentPid: process.parentPid, job: process.job };
    services.set(runtimeId, { runtime: new WeakRef(runtime), service: new WeakRef(service) });
    trimRuntimeServices();
    trimProcessObservations();
  } catch { /* Diagnostics cannot change launch admission. */ }
}
function trimRuntimeServices(): void {
  if (services.size <= memoryObservationLimits.runtimes) return;
  const oldest = services.keys().next().value;
  if (oldest !== undefined) services.delete(oldest);
  observationLoss.runtimes++;
}

function observationError(id: string, status: "invalid" | "read-failed"): void {
  const row = processes.get(id);
  if (row && row.endedAt === null) row.status = status;
}
export function observeMemoryOutcome(id: string, readOutcome: () => ProcessExit | null): void {
  try {
    const row = processes.get(id);
    if (row && row.endedAt === null) readProcessOutcome(row, readOutcome, "revocation");
  } catch { /* A diagnostic read cannot interfere with revocation. */ }
}
function readProcessOutcome(row: ProcessObservation, readOutcome: () => ProcessExit | null, boundary: "revocation" | "adapter-cleanup"): void {
  if (row.outcome.kind === "observed" && row.outcome.value !== null) return;
  try { row.outcome = { kind: "observed", value: readOutcome() }; }
  catch { row.outcome = { kind: "unavailable", reason: "read-failed" }; }
  row.outcomeBoundary = boundary;
}

function acceptProcessSnapshot(value: unknown, expectedId?: string): void {
  if (!value || typeof value !== "object" || !isMemorySnapshot(value)) {
    if (expectedId) observationError(expectedId, "invalid");
    return;
  }
  const id = expectedId ?? value.id;
  const previous = retained.get(id);
  const row = processes.get(id);
  if (!previous || !row || row.endedAt !== null) return;
  if (value.id !== id || value.engine !== previous.engine || value.commandId !== previous.commandId
    || value.commandSequence !== previous.commandSequence || value.commandStartedAt !== previous.commandStartedAt || value.incarnation !== previous.incarnation) {
    observationError(id, "invalid");
    return;
  }
  if (row.sample?.terminal || row.sample && value.time < row.sample.time) return;
  retained.set(id, value);
  row.sample = value;
  row.status = "sampled";
}

function finishProcessObservation(id: string, readOutcome?: () => ProcessExit | null): void {
  const row = processes.get(id);
  if (!row || row.endedAt !== null) return;
  const channel = channels.get(id);
  try {
    const value = channel ? readMemoryChannel(channel) : null;
    if (value !== null) acceptProcessSnapshot(value, id);
  } catch { observationError(id, "read-failed"); }
  if (row.status === "pending") row.status = "missing";
  if (readOutcome) readProcessOutcome(row, readOutcome, "adapter-cleanup");
  else if (row.outcome.kind !== "observed" || row.outcome.value === null) row.outcome = { kind: "unavailable", reason: "unbound" };
  row.endedAt = Date.now();
  row.endSequence = ++observationSequence;
  const snapshot = retained.get(id);
  if (snapshot) retained.set(id, { ...snapshot, terminal: true, time: row.endedAt });
  if (row.binding && adverseObservation(row)) retainCleanupCensus(row.binding.runtimeId, id);
  trimProcessObservations();
}

function adverseObservation(row: ProcessObservation): boolean {
  if (row.sample?.allocatorFailure || row.sample?.frozenAllocatorFailure || row.sample?.failedAllocation) return true;
  if (row.outcome.kind === "unavailable") return true;
  if (row.outcome.kind !== "observed" || !row.outcome.value) return false;
  return row.outcome.value.kind !== "exited" || row.outcome.value.code !== 0;
}

function evictProcess(id: string, row: ProcessObservation): void {
  const commandId = retained.get(id)?.commandId;
  processes.delete(id);
  retained.delete(id);
  channels.delete(id);
  observationLoss[row.endedAt === null ? "active" : "terminal"]++;
  if (commandId && !Array.from(retained.values()).some(value => value.commandId === commandId)) {
    commandTimes.delete(commandId);
    commandOrders.delete(commandId);
  }
}

function trimProcessObservations(): void {
  for (const terminal of [false, true]) {
    const rows = Array.from(processes).filter(([, row]) => (row.endedAt !== null) === terminal);
    const excess = rows.length - memoryObservationLimits[terminal ? "terminal" : "active"];
    for (const [id, row] of rows.slice(0, Math.max(0, excess))) evictProcess(id, row);
  }
}

function workerEngine(runtimeId: string, pid: number): Engine | null {
  for (const row of processes.values()) if (row.binding?.runtimeId === runtimeId && row.binding.pid === pid) return row.engine;
  return null;
}

function runtimeCensus(runtimeId: string): MemoryCensus {
  const base: MemoryCensus = { runtimeId, time: Date.now(), sequence: observationSequence, state: "not-registered", workers: [],
    truncated: 0, unknownBytes: 0, knownSampledBytesSubtotal: null, aliasing: "uncertain" };
  try {
    const registered = services.get(runtimeId);
    if (!registered) return base;
    const runtime = registered.runtime.deref();
    if (!runtime || runtime.disposed) return { ...base, state: "disposed" };
    const service = registered.service.deref();
    if (!service) return base;
    const workers = service.workerMemory();
    base.state = "observed";
    base.truncated = Math.max(0, workers.length - memoryObservationLimits.workers);
    base.workers = workers.slice(0, memoryObservationLimits.workers).map(worker => censusWorker(runtimeId, worker));
    base.unknownBytes = base.workers.filter(worker => worker.bytes === null).length;
    base.knownSampledBytesSubtotal = base.workers.reduce((sum, worker) => sum + (worker.bytes ?? 0), 0);
    return base;
  } catch { return { ...base, state: "read-failed", workers: [], knownSampledBytesSubtotal: null }; }
}
function censusWorker(runtimeId: string, worker: ReturnType<ProcessService["workerMemory"]>[number]): MemoryWorker {
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(worker.directory)) throw new TypeError("Invalid worker memory identity");
  return { pid: worker.pid, parentPid: worker.parentPid, rootPid: worker.rootPid, job: worker.job,
    directory: worker.directory, bytes: worker.bytes, engine: workerEngine(runtimeId, worker.pid) };
}

function retainCleanupCensus(runtimeId: string, telemetryId: string): void {
  censuses.push({ ...runtimeCensus(runtimeId), sequence: ++observationSequence, boundary: "adapter-cleanup", telemetryId });
  if (censuses.length <= memoryObservationLimits.censuses) return;
  censuses.shift();
  observationLoss.censuses++;
}

function projectProcess(row: ProcessObservation): MemoryProcessRow {
  const sample = row.sample;
  return { ...row, binding: row.binding ? { ...row.binding } : null, outcome: structuredClone(row.outcome), engineHeap: "unsupported", sample: sample ? { time: sample.time, terminal: sample.terminal,
    wasmCapacityBytes: sample.wasmCapacityBytes, memoryLimitBytes: sample.memoryLimitBytes, allocatorLiveBytes: sample.allocatorLiveBytes,
    allocatorPeakBytes: sample.allocatorPeakBytes, allocatorFailure: projectFailure(sample.allocatorFailure),
    frozenAllocatorFailure: projectFrozenFailure(sample.frozenAllocatorFailure), libcTelemetry: sample.libcTelemetry ? { ...sample.libcTelemetry } : undefined } : null };
}
function projectFailure(value: FailedAllocation | null): FailedAllocation | null {
  return value ? { bytes: value.bytes, category: allocatorCategories.includes(value.category) ? value.category : "unknown" } : null;
}
function projectFrozenFailure(value: FrozenAllocatorFailure | null): FrozenAllocatorFailure | null {
  if (!value) return null;
  return { bytes: value.bytes, category: allocatorCategories.includes(value.category) ? value.category : "unknown",
    previousUsableBytes: value.previousUsableBytes, allocatorLiveBytes: value.allocatorLiveBytes, allocatorPeakBytes: value.allocatorPeakBytes,
    wasmCapacityBeforeBytes: value.wasmCapacityBeforeBytes, wasmCapacityAfterBytes: value.wasmCapacityAfterBytes, reason: "unknown" };
}

/** Synchronous cached samples plus registered service reads. Never requests a guest sample. */
export function retainedMemoryProcesses(): MemoryProcessEnvelope {
  const result: MemoryProcessEnvelope = { schema: 1, time: Date.now(), sequence: observationSequence, sharedBuffers: typeof SharedArrayBuffer === "function",
    processes: [], runtimes: [], censuses: [], loss: { ...observationLoss, outputCensuses: 0, outputWorkerRows: 0, outputProcesses: 0 }, incomplete: true };
  try {
    const rows = Array.from(processes.values());
    result.processes = rows.filter(row => opaqueObservationId(row.id)).map(projectProcess);
    result.loss.outputProcesses = rows.length - result.processes.length;
    const ids = new Set(Array.from(services.keys()).concat(result.processes.flatMap(row => row.binding ? [row.binding.runtimeId] : [])));
    result.runtimes = Array.from(ids, runtimeCensus);
    result.censuses = structuredClone(censuses);
    while (serializedBytes(result) > memoryObservationLimits.outputBytes && result.censuses.length) {
      result.censuses.shift();
      result.loss.outputCensuses++;
    }
    trimOutputWorkers(result);
    while (serializedBytes(result) > memoryObservationLimits.outputBytes && result.processes.length) {
      result.processes.shift();
      result.loss.outputProcesses++;
    }
    result.incomplete = services.size === 0 || Object.values(result.loss).some(Boolean)
      || result.processes.some(row => !row.binding || row.status !== "sampled" || row.endedAt !== null && (row.outcome.kind === "unavailable" || !row.sample?.terminal))
      || result.runtimes.concat(result.censuses).some(census => census.state !== "observed" || census.truncated > 0 || census.unknownBytes > 0);
  } catch { /* A partially available observation still attributes nothing outside its rows. */ }
  return result;
}
function opaqueObservationId(id: string): boolean { return /^[A-Za-z0-9:._-]{1,128}$/.test(id); }
function serializedBytes(value: MemoryProcessEnvelope): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function trimOutputWorkers(result: MemoryProcessEnvelope): void {
  for (const runtime of result.runtimes) {
    if (serializedBytes(result) <= memoryObservationLimits.outputBytes) return;
    result.loss.outputWorkerRows += runtime.workers.length;
    runtime.truncated += runtime.workers.length;
    runtime.workers = [];
    runtime.unknownBytes = 0;
    runtime.knownSampledBytesSubtotal = runtime.state === "observed" ? 0 : null;
  }
}
Reflect.set(globalThis, "__bunMemoryProcesses", retainedMemoryProcesses);

async function requestMemorySnapshots(engine: TelemetryEngine, refresh: boolean): Promise<readonly MemorySnapshot[]> {
  const requested = Array.from(channels, ([id, channel]) => ({ id, channel, commandId: retained.get(id)?.commandId }))
    .filter(entry => retained.get(entry.id)?.engine === engine && !retained.get(entry.id)?.terminal)
    .map(entry => ({ ...entry, generation: requestMemoryChannel(entry.channel, refresh) }));
  for (let attempt = 0; attempt < 40; attempt++) {
    if (requested.every(entry => memoryChannelReady(entry.channel, entry.generation, refresh) || retained.get(entry.id)?.terminal)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  for (const entry of requested) {
    const record = retained.get(entry.id);
    if (!record || record.terminal || record.commandId !== entry.commandId || channels.get(entry.id) !== entry.channel) continue;
    const value: unknown = readMemoryChannel(entry.channel);
    if (!value || typeof value !== "object" || !isMemorySnapshot(value)) {
      const previous = retained.get(entry.id);
      if (previous) retained.set(entry.id, { ...previous, ...emptyCounters, failedAllocation: previous.failedAllocation });
      continue;
    }
    if (value.id !== entry.id || value.engine !== engine) throw new TypeError("Memory channel identity mismatch");
    acceptProcessSnapshot(value, entry.id);
    const current = memoryChannelReady(entry.channel, entry.generation, false);
    if (!current) {
      retained.set(entry.id, { ...value, ...emptyCounters, failedAllocation: value.failedAllocation,
        notes: "Host snapshot was not acknowledged for this phase. " + value.notes });
      continue;
    }
    const normal = memoryChannelReady(entry.channel, entry.generation, refresh);
    retained.set(entry.id, normal || !refresh ? value : { ...value, jsHeapBytes: null, arrayBufferBytes: null,
      notes: "Normal phase refresh not acknowledged. Engine counters are unavailable for this phase. " + value.notes });
  }
  return retainedMemorySnapshots();
}
Reflect.set(globalThis, "__bunMemorySnapshots", requestMemorySnapshots);
