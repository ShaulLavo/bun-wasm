import type { MemorySnapshot } from "./memory-telemetry.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const payloadOffset = 32;
const byteLength = 8192;
type Reader = { sample(refresh?: boolean): MemorySnapshot; finish(): MemorySnapshot };

export function createMemoryChannel(): SharedArrayBuffer { return new SharedArrayBuffer(byteLength); }
export function requestMemoryChannel(buffer: SharedArrayBuffer, refresh: boolean): number {
  const words = new Int32Array(buffer, 0, 8);
  Atomics.store(words, 1, Number(refresh));
  return Atomics.add(words, 0, 1) + 1;
}
export function memoryChannelReady(buffer: SharedArrayBuffer, generation: number, refresh: boolean): boolean {
  const words = new Int32Array(buffer, 0, 8);
  return Atomics.load(words, 3) % 2 === 0 && Atomics.load(words, 2) === generation && (!refresh || Atomics.load(words, 5) === generation);
}
export function readMemoryChannel(buffer: SharedArrayBuffer): unknown {
  const words = new Int32Array(buffer, 0, 8);
  for (let attempt = 0; attempt < 3; attempt++) {
    const sequence = Atomics.load(words, 3);
    if (sequence % 2) continue;
    const length = Atomics.load(words, 4);
    if (!length) return null;
    if (length < 0 || length > buffer.byteLength - payloadOffset) throw new RangeError("Invalid telemetry frame length");
    const bytes = new Uint8Array(buffer, payloadOffset, length).slice();
    if (Atomics.load(words, 3) === sequence) return JSON.parse(decoder.decode(bytes));
  }
  return null;
}
function writeMemoryChannel(buffer: SharedArrayBuffer, snapshot: MemorySnapshot, generation: number, normal: boolean): void {
  const bytes = encoder.encode(JSON.stringify(snapshot));
  if (bytes.byteLength > buffer.byteLength - payloadOffset) throw new RangeError("Telemetry frame exceeds fixed capacity");
  const words = new Int32Array(buffer, 0, 8);
  Atomics.add(words, 3, 1);
  new Uint8Array(buffer, payloadOffset, bytes.byteLength).set(bytes);
  Atomics.store(words, 4, bytes.byteLength);
  Atomics.store(words, 2, generation);
  if (normal) Atomics.store(words, 5, generation);
  Atomics.add(words, 3, 1);
}
export function createMemoryPublisher(buffer: SharedArrayBuffer, reader: Reader) {
  const words = new Int32Array(buffer, 0, 8);
  let publishing = false;
  let firstFailure: MemorySnapshot | undefined;
  let lastEngine: MemorySnapshot | undefined;
  let frozenAllocatorFailure: MemorySnapshot["frozenAllocatorFailure"] = null;
  function retain(snapshot: MemorySnapshot): MemorySnapshot {
    frozenAllocatorFailure ??= snapshot.frozenAllocatorFailure;
    if (snapshot.jsHeapBytes !== null) lastEngine = snapshot;
    if (snapshot.failedAllocation && (!firstFailure || !firstFailure.engineFailure && snapshot.engineFailure)) firstFailure = snapshot;
    return { ...snapshot,
      jsHeapBytes: snapshot.jsHeapBytes ?? lastEngine?.jsHeapBytes ?? null,
      arrayBufferBytes: snapshot.arrayBufferBytes ?? lastEngine?.arrayBufferBytes ?? null,
      engineCounters: snapshot.jsHeapBytes === null && lastEngine ? lastEngine.engineCounters : snapshot.engineCounters,
      engineFailure: snapshot.engineFailure ?? firstFailure?.engineFailure ?? null,
      allocatorFailure: snapshot.allocatorFailure ?? firstFailure?.allocatorFailure ?? null,
      frozenAllocatorFailure,
      failedAllocation: firstFailure?.failedAllocation ?? snapshot.failedAllocation,
      notes: "Failure and last normal engine counters survive runtime teardown after a cached host read. " + snapshot.notes,
    };
  }
  function publish(normal: boolean, force: boolean, terminal: boolean): MemorySnapshot | undefined {
    if (publishing) return;
    const generation = Atomics.load(words, 0);
    const refresh = Boolean(Atomics.load(words, 1));
    const acknowledged = Atomics.load(words, 2) === generation;
    if (!force && acknowledged && (!refresh || !normal || Atomics.load(words, 5) === generation)) return;
    publishing = true;
    try {
      const snapshot = retain(terminal ? reader.finish() : reader.sample(normal && refresh));
      writeMemoryChannel(buffer, snapshot, generation, normal);
      return snapshot;
    } finally { publishing = false; }
  }
  return { capture: (normal = false, force = false) => publish(normal, force, false), finish: () => publish(false, true, true) };
}

function observeMemoryImport(
  namespace: string,
  name: string,
  value: WebAssembly.ImportValue,
  capture: (normal: boolean, force: boolean) => void,
  side: boolean,
): [string, WebAssembly.ImportValue] {
  if (typeof value !== "function") return [name, value];
  const normal = side && namespace === "env" && (name === "bun_core_idle" || name === "bun_core_poll");
  const force = namespace === "wasi_snapshot_preview1" && (name === "fd_write" || name === "proc_exit");
  return [name, (...args: unknown[]) => { capture(normal, force); return Reflect.apply(value, undefined, args); }];
}

export function observeMemoryImports(imports: WebAssembly.Imports, capture: (normal: boolean, force: boolean) => void, side: boolean): WebAssembly.Imports {
  const result: WebAssembly.Imports = {};
  for (const [namespace, entries] of Object.entries(imports)) result[namespace] = Object.fromEntries(Object.entries(entries).map(([name, value]) => observeMemoryImport(namespace, name, value, capture, side)));
  return result;
}
