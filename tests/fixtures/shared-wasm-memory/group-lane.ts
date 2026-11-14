// Shared-group lanes on real worker_threads members of one group: a message posted before the
// counter notification is whole at the receiver's first synchronous receive, with the receiver
// blocked in Atomics.wait with no timeout, whatever its size, route or carried ports.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker, type WorkerOptions } from 'node:worker_threads';

const child = `${import.meta.dir}/group-lane-child.ts`;

function start(data: object, transferList: NonNullable<WorkerOptions['transferList']> = []) {
  const worker = new Worker(child, { workerData: data, transferList });
  const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  const next = <T>() => new Promise<T>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return { worker, exited, next };
}
/** The side that is not under test keeps its event loop turning while it waits. */
async function opened(gate: Int32Array, index: number) {
  while (Atomics.load(gate, index) === 0) await Bun.sleep(1);
}
function open(gate: Int32Array, index: number) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}
function text(bytes: number, seed: number) {
  return String.fromCharCode(97 + seed % 26).repeat(bytes);
}
function bytes(length: number, seed: number) {
  const view = new Uint8Array(length);
  for (let index = 0; index < length; index++) view[index] = (index * 31 + seed) & 255;
  return view.buffer;
}

/** The receiver blocks first; the post and notify follow; it must read the message at once. */
async function blockedReceiver(message: () => { value: unknown; transfer?: Transferable[] }, check: string) {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'blocked', gate: gate.buffer, port: port2, check }, [port2]);
  await opened(gate, 0);
  const { value, transfer } = message();
  port1.postMessage(value, transfer ?? []);
  open(gate, 1);
  assert.equal(await receiver.next(), 'received', check);
  assert.equal(await receiver.exited, 0, check);
  port1.close();
}

async function sizes() {
  await blockedReceiver(() => ({ value: { task: text(818, 1) } }), 'text:818:1');
  await blockedReceiver(() => ({ value: { task: text(197_589, 2) } }), 'text:197589:2');
  const buffer = bytes(2 << 20, 3);
  await blockedReceiver(() => ({ value: { buffer }, transfer: [buffer] }), 'bytes:2097152:3');
  assert.equal(buffer.byteLength, 0, 'the ArrayBuffer detached at the post');
}

/** The root blocks; a worker posts a large reply and notifies. */
async function blockedRoot() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'reply', gate: gate.buffer, port: port2 }, [port2]);
  assert.notEqual(Atomics.wait(gate, 1, 0), 'timed-out');
  const received = receiveMessageOnPort(port1);
  assert.ok(received, 'the reply is readable at the first receive');
  assert.equal((received.message as { task: string }).task, text(197_589, 4));
  assert.equal(await sender.exited, 0);
  port1.close();
}

/** The sender exits straight after posting; its message stays whole. */
async function senderExits() {
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'exit-after-post', port: port2 }, [port2]);
  assert.equal(await sender.exited, 0);
  const received = receiveMessageOnPort(port1);
  assert.ok(received, 'a message from an exited sender is readable');
  assert.equal((received.message as { task: string }).task, text(300_000, 5));
  assert.equal(receiveMessageOnPort(port1), undefined);
  port1.close();
}

/** Two siblings over a channel the root created: the root takes no part after the transfer. */
async function siblings() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'blocked', gate: gate.buffer, port: port2, check: 'text:197589:6' }, [port2]);
  await opened(gate, 0);
  const sender = start({ mode: 'sibling-sender', gate: gate.buffer, port: port1 }, [port1]);
  assert.equal(await receiver.next(), 'received');
  assert.equal(await sender.exited, 0);
  assert.equal(await receiver.exited, 0);
}

/** A message carrying a port decodes at once, and the carried port then works both ways. */
async function carriedPort() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'carried', gate: gate.buffer, port: port2 }, [port2]);
  await opened(gate, 0);
  const carried = new MessageChannel();
  port1.postMessage({ reply: carried.port2 }, [carried.port2]);
  open(gate, 1);
  const reply = await new Promise(resolve => carried.port1.once('message', resolve));
  assert.equal(reply, 'through the carried port');
  carried.port1.postMessage('back');
  assert.equal(await receiver.exited, 0);
  carried.port1.close();
  port1.close();
}

/** More queued frames than one drain takes, then a close: all arrive in order, then the close. */
async function backlogThenClose() {
  const { port1, port2 } = new MessageChannel();
  const receiver = start({ mode: 'backlog', port: port2, count: 3000 }, [port2]);
  assert.equal(await receiver.next(), 'ready');
  for (let index = 0; index < 3000; index++) port1.postMessage(index);
  port1.close();
  assert.equal(await receiver.next(), 3000);
  assert.equal(await receiver.exited, 0);
}

/** A burst to a message listener arrives completely and in order. */
async function burst() {
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'burst', port: port2, count: 5000 }, [port2]);
  let next = 0;
  await new Promise<void>((resolve, reject) => port1.on('message', value => {
    if (value !== next) reject(new Error(`expected ${next}, got ${value}`));
    if (++next === 5000) resolve();
  }));
  assert.equal(await sender.exited, 0);
  port1.close();
}

await sizes();
await blockedRoot();
await senderExits();
await siblings();
await carriedPort();
await backlogThenClose();
await burst();
console.log('shared-wasm-memory group lanes: pass');
