import { readFileSync } from 'node:fs';
import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';

type Exports = { read(address: number): number; write(address: number, value: number): void; grow(delta: number): number; pages(): number };
type Fresh = { buffer: SharedArrayBuffer; memory: WebAssembly.Memory; again: WebAssembly.Memory; module: WebAssembly.Module };
type Data = { mode: string; port: MessagePort; gate: SharedArrayBuffer; seed: number; expected: number; memory: WebAssembly.Memory; module: WebAssembly.Module };
const data: Data = workerData;

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}
function open(gate: Int32Array, index: number) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}
function instantiate(module: WebAssembly.Module, memory: WebAssembly.Memory, observe: () => void = () => {}) {
  return new WebAssembly.Instance(module, { env: { memory, observe } }).exports as unknown as Exports;
}

function verify({ buffer, memory, again, module }: Fresh, seed: number) {
  check(memory === again, 'repeated references decode to one Memory');
  check(new Uint8Array(buffer)[0] === seed, 'shared buffer bytes');
  check(new Int32Array(memory.buffer)[0] === seed + 1, 'memory bytes');
  const exports = instantiate(module, memory);
  check(exports.read(0) === seed + 1, 'module reads the sender bytes');
  new Uint8Array(buffer)[1] = seed + 2;
  exports.write(4, seed + 3);
}

function blockedReceiver() {
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  if (Atomics.wait(gate, 1, 0, 30_000) === 'timed-out') throw new Error('Timed out before receipt');
  // Delivery may trail the post, so this polls, but only with blocking waits: this thread never
  // turns its event loop between the gate and this synchronous attachment.
  const deadline = Date.now() + 30_000;
  let received = receiveMessageOnPort(data.port);
  while (!received) {
    if (Date.now() > deadline) throw new Error('The posted graph was not readable');
    Atomics.wait(gate, 3, 0, 5);
    received = receiveMessageOnPort(data.port);
  }
  verify(received.message as Fresh, data.seed);
  open(gate, 2);
}

function sender() {
  const buffer = new SharedArrayBuffer(16);
  new Uint8Array(buffer)[0] = data.seed;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  new Int32Array(memory.buffer)[0] = data.seed + 1;
  const module = new WebAssembly.Module(readFileSync(`${import.meta.dir}/cross-worker.wasm`));
  data.port.postMessage({ buffer, memory, again: memory, module });
  parentPort!.postMessage('posted');
}

function freshObjects(seed: number) {
  const buffer = new SharedArrayBuffer(16);
  new Uint8Array(buffer)[0] = seed;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  new Int32Array(memory.buffer)[0] = seed + 1;
  return { buffer, memory, module: new WebAssembly.Module(readFileSync(`${import.meta.dir}/cross-worker.wasm`)) };
}

function postQueue(seed: number) {
  const { buffer, memory, module } = freshObjects(seed);
  data.port.postMessage({ n: 0 });
  data.port.postMessage({ n: 1, memory, again: memory, module });
  data.port.postMessage({ n: 2, buffer });
}

function queuedSender() {
  postQueue(data.seed);
  parentPort!.postMessage('posted');
}

function gatedSender() {
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  if (Atomics.wait(gate, 1, 0, 30_000) === 'timed-out') throw new Error('Timed out before the gated send');
  postQueue(data.seed);
  open(gate, 2);
}

type Queued = { n: number; memory?: WebAssembly.Memory; again?: WebAssembly.Memory; module?: WebAssembly.Module };

function checkQueued(message: Queued): boolean {
  if (!message.memory) return true;
  if (data.seed) check(new Int32Array(message.memory.buffer)[0] === data.seed + 1, 'queued memory bytes');
  instantiate(message.module!, message.memory).write(8, 53);
  return message.memory === message.again;
}

function drain() {
  const gate = new Int32Array(data.gate);
  const order: number[] = [];
  let same = true;
  const deadline = Date.now() + 30_000;
  while (order.length < data.expected) {
    if (Date.now() > deadline) throw new Error('Timed out draining the moved port');
    const item = receiveMessageOnPort(data.port);
    if (!item) { Atomics.wait(gate, 3, 0, 5); continue; }
    const message = item.message as Queued;
    order.push(message.n);
    same &&= checkQueued(message);
  }
  const extra = receiveMessageOnPort(data.port) !== undefined;
  parentPort!.postMessage({ order, same, extra });
}

function grower() {
  const exports = instantiate(data.module, data.memory);
  parentPort!.postMessage({ old: exports.grow(1), pages: exports.pages() });
}

function startCallback() {
  let started = 0;
  instantiate(data.module, data.memory, () => { started++; });
  const failure = { from: 'start' };
  let caught: unknown;
  try { instantiate(data.module, data.memory, () => { throw failure; }); }
  catch (error) { caught = error; }
  check(caught === failure, 'a start callback rethrows the exact value');
  instantiate(data.module, data.memory, () => { started++; });
  parentPort!.postMessage({ started: started - 1, recovered: started === 2 });
}

const modes: Record<string, () => void> = { blockedReceiver, sender, queuedSender, gatedSender, drain, grower, startCallback };
modes[data.mode]!();
