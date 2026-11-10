import { parentPort } from 'node:worker_threads';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
new Int32Array(memory.buffer)[0] = 71;
parentPort!.postMessage(memory);
