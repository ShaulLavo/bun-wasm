import { createMemoryChannel, memoryChannelReady, readMemoryChannel, requestMemoryChannel } from "./memory-channel.js";
export type TelemetryEngine = "quickjs" | "jsc" | "browser" | "hermes";
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
export interface MemoryIdentity { id: string; commandId: string; commandStartedAt: number; commandSequence: number }
export type MemoryTelemetryTransport = MemoryIdentity & { buffer: SharedArrayBuffer };
export interface MemorySnapshot extends MemoryCounters, MemoryIdentity {
  engine: TelemetryEngine;
  time: number;
  terminal: boolean;
  allocatorFailure: FailedAllocation | null;
  frozenAllocatorFailure: FrozenAllocatorFailure | null;
  engineFailure: FailedAllocation | null;
  engineCounters: Record<string, number | null>;
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

function readFrozenAllocatorFailure(memory: WebAssembly.Memory, exports: WebAssembly.Exports): FrozenAllocatorFailure | null {
  const data = read(memory, exports, "bun_memory_failure_telemetry", 72);
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
  if (engine === "hermes") {
    const data = read(memory, exports, "hermes_memory_telemetry", 64);
    if (!data) return null;
    const valid = data[6] === 1n;
    const heap = valid ? count(data[3]) : null;
    return {
      failure: null, heap, buffers: null,
      counters: { refreshSequence: count(data[2]), heapUsedBytes: heap,
        heapCapacityBytes: valid ? count(data[4]) : null, externalBytes: valid ? count(data[5]) : null,
        countersValid: count(data[6]), refreshDisabled: count(data[7]) },
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
export function createMemoryReader(engine: TelemetryEngine, core: WebAssembly.Instance, side: WebAssembly.Instance | undefined, limitBytes: number | null, identity?: MemoryIdentity, diagnostics?: EngineDiagnostics) {
  const id = identity?.id ?? crypto.randomUUID();
  const provenance = identity ? { id, commandId: identity.commandId, commandStartedAt: identity.commandStartedAt, commandSequence: identity.commandSequence }
    : { id, commandId: id, commandStartedAt: Date.now(), commandSequence: 0 };
  const memory = core.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError("Missing telemetry memory");
  let terminal = false;
  let failed = false;
  return {
    sample(refresh = false): MemorySnapshot {
      let data = engineReadout(engine, memory, side?.exports ?? {});
      const allocator = read(memory, core.exports, "bun_memory_telemetry", 80);
      const allocatorFailure = allocator ? failure(allocator[4], allocator[5], allocatorCategories) : null;
      const frozenAllocatorFailure = readFrozenAllocatorFailure(memory, core.exports);
      failed ||= Boolean(allocatorFailure || frozenAllocatorFailure || data?.failure);
      if (refresh && !terminal && !failed) {
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
        wasmCapacityBytes: memory.buffer.byteLength,
        memoryLimitBytes: allocator ? limitBytes : null,
        allocatorLiveBytes: allocator ? count(allocator[2]) : null,
        allocatorPeakBytes: allocator ? count(allocator[3]) : null,
        jsHeapBytes: data?.heap ?? null, arrayBufferBytes: data?.buffers ?? null,
        failedAllocation: data?.failure ?? allocatorFailure, allocatorFailure, frozenAllocatorFailure, engineFailure: data?.failure ?? null,
        engineCounters: diagnostics ? Object.assign({}, data?.counters, diagnostics(memory, side?.exports ?? {})) : data?.counters ?? {},
        notes: "Allocator counts outstanding libc usable bytes, including padding, from successful outer allocation calls. Realloc internal temporary peaks are not observed. VM counters overlap allocator bytes. JSC heap and ArrayBuffer counters are GC-accounted estimates; exact JSC backing stores and SWC bytes are unknown. Hermes heap includes allocated objects that may be unreachable; external bytes are GC-accounted, not an exact ArrayBuffer census. Cached engine counters reflect the last normal refresh. No forced GC.",
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
export function memoryCommandId(runtime: object, job: number): string {
  const identity = runtimes.get(runtime) ?? crypto.randomUUID();
  runtimes.set(runtime, identity);
  return `${identity}:${job}`;
}
export function beginMemorySnapshot(engine: TelemetryEngine, id: string, commandId = id): MemoryTelemetryTransport | undefined {
  const commandStartedAt = commandTimes.get(commandId) ?? Date.now();
  commandTimes.set(commandId, commandStartedAt);
  const order = commandOrders.get(commandId) ?? ++commandSequence;
  commandOrders.set(commandId, order);
  const identity = { id, commandId, commandStartedAt, commandSequence: order };
  retained.set(id, { ...emptyCounters, ...identity, engine, time: Date.now(), terminal: false,
    allocatorFailure: null, frozenAllocatorFailure: null, engineFailure: null, engineCounters: {} });
  trimTerminalSnapshots();
  if (typeof SharedArrayBuffer !== "function") return;
  const channel = createMemoryChannel();
  channels.set(id, channel);
  return { ...identity, buffer: channel };
}
export function endMemorySnapshot(id: string): void {
  const channel = channels.get(id);
  const cached: unknown = channel ? readMemoryChannel(channel) : null;
  if (cached && typeof cached === "object" && isMemorySnapshot(cached)) retained.set(id, cached);
  channels.delete(id);
  const snapshot = retained.get(id);
  if (snapshot) retained.set(id, { ...snapshot, terminal: true, time: Date.now() });
  trimTerminalSnapshots();
}

export function recordMemorySnapshot(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "bun-memory") return false;
  if (!("snapshot" in message) || !message.snapshot || typeof message.snapshot !== "object") throw new TypeError("Invalid memory snapshot");
  const snapshot = message.snapshot;
  if (!("id" in snapshot) || typeof snapshot.id !== "string") throw new TypeError("Invalid memory identity");
  if (!isMemorySnapshot(snapshot)) throw new TypeError("Invalid memory snapshot fields");
  const value = snapshot;
  retained.set(value.id, value);
  trimTerminalSnapshots();
  return true;
}

function trimTerminalSnapshots(): void {
  const activeCommands = new Set(Array.from(retained.values()).filter(snapshot => !snapshot.terminal).map(snapshot => snapshot.commandId));
  for (const [id, snapshot] of retained) {
    if (retained.size <= 128) return;
    if (!snapshot.terminal || snapshot.failedAllocation && activeCommands.has(snapshot.commandId)) continue;
    retained.delete(id);
    if (!Array.from(retained.values()).some(value => value.commandId === snapshot.commandId)) {
      commandTimes.delete(snapshot.commandId); commandOrders.delete(snapshot.commandId);
    }
  }
}
export function retainedMemorySnapshots(): readonly MemorySnapshot[] { return Array.from(retained.values()); }

function isMemorySnapshot(value: object): value is MemorySnapshot {
  const stringKeys = ["id", "notes", "commandId"];
  const order: unknown = Reflect.get(value, "commandSequence");
  if (typeof order !== "number" || !isCounter(order)) return false;
  const startedAt: unknown = Reflect.get(value, "commandStartedAt");
  if (typeof startedAt !== "number" || !isCounter(startedAt)) return false;
  const byteKeys = ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"];
  if (!stringKeys.every(key => typeof Reflect.get(value, key) === "string")) return false;
  if (!byteKeys.every(key => isCounter(Reflect.get(value, key)))) return false;
  if (!["failedAllocation", "allocatorFailure", "engineFailure"].every(key => isFailure(Reflect.get(value, key)))) return false;
  if (!isFrozenAllocatorFailure(Reflect.get(value, "frozenAllocatorFailure"))) return false;
  const engine: unknown = Reflect.get(value, "engine");
  if (typeof engine !== "string" || !["quickjs", "jsc", "browser", "hermes"].includes(engine)) return false;
  const time: unknown = Reflect.get(value, "time");
  if (typeof Reflect.get(value, "terminal") !== "boolean" || typeof time !== "number" || !isCounter(time)) return false;
  const counters: unknown = Reflect.get(value, "engineCounters");
  return counters !== null && typeof counters === "object" && Object.values(counters).every(isCounter);
}
function isCounter(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFailure(value: unknown): value is FailedAllocation | null {
  if (value === null) return true;
  return typeof value === "object" && "bytes" in value && isCounter(value.bytes)
    && "category" in value && typeof value.category === "string";
}
function isFrozenAllocatorFailure(value: unknown): value is FrozenAllocatorFailure | null {
  if (value === null) return true;
  if (!isFailure(value) || typeof value !== "object") return false;
  if (Reflect.get(value, "reason") !== "unknown") return false;
  return ["previousUsableBytes", "allocatorLiveBytes", "allocatorPeakBytes", "wasmCapacityBeforeBytes", "wasmCapacityAfterBytes"]
    .every(key => isCounter(Reflect.get(value, key)));
}
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
