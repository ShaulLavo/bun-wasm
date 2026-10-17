import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "waffle/core/descriptors";
import { MemFS } from "waffle/fs/memory";
import { ProcessABI } from "waffle/proc/abi";
import type { SignalTransport } from "waffle/proc/signals";

const { signals, wake } = workerData as { signals: SignalTransport; wake: Int32Array };
const descriptors = new DescriptorTable();
const unused = (): never => { throw new Error("unexpected service operation"); };
const abi = new ProcessABI({ memory: new WebAssembly.Memory({ initial: 1 }), descriptors, fs: new MemFS(), pid: 1, signals, wake,
  service: { spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
const nativeWait = Atomics.wait;
let generation = 0;
let result: string | undefined;
Atomics.wait = ((word: Int32Array, index: number, expected: number, milliseconds?: number) => {
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
  parentPort!.postMessage({ phase: "done", generation, result, pending: Atomics.load(signals.signalState, 2),
    interrupt: Atomics.load(signals.interrupt, 0), sequence: Atomics.load(wake, 0) });
} finally { Atomics.wait = nativeWait; descriptors.dispose(); parentPort!.close(); }
