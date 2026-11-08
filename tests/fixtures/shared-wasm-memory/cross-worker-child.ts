// A real worker_threads worker driven by cross-worker.ts. Modes block in real waits, so all
// signalling to the parent goes through the shared words, never the worker's event loop.
import { parentPort, workerData } from 'node:worker_threads';

type Exports = {
  read(address: number): number;
  write(address: number, value: number): void;
  pages(): number;
  grow(delta: number): number;
  wait(address: number, expected: number, timeout: bigint): number;
  notify(address: number, count: number): number;
  callback(value: number): void;
};
function instantiate(module: WebAssembly.Module, memory: WebAssembly.Memory, observe: (value: number) => void = () => {}) {
  return new WebAssembly.Instance(module, { env: { memory, observe } }).exports as unknown as Exports;
}
const { mode, memory, module, how }: { mode: string; memory?: WebAssembly.Memory; module?: WebAssembly.Module; how?: string } = workerData;
function words() { return new Int32Array(memory!.buffer); }
function ready(index: number) {
  const view = words();
  Atomics.store(view, index, 1);
  Atomics.notify(view, index);
}
function check(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function callbacks(compiled: WebAssembly.Module, shared: WebAssembly.Memory) {
  const thrown = { from: 'worker' };
  let observed = 0;
  const exports = instantiate(compiled, shared, value => {
    observed = value;
    if (value === 2) throw thrown;
    // Reenter this member's own nested instance from its JS callback.
    if (value === 3) exports.write(0, 3);
  });
  exports.callback(1);
  check(observed === 1, 'worker callback');
  let caught: unknown;
  try { exports.callback(2); }
  catch (error) { caught = error; }
  check(caught === thrown, 'worker callback must rethrow the exact value');
  const saved = exports.read(0);
  exports.callback(3);
  check(exports.read(0) === 3, 'worker callback reentry');
  exports.write(0, saved);
}

function identity() {
  check(memory instanceof WebAssembly.Memory, 'Expected a WebAssembly.Memory');
  check(module instanceof WebAssembly.Module, 'Expected a WebAssembly.Module');
  const before = memory!.buffer;
  check(before instanceof SharedArrayBuffer, 'Expected a shared buffer');
  callbacks(module!, memory!);
  const exports = instantiate(module!, memory!);
  const view = new Int32Array(before);
  const seen = exports.read(0);
  exports.write(4, seen + 1);
  Atomics.store(view, 2, seen + 2);
  check(exports.grow(1) === 1, 'child grow');
  check(before.byteLength === 65536, 'old prefix length changed');
  check(Atomics.load(view, 0) === seen, 'old prefix view stopped aliasing');
  check(memory!.buffer !== before && memory!.buffer.byteLength === 131072, 'child buffer did not grow');
  check(exports.pages() === 2, 'child pages');
  ready(6);
  parentPort!.postMessage({ seen, alias: memory!.buffer.byteLength });
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
  parentPort!.postMessage({ memory: own, module });
}

function blocked() {
  const exports = instantiate(module!, memory!);
  ready(24);
  if (how === 'nested') exports.wait(26 * 4, 0, -1n);
  else Atomics.wait(words(), 26, 0);
  throw new Error('blocked worker must be terminated, not woken');
}

function loaded() {
  parentPort!.once('message', ({ memory: received, module: compiled, old }: { memory: WebAssembly.Memory; module: WebAssembly.Module; old: SharedArrayBuffer }) => {
    const exports = instantiate(compiled, received);
    exports.write(28 * 4, 7);
    // A posted old buffer stays that old prefix over the same bytes.
    const prefix = new Int32Array(old);
    Atomics.store(prefix, 29, 8);
    parentPort!.postMessage({ value: exports.read(28 * 4), prefix: old.byteLength, current: received.buffer.byteLength });
  });
}

function reentrant() {
  parentPort!.once('message', ({ memory: received, module: compiled }: { memory: WebAssembly.Memory; module: WebAssembly.Module }) => {
    check(received instanceof WebAssembly.Memory, 'reentrant Memory receipt');
    check(compiled instanceof WebAssembly.Module, 'reentrant Module receipt');
    const exports = instantiate(compiled, received);
    const value = exports.read(0);
    exports.write(4, value + 1);
    parentPort!.postMessage({ value });
  });
  parentPort!.postMessage({ ready: true });
}

const modes: Record<string, () => void> = { identity, nestedWait, jsWait, sender, blocked, loaded, reentrant };
modes[mode]!();
