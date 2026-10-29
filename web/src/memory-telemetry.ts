export type TelemetryEngine = "quickjs" | "jsc" | "browser" | "hermes";
export interface FailedAllocation { bytes: number | null; category: string }
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
export interface MemorySnapshot extends MemoryCounters {
  engine: TelemetryEngine;
  time: number;
  terminal: boolean;
  id: string;
  allocatorFailure: FailedAllocation | null;
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
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new TypeError(`Invalid ${name} pointer`);
  const pointer = raw >>> 0;
  if (pointer % 8 || pointer > memory.buffer.byteLength - bytes) throw new RangeError(`Invalid ${name} bounds`);
  const view = new DataView(memory.buffer, pointer, bytes);
  if (view.getBigUint64(0, true) !== 1n || view.getBigUint64(8, true) !== BigInt(bytes)) throw new TypeError(`Invalid ${name} ABI`);
  return Array.from({ length: bytes / 8 }, (_, index) => view.getBigUint64(index * 8, true));
}

interface EngineReadout { failure: FailedAllocation | null; heap: number | null; buffers: number | null; counters: Record<string, number | null> }
function engineReadout(engine: TelemetryEngine, memory: WebAssembly.Memory, exports: WebAssembly.Exports): EngineReadout | null {
  if (engine === "quickjs") {
    const data = read(memory, exports, "quickjs_memory_telemetry", 96);
    if (!data) return null;
    return {
      failure: failure(data[8], data[9], quickjsCategories),
      heap: count(data[4]), buffers: count(data[5]),
      counters: { refreshSequence: count(data[2]), mallocBytes: count(data[3]), structuralHeapBytes: count(data[4]),
        arrayBufferBytes: count(data[5]), arrayBufferCount: count(data[6]), countersValid: count(data[11]) },
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

export function createMemoryReader(engine: TelemetryEngine, core: WebAssembly.Instance, side?: WebAssembly.Instance) {
  const memory = core.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError("Missing telemetry memory");
  const id = crypto.randomUUID();
  let terminal = false;
  let failed = false;
  return {
    sample(refresh = false): MemorySnapshot {
      let data = engineReadout(engine, memory, side?.exports ?? {});
      const allocator = read(memory, core.exports, "bun_memory_telemetry", 80);
      const allocatorFailure = allocator ? failure(allocator[4], allocator[5], allocatorCategories) : null;
      failed ||= Boolean(allocatorFailure || data?.failure);
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
        ...emptyCounters, engine, id, terminal, time: Date.now(),
        wasmCapacityBytes: memory.buffer.byteLength,
        memoryLimitBytes: allocator ? 536870912 : null,
        allocatorLiveBytes: allocator ? count(allocator[2]) : null,
        allocatorPeakBytes: allocator ? count(allocator[3]) : null,
        jsHeapBytes: data?.heap ?? null, arrayBufferBytes: data?.buffers ?? null,
        failedAllocation: data?.failure ?? allocatorFailure, allocatorFailure, engineFailure: data?.failure ?? null,
        engineCounters: data?.counters ?? {},
        notes: "Allocator counts outstanding libc usable bytes, including padding, from successful outer allocation calls. Realloc internal temporary peaks are not observed. VM counters overlap allocator bytes. JSC heap and ArrayBuffer counters are GC-accounted estimates; exact JSC backing stores and SWC bytes are unknown. Cached engine counters reflect the last normal refresh. No forced GC.",
      };
    },
    finish() { terminal = true; return this.sample(false); },
  };
}

const retained = new Map<string, MemorySnapshot>();
export function recordMemorySnapshot(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "bun-memory") return false;
  if (!("snapshot" in message) || !message.snapshot || typeof message.snapshot !== "object") throw new TypeError("Invalid memory snapshot");
  const snapshot = message.snapshot;
  if (!("id" in snapshot) || typeof snapshot.id !== "string") throw new TypeError("Invalid memory identity");
  if (!isMemorySnapshot(snapshot)) throw new TypeError("Invalid memory snapshot fields");
  const value = snapshot;
  retained.set(value.id, value);
  if (retained.size > 128) retained.delete(retained.keys().next().value!);
  return true;
}

export function retainedMemorySnapshots(): readonly MemorySnapshot[] { return Array.from(retained.values()); }

function isMemorySnapshot(value: object): value is MemorySnapshot {
  const stringKeys = ["id", "notes"];
  const byteKeys = ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"];
  if (!stringKeys.every(key => typeof Reflect.get(value, key) === "string")) return false;
  if (!byteKeys.every(key => isCounter(Reflect.get(value, key)))) return false;
  if (!["failedAllocation", "allocatorFailure", "engineFailure"].every(key => isFailure(Reflect.get(value, key)))) return false;
  const engine: unknown = Reflect.get(value, "engine");
  if (!["quickjs", "jsc", "browser", "hermes"].includes(String(engine))) return false;
  if (typeof Reflect.get(value, "terminal") !== "boolean" || !isCounter(Reflect.get(value, "time"))) return false;
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
Reflect.set(globalThis, "__bunMemorySnapshots", retainedMemorySnapshots);
