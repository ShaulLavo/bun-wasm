// A real worker_threads worker driven by cross-worker.ts. Modes block in real waits, so all
// signalling to the parent goes through the shared words, never the worker's event loop.
import { parentPort, workerData } from 'node:worker_threads';

type Exports = {
  read(index: number): number;
  write(index: number, value: number): void;
  pages(): number;
  grow(delta: number): number;
  wait(index: number, expected: number, timeout: bigint): number;
  notify(index: number, count: number): number;
};
function instantiate(module: WebAssembly.Module, memory: WebAssembly.Memory) {
  return new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as Exports;
}
const { mode, memory, module }: { mode: string; memory?: WebAssembly.Memory; module?: WebAssembly.Module } = workerData;
function words() { return new Int32Array(memory!.buffer); }
function ready(index: number) {
  const view = words();
  Atomics.store(view, index, 1);
  Atomics.notify(view, index);
}

function identity() {
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('Expected a WebAssembly.Memory');
  if (!(module instanceof WebAssembly.Module)) throw new Error('Expected a WebAssembly.Module');
  const before = memory.buffer;
  if (!(before instanceof SharedArrayBuffer)) throw new Error('Expected a shared buffer');
  const exports = instantiate(module, memory);
  const view = new Int32Array(before);
  const seen = exports.read(0);
  exports.write(4, seen + 1);
  Atomics.store(view, 2, seen + 2);
  if (exports.grow(1) !== 1) throw new Error('child grow');
  if (before.byteLength !== 65536) throw new Error('old prefix length changed');
  if (Atomics.load(view, 0) !== seen) throw new Error('old prefix view stopped aliasing');
  if (memory.buffer === before || memory.buffer.byteLength !== 131072) throw new Error('child buffer did not grow');
  if (exports.pages() !== 2) throw new Error('child pages');
  ready(6);
  parentPort!.postMessage({ seen, alias: memory.buffer.byteLength });
}

function nestedWait() {
  const exports = instantiate(module!, memory!);
  ready(8);
  // Word 10 stays 0 until the parent's JS Atomics.notify wakes this nested wait.
  const status = exports.wait(40, 0, -1n);
  Atomics.store(words(), 12, status === 0 ? 100 : 200 + status);
  ready(14);
}

function jsWait() {
  ready(16);
  const status = Atomics.wait(words(), 18, 0);
  Atomics.store(words(), 20, status === 'ok' ? 100 : 200);
  ready(22);
}

function sender() {
  const own = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  new Int32Array(own.buffer)[0] = 91;
  const compiled = module!;
  parentPort!.postMessage({ memory: own, module: compiled });
}

function blocked() {
  const exports = instantiate(module!, memory!);
  ready(24);
  if (workerData.how === 'nested') exports.wait(26 * 4, 0, -1n);
  else Atomics.wait(words(), 26, 0);
  throw new Error('blocked worker must be terminated, not woken');
}

function loaded() {
  parentPort!.once('message', ({ memory: received, module: compiled }: { memory: WebAssembly.Memory; module: WebAssembly.Module }) => {
    const exports = instantiate(compiled, received);
    exports.write(28 * 4, 7);
    parentPort!.postMessage(exports.read(28 * 4));
  });
}

({ identity, nestedWait, jsWait, sender, blocked, loaded }[mode] as () => void)();
