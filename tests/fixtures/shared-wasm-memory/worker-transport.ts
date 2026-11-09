// Receipt without an event-loop turn, senders that are already gone, moved ports and growth, on
// real worker_threads members of one group. Worker control is carried only by shared gate words.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { memberTag, stoppedPhysically } from './page-control.ts';

const child = `${import.meta.dir}/worker-transport-child.ts`;
const moduleBytes = await Bun.file(`${import.meta.dir}/cross-worker.wasm`).arrayBuffer();
const startBytes = await Bun.file(`${import.meta.dir}/start.wasm`).arrayBuffer();
const module = new WebAssembly.Module(moduleBytes);
type Exports = { read(address: number): number; pages(): number };

function start(data: object, transferList: readonly (Transferable | import('node:worker_threads').MessagePort)[] = [], tag?: string) {
  const worker = new Worker(child, { workerData: data, transferList: Array.from(transferList) as never, argv: tag ? [memberTag(tag)] : [] });
  const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  const next = <T>() => new Promise<T>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return { worker, exited, next };
}
/** Only the receiver is meant to be blocked: this side keeps turning its event loop to route messages. */
async function opened(gate: Int32Array, index: number) {
  const deadline = Date.now() + 30_000;
  while (Atomics.load(gate, index) === 0) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting on gate word ${index}`);
    await Bun.sleep(1);
  }
}
function open(gate: Int32Array, index: number) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}
function fresh(seed: number) {
  const buffer = new SharedArrayBuffer(16);
  new Uint8Array(buffer)[0] = seed;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  new Int32Array(memory.buffer)[0] = seed + 1;
  return { buffer, memory, again: memory, module: new WebAssembly.Module(moduleBytes) };
}

async function blockedReceiver() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'blockedReceiver', gate: gate.buffer, port: port2, seed: 31 }, [port2]);
  await opened(gate, 0);
  const objects = fresh(31);
  port1.postMessage(objects);
  open(gate, 1);
  await opened(gate, 2);
  assert.equal(await receiver.exited, 0);
  assert.equal(new Uint8Array(objects.buffer)[1], 33, 'the receiver wrote the sender bytes');
  assert.equal(new Int32Array(objects.memory.buffer)[1], 34, 'the receiver wrote through its Module');
  port1.close();
}

async function lateAttach() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'blockedReceiver', gate: gate.buffer, port: port2, seed: 41 }, [port2]);
  await opened(gate, 0);
  const sender = start({ mode: 'sender', port: port1, seed: 41 }, [port1], 'late-attach-sender');
  await sender.next();
  assert.equal(await sender.exited, 0);
  stoppedPhysically('late-attach-sender');
  open(gate, 1);
  await opened(gate, 2);
  assert.equal(await receiver.exited, 0);
}

async function portTransfer() {
  const { port1, port2 } = new MessageChannel();
  const objects = fresh(51);
  port1.postMessage({ n: 1, buffer: objects.buffer });
  port1.postMessage({ n: 2, memory: objects.memory, again: objects.memory, module: objects.module });
  assert.equal(receiveMessageOnPort(port2)!.message.n, 1, 'decoded before the move');
  const failure = new Error('aborted transfer');
  const other = new MessageChannel();
  assert.throws(() => other.port1.postMessage({ port2, get later() { throw failure; } }, [port2]), (error: unknown) => error === failure);
  other.port1.close();
  other.port2.close();
  port1.postMessage({ n: 3, buffer: objects.buffer });
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const drain = start({ mode: 'drain', port: port2, gate: gate.buffer, expected: 2 }, [port2]);
  assert.deepEqual(await drain.next(), { order: [2, 3], same: true, extra: false });
  assert.equal(await drain.exited, 0);
  assert.equal(new Int32Array(objects.memory.buffer)[2], 53, 'the moved queue reached the same bytes');
  port1.close();
}

async function concurrentGrowth() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  const growers = [0, 1, 2, 3].map(() => start({ mode: 'grower', memory, module }));
  const results = await Promise.all(growers.map(grower => grower.next<{ old: number; pages: number }>()));
  assert.deepEqual(await Promise.all(growers.map(grower => grower.exited)), [0, 0, 0, 0]);
  const olds = results.map(result => result.old).sort((left, right) => left - right);
  assert.deepEqual(olds, [-1, -1, 1, 2], 'two valid steps, and refused growth changes nothing');
  assert.equal(memory.buffer.byteLength, 3 * 65536);
  const exports = new WebAssembly.Instance(module, { env: { memory, observe() {} } }).exports as unknown as Exports;
  assert.equal(exports.pages(), 3);
  assert.equal(exports.read(65536), 0, 'newly visible bytes are zero');
  assert.equal(exports.read(3 * 65536 - 4), 0, 'newly visible bytes are zero');
}

async function startCallback() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const startModule = new WebAssembly.Module(startBytes);
  const worker = start({ mode: 'startCallback', memory, module: startModule });
  assert.deepEqual(await worker.next(), { started: 1, recovered: true });
  assert.equal(await worker.exited, 0);
}

await blockedReceiver();
await lateAttach();
await portTransfer();
await concurrentGrowth();
await startCallback();
console.log('shared-wasm-memory worker transport: pass');
