// A real worker_threads member of guest.ts's group: it attaches the same shared memory.
import { parentPort, workerData } from 'node:worker_threads';

const { memory, cell }: { memory: WebAssembly.Memory; cell: number } = workerData;
const words = new Int32Array(memory.buffer);
Atomics.store(words, cell, 0x5eed);
Atomics.notify(words, cell);
parentPort!.postMessage(memory.buffer.byteLength);
