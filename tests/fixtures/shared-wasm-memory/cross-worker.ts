// Real parent/worker execution on one shared region. Run by guest.ts and, as a semantic
// reference, by native Bun. Workers are real worker_threads members of the parent's group.
import { strict as assert } from 'node:assert';
import { Worker } from 'node:worker_threads';

const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/cross-worker.wasm`).arrayBuffer());
const child = `${import.meta.dir}/cross-worker-child.ts`;
type Exports = {
  read(index: number): number;
  write(index: number, value: number): void;
  pages(): number;
  grow(delta: number): number;
  wait(index: number, expected: number, timeout: bigint): number;
  notify(index: number, count: number): number;
};
function exported(memory: WebAssembly.Memory) {
  return new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as Exports;
}
function spawn(mode: string, data: object = {}) {
  const worker = new Worker(child, { workerData: { mode, ...data } });
  const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  return { worker, exited };
}
function waitFor(view: Int32Array, index: number) {
  const status = Atomics.wait(view, index, 0, 30_000);
  if (status === 'timed-out') throw new Error(`Timed out waiting on word ${index}`);
  assert.equal(Atomics.load(view, index), 1);
}
async function identity(memory: WebAssembly.Memory, view: Int32Array, exports: Exports) {
  Atomics.store(view, 0, 11);
  const { worker, exited } = spawn('identity', { memory, module });
  const reply = await new Promise<{ seen: number; alias: number }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.deepEqual(reply, { seen: 11, alias: 131072 });
  waitFor(view, 6);
  assert.equal(Atomics.load(view, 1), 12, 'nested write in the worker reaches a JS view here');
  assert.equal(exports.read(8), 13, 'JS write in the worker reaches nested code here');
  assert.equal(await exited, 0);
  // The child's growth is visible; this member's old buffer still aliases the prefix.
  const before = view.buffer;
  assert.equal(memory.buffer.byteLength, 131072);
  assert.equal(exports.pages(), 2);
  assert.notEqual(memory.buffer, before);
  assert.equal(before.byteLength, 65536);
  exports.write(0, 21);
  assert.equal(new Int32Array(memory.buffer)[0], 21);
  assert.equal(new Int32Array(before)[0], 21);
}
async function nestedWaitJsNotify(memory: WebAssembly.Memory, view: Int32Array) {
  const { exited } = spawn('nestedWait', { memory, module });
  waitFor(view, 8);
  // The nested waiter must actually register before this JS notify counts it.
  let woken = 0;
  for (let i = 0; woken === 0 && i < 3000; i++) { woken = Atomics.notify(view, 10, 1); if (!woken) Atomics.wait(view, 30, 0, 10); }
  assert.equal(woken, 1, 'JS Atomics.notify woke the nested waiter');
  waitFor(view, 14);
  assert.equal(Atomics.load(view, 12), 100);
  assert.equal(await exited, 0);
}
async function jsWaitNestedNotify(memory: WebAssembly.Memory, view: Int32Array, exports: Exports) {
  const { exited } = spawn('jsWait', { memory, module });
  waitFor(view, 16);
  let woken = 0;
  for (let i = 0; woken === 0 && i < 3000; i++) { woken = exports.notify(18 * 4, 1); if (!woken) Atomics.wait(view, 30, 0, 10); }
  assert.equal(woken, 1, 'nested notify woke the JS waiter');
  waitFor(view, 22);
  assert.equal(Atomics.load(view, 20), 100);
  assert.equal(await exited, 0);
}
function waitResults(view: Int32Array, exports: Exports) {
  Atomics.store(view, 32, 5);
  assert.equal(exports.wait(32 * 4, 6, -1n), 1, 'nested mismatch');
  assert.equal(exports.wait(32 * 4, 5, 0n), 2, 'nested zero timeout');
  assert.equal(Atomics.wait(view, 32, 6), 'not-equal');
  assert.equal(Atomics.wait(view, 32, 5, 0), 'timed-out');
}
async function terminated(memory: WebAssembly.Memory, view: Int32Array, how: 'nested' | 'js') {
  Atomics.store(view, 24, 0);
  const { worker, exited } = spawn('blocked', { memory, module, how });
  waitFor(view, 24);
  // Terminate releases the waiter without any wake reaching this word.
  assert.equal(await worker.terminate(), 1);
  assert.equal(await exited, 1);
  assert.equal(Atomics.notify(view, 26, 1), 0, 'the terminated waiter is gone');
}
async function senderExit() {
  const { worker, exited } = spawn('sender', { module });
  const received = await new Promise<{ memory: WebAssembly.Memory; module: WebAssembly.Module }>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(await exited, 0);
  // The sender has physically stopped. Its region and the module it posted stay live here.
  assert(received.memory instanceof WebAssembly.Memory);
  assert(received.memory.buffer instanceof SharedArrayBuffer);
  const view = new Int32Array(received.memory.buffer);
  assert.equal(Atomics.load(view, 0), 91);
  const exports = new WebAssembly.Instance(received.module, { env: { memory: received.memory } }).exports as unknown as Exports;
  assert.equal(exports.read(0), 91);
  assert.equal(exports.grow(1), 1);
  assert.equal(received.memory.buffer.byteLength, 131072);
  exports.write(65536, 92);
  assert.equal(new Int32Array(received.memory.buffer)[16384], 92);
  assert.equal(view[0], 91, 'prefix view survives its sender and later growth');
}
async function postedLoad(memory: WebAssembly.Memory, view: Int32Array) {
  // The emnapi pool shape: the worker gets Module and Memory by message, not workerData.
  const { worker, exited } = spawn('loaded');
  worker.postMessage({ memory, module });
  const value = await new Promise<number>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(value, 7);
  assert.equal(Atomics.load(view, 28), 7);
  assert.equal(await exited, 0);
}

const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
const view = new Int32Array(memory.buffer);
const exports = exported(memory);
await identity(memory, view, exports);
await nestedWaitJsNotify(memory, view);
await jsWaitNestedNotify(memory, view, exports);
waitResults(view, exports);
await terminated(memory, view, 'nested');
await terminated(memory, view, 'js');
await senderExit();
await postedLoad(memory, view);
console.log('shared-wasm-memory cross-worker: pass');
