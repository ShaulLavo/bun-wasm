// Ordinary SharedArrayBuffers across real workers and channels, on behaviour native Bun also shows.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const child = `${import.meta.dir}/plain-sab-child.ts`;
const bytes = (buffer: SharedArrayBuffer) => new Uint8Array(buffer);

function start(workerData: object) {
  const worker = new Worker(child, { workerData });
  const replies: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  worker.on('message', message => {
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else replies.push(message);
  });
  worker.on('error', error => { console.error(error); process.exit(1); });
  const next = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve));
  return { worker, next };
}

function deliver<T>(value: T): T {
  const { port1, port2 } = new MessageChannel();
  port1.postMessage(value);
  const received: T = receiveMessageOnPort(port2)!.message;
  port1.close();
  port2.close();
  return received;
}

const fresh = new SharedArrayBuffer(12);
assert.ok(fresh instanceof SharedArrayBuffer);
assert.deepEqual(bytes(fresh), new Uint8Array(12));

const shared = new SharedArrayBuffer(10);
bytes(shared)[0] = 100;
const peer = start({ mode: 'bytes', buffer: shared });
assert.deepEqual(await peer.next(), { length: 10, first: 100, instance: true, outside: undefined });
assert.equal(bytes(shared)[1], 200);
const large = new SharedArrayBuffer(70_000);
peer.worker.postMessage(large);
assert.equal(await peer.next(), 'wrote');
assert.equal(bytes(large)[69_999], 201);
await peer.worker.terminate();

const words = new Int32Array(new SharedArrayBuffer(16));
const waker = start({ mode: 'wake', buffer: words.buffer });
let woken = 0;
while (woken === 0) {
  woken = Atomics.notify(words, 0, 1);
  if (woken === 0) await Bun.sleep(1);
}
assert.equal(woken, 1);
assert.equal(Atomics.wait(words, 1, 0, 10_000), 'ok');
while (Atomics.load(words, 1) !== 7) await Bun.sleep(1);
assert.deepEqual(await waker.next(), { result: 'ok', waking: 1 });
await waker.worker.terminate();

const source = new SharedArrayBuffer(10);
bytes(source).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const received = deliver(source);
const sliceReader = start({ mode: 'slices' });
for (const [buffer, expected] of [
  [source.slice(2, 7), [3, 4, 5, 6, 7]],
  [source.slice(3, 3), []],
  [received.slice(1, 4), [2, 3, 4]],
] as const) {
  sliceReader.worker.postMessage(buffer);
  assert.deepEqual(await sliceReader.next(), { length: expected.length, contents: Array.from(expected), instance: true });
  if (expected.length) assert.equal(bytes(buffer)[0], 222);
}
assert.deepEqual(bytes(source), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
await sliceReader.worker.terminate();

class Derived extends SharedArrayBuffer {}
assert.ok(deliver(new Derived(4)) instanceof SharedArrayBuffer);

const creator = start({ mode: 'creator' });
const created = await creator.next() as SharedArrayBuffer;
await creator.worker.terminate();
assert.equal(bytes(created)[0], 55);
bytes(created)[1] = 66;
const successor = start({ mode: 'bytes', buffer: created });
assert.deepEqual(await successor.next(), { length: 16, first: 55, instance: true, outside: undefined });
await successor.worker.terminate();

const echo = start({ mode: 'echo' });
const original = new SharedArrayBuffer(8);
echo.worker.postMessage(original);
const returned = await echo.next() as SharedArrayBuffer;
assert.notEqual(returned, original);
bytes(original)[0] = 77;
assert.equal(bytes(returned)[0], 77);
await echo.worker.terminate();

function identity(byteLength: number) {
  const buffer = new SharedArrayBuffer(byteLength);
  const one = deliver(buffer), two = deliver(buffer);
  assert.notEqual(one, two);
  assert.notEqual(one, buffer);
  assert.equal(one.byteLength, byteLength);
  bytes(one)[0] = 9;
  assert.equal(bytes(two)[0], 9);
  assert.equal(bytes(buffer)[0], 9);
  Object.defineProperty(one, 'tag', { value: 'one' });
  assert.equal(Object.getOwnPropertyDescriptor(two, 'tag'), undefined);
  const repeated = deliver({ a: buffer, b: buffer });
  assert.equal(repeated.a, repeated.b);
  const distinct = deliver({ a: buffer, b: one });
  assert.notEqual(distinct.a, distinct.b);
  bytes(distinct.a)[1] = 5;
  assert.equal(bytes(distinct.b)[1], 5);
}
identity(10);
identity(65_536);

console.log('plain-sab: pass');
