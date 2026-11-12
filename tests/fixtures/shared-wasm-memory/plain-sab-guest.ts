// Region-backed buffer ownership and publication rollback, which only a group guest has.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const bytes = (buffer: SharedArrayBuffer) => new Uint8Array(buffer);
const { port1, port2 } = new MessageChannel();
function deliver<T>(value: T): T {
  port1.postMessage(value);
  return receiveMessageOnPort(port2)!.message;
}

// A same-member alias is not an owner. Losing it must not free the buffer it views.
const owner = new SharedArrayBuffer(8);
const ownerView = bytes(owner);
ownerView[0] = 11;
(() => { deliver(owner); })();
Bun.gc(true);
const peers = Array.from({ length: 16 }, () => new SharedArrayBuffer(8));
ownerView[1] = 12;
for (const peer of peers) assert.equal(bytes(peer)[1], 0);
assert.equal(ownerView[0], 11);

// Species may not return another wrapper over the source's own block.
const source = new SharedArrayBuffer(8);
bytes(source).set([1, 2, 3, 4]);
const alias = deliver(source);
assert.notEqual(alias, source);
const species = Object.getOwnPropertyDescriptor(SharedArrayBuffer, Symbol.species)!;
Object.defineProperty(SharedArrayBuffer, Symbol.species, { configurable: true, value: function () { return alias; } });
try {
  for (const [start, end] of [[1, 4], [2, 2]]) {
    assert.throws(() => source.slice(start, end), TypeError);
    assert.deepEqual(bytes(source).subarray(0, 4), new Uint8Array([1, 2, 3, 4]));
  }
} finally {
  Object.defineProperty(SharedArrayBuffer, Symbol.species, species);
}

// Failed sends withdraw what they staged, past the directory's 4,096 entries.
const failure = new Error('outer');
for (let round = 0; round < 4200; round += 1) {
  assert.throws(() => port1.postMessage({ fresh: new SharedArrayBuffer(8), get later() { throw failure; } }), (error: unknown) => error === failure);
}

// A delivery made from inside a send that then fails keeps its backing.
const inner = new SharedArrayBuffer(8);
assert.throws(() => port1.postMessage({ inner, get nested() { port1.postMessage({ inner }); throw failure; } }), (error: unknown) => error === failure);
const receipt = receiveMessageOnPort(port2)!.message.inner;
bytes(receipt)[0] = 33;
assert.equal(bytes(inner)[0], 33);

// A failed send that reuses a delivered token leaves that delivery intact.
assert.throws(() => port1.postMessage({ inner, get later() { throw failure; } }), (error: unknown) => error === failure);
bytes(receipt)[1] = 34;
assert.equal(bytes(inner)[1], 34);
assert.equal(bytes(deliver(inner))[1], 34);

// Valid traffic still reaches a real worker afterward.
const worker = new Worker(`${import.meta.dir}/plain-sab-child.ts`, { workerData: { mode: 'bytes', buffer: inner } });
const reply = await new Promise(resolve => worker.once('message', resolve));
assert.deepEqual(reply, { length: 8, first: 33, instance: true, outside: undefined });
assert.equal(bytes(inner)[1], 200);
await worker.terminate();
port1.close();
port2.close();
console.log('plain-sab guest: pass');
