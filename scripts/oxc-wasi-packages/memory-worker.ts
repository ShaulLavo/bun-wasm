import { parentPort, workerData } from "node:worker_threads";
import { object } from "./config.ts";

const input = object(workerData);
if (!(input.memory instanceof WebAssembly.Memory) || typeof input.pointer !== "number") throw new Error("Invalid worker memory input");
const memory = input.memory;
const view = new Int32Array(memory.buffer, input.pointer, 1);
parentPort?.postMessage({ stage: "ready" });
const wait = Atomics.wait(view, 0, 0, 5000);
if (Atomics.load(view, 0) !== 7) throw new Error("Worker did not observe parent Atomics store");
const previousPages = memory.grow(1);
Atomics.store(view, 0, 9);
parentPort?.postMessage({ stage: "done", wait, previousPages, bytes: memory.buffer.byteLength });
