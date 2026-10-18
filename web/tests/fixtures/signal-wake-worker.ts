import { parentPort, workerData } from "node:worker_threads";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

const nativeWait = Atomics.wait;
let wake: ReturnType<typeof import("waffle/proc/worker-client").workerProcessState>["wake"] | undefined;
let generation = 0;
let result: string | undefined;
Atomics.wait = ((word: Int32Array, index: number, expected: number, milliseconds?: number) => {
  if (!wake) return nativeWait(word, index, expected, milliseconds);
  if (word.buffer !== wake.buffer || word.byteOffset + index * 4 !== wake.byteOffset) {
    throw new Error("production poll selected a different wait word");
  }
  generation++;
  parentPort!.postMessage({ phase: "waiting", generation });
  result = nativeWait(word, index, expected, 1000);
  return result;
}) as typeof Atomics.wait;
// Install this fixture's native-wait observer before Waffle captures its intrinsics.
// The production modules remain unchanged and expose no mutable instrumentation hook.
const { controlLoad } = await import("waffle/proc/control");
const { DescriptorTable } = await import("waffle/core/descriptors");
const { MemFS } = await import("waffle/fs/memory");
const { ProcessABI } = await import("waffle/proc/abi");
const { workerProcessState } = await import("waffle/proc/worker-client");
const state = workerProcessState((workerData as { transport: WorkerProcessTransport }).transport);
const { signals } = state;
wake = state.wake;
const descriptors = new DescriptorTable();
const unused = (): never => { throw new Error("unexpected service operation"); };
const abi = new ProcessABI({ memory: new WebAssembly.Memory({ initial: 1 }), descriptors, fs: new MemFS(), pid: 1, signals, wake,
  service: { waitJob: unused, jobEmpty: unused, childExited: unused, startStatus: unused, spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
try {
  abi.imports.poll!(0, 0, -1, 0);
  parentPort!.postMessage({ phase: "done", generation, result, pending: controlLoad(signals.signalState, 2),
    interrupt: controlLoad(signals.interrupt, 0), sequence: controlLoad(wake, 0) });
} finally { Atomics.wait = nativeWait; descriptors.dispose(); parentPort!.close(); }
