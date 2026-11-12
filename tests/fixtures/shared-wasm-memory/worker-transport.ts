// Receipt without an event-loop turn, senders that are already gone, moved ports and growth, on
// real worker_threads members of one group. Worker control is carried only by shared gate words.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker, type WorkerOptions } from 'node:worker_threads';
import { agentArmed, attachStalled, memberTag, ownerReleased } from './page-control.ts';

const child = `${import.meta.dir}/worker-transport-child.ts`;
const moduleBytes = await Bun.file(`${import.meta.dir}/cross-worker.wasm`).arrayBuffer();
const startBytes = await Bun.file(`${import.meta.dir}/start.wasm`).arrayBuffer();
const module = new WebAssembly.Module(moduleBytes);
type Exports = { read(address: number): number; pages(): number };

function start(data: object, transferList: NonNullable<WorkerOptions['transferList']> = [], tag?: string) {
  const worker = new Worker(child, { workerData: data, transferList, argv: tag ? [memberTag(tag)] : [] });
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
  ownerReleased('late-attach-sender');
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

/** Decodes and queues on this side after a real event-loop turn, then moves the port. */
async function decodedQueuedTransfer() {
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'queuedSender', port: port1, seed: 91 }, [port1]);
  // Delivery order: a pump drains port lanes before this control message, so all three are decoded.
  await sender.next();
  const deadline = Date.now() + 30_000;
  let head = receiveMessageOnPort(port2);
  while (!head) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the first queued message');
    await Bun.sleep(1);
    head = receiveMessageOnPort(port2);
  }
  assert.equal(head.message.n, 0);
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const drain = start({ mode: 'drain', port: port2, gate: gate.buffer, expected: 2, seed: 91 }, [port2]);
  assert.deepEqual(await drain.next(), { order: [1, 2], same: true, extra: false });
  assert.equal(await sender.exited, 0);
  assert.equal(await drain.exited, 0);
}

/** No event-loop turn between the sender's post and the move, so these graphs stay undecoded. */
async function undecodedQueuedTransfer() {
  const senderGate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'gatedSender', port: port1, gate: senderGate.buffer, seed: 95 }, [port1]);
  await opened(senderGate, 0);
  open(senderGate, 1);
  if (Atomics.wait(senderGate, 2, 0, 30_000) === 'timed-out') throw new Error('Timed out waiting for the gated send');
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const drain = start({ mode: 'drain', port: port2, gate: gate.buffer, expected: 3, seed: 95 }, [port2]);
  assert.deepEqual(await drain.next(), { order: [0, 1, 2], same: true, extra: false });
  assert.equal(await sender.exited, 0);
  assert.equal(await drain.exited, 0);
}

async function receiverStopBeforeAttach() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const tag = 'receiver-stop-before-attach';
  const doomed = start({ mode: 'blockedReceiver', gate: gate.buffer, port: port2, seed: 61 }, [port2], tag);
  await opened(gate, 0);
  const objects = fresh(61);
  port1.postMessage(objects);
  assert.equal(await doomed.worker.terminate(), 1);
  assert.equal(await doomed.exited, 1);
  ownerReleased(tag);
  port1.close();
  // A publication belongs to the group, so the same objects still attach in a later receiver.
  const nextGate = new Int32Array(new SharedArrayBuffer(16));
  const next = new MessageChannel();
  const receiver = start({ mode: 'blockedReceiver', gate: nextGate.buffer, port: next.port2, seed: 61 }, [next.port2]);
  await opened(nextGate, 0);
  next.port1.postMessage(objects);
  open(nextGate, 1);
  await opened(nextGate, 2);
  assert.equal(await receiver.exited, 0);
  assert.equal(new Int32Array(objects.memory.buffer)[1], 64, 'the later receiver wrote through its Module');
  next.port1.close();
}

async function receiverStopDuringAttach() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const tag = 'stall-open-receiver';
  const receiver = start({ mode: 'blockedReceiver', gate: gate.buffer, port: port2, seed: 81 }, [port2], tag);
  await opened(gate, 0);
  port1.postMessage(fresh(81));
  open(gate, 1);
  const stalled = attachStalled(tag);
  assert.ok(stalled.memberHolds >= 2, 'the owner took the complete hold set before the stop');
  assert.equal(await receiver.worker.terminate(), 1);
  assert.equal(await receiver.exited, 1);
  const released = ownerReleased(tag);
  assert.equal(released?.groupHolds, stalled.groupHolds - stalled.memberHolds, 'every hold the member took came back');
  port1.close();
}

/** A row that needs the agent's end must refuse to start when the page cannot observe it. */
async function unobservableAgentRefused() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const tag = 'unarmed-receiver';
  const receiver = start({ mode: 'blockedReceiver', gate: gate.buffer, port: port2, seed: 21 }, [port2], tag);
  await opened(gate, 0);
  assert.throws(() => agentArmed(tag), /cannot observe the agent/);
  assert.equal(await receiver.worker.terminate(), 1);
  assert.equal(await receiver.exited, 1);
  ownerReleased(tag);
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
await decodedQueuedTransfer();
await undecodedQueuedTransfer();
await receiverStopBeforeAttach();
await receiverStopDuringAttach();
await unobservableAgentRefused();
await concurrentGrowth();
await startCallback();
console.log('shared-wasm-memory worker transport: pass');
