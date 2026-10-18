import { controlLoad } from "waffle/proc/control";
import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "waffle/core/descriptors";
import { MemFS } from "waffle/fs/memory";
import { ProcessABI } from "waffle/proc/abi";
import { workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";

const { signals, wake } = workerProcessState((workerData as { transport: WorkerProcessTransport }).transport);
const descriptors = new DescriptorTable();
const unused = (): never => { throw new Error("unexpected service operation"); };
const abi = new ProcessABI({ memory: new WebAssembly.Memory({ initial: 1 }), descriptors, fs: new MemFS(), pid: 1, signals, wake,
  service: { waitJob: unused, jobEmpty: unused, childExited: unused, startStatus: unused, spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
const nativeWait = Atomics.wait;
let generation = 0;
let result: string | undefined;
Atomics.wait = ((word: Int32Array, index: number, expected: number, _milliseconds?: number) => {
  if (word.buffer !== wake.buffer || word.byteOffset + index * 4 !== wake.byteOffset) {
    throw new Error("production poll selected a different wait word");
  }
  generation++;
  parentPort!.postMessage({ phase: "waiting", generation });
  result = nativeWait(word, index, expected, 1000);
  return result;
}) as typeof Atomics.wait;
try {
  abi.imports.poll!(0, 0, -1, 0);
  parentPort!.postMessage({ phase: "done", generation, result, pending: controlLoad(signals.signalState, 2),
    interrupt: controlLoad(signals.interrupt, 0), sequence: controlLoad(wake, 0) });
} finally { Atomics.wait = nativeWait; descriptors.dispose(); parentPort!.close(); }
