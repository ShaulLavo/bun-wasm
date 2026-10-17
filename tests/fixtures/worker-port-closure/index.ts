import assert from "node:assert/strict";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { once } from "node:events";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

const closed = new MessageChannel();
const suppressed: unknown[] = [];
closed.port2.on("message", value => suppressed.push(value));
closed.port1.postMessage(1);
closed.port2.close();
await turn();
await turn();
assert.deepEqual(suppressed, []);
closed.port1.close();
console.log("local close suppresses queued delivery");

const sameTurn = new MessageChannel();
sameTurn.port1.close();
sameTurn.port2.postMessage("same turn");
assert.deepEqual(receiveMessageOnPort(sameTurn.port1), { message: "same turn" });
sameTurn.port2.close();
await turn();
console.log("disentanglement happens after the current turn");

const unstarted = new MessageChannel();
let peerClosed = false;
const peerClose = new Promise<void>(resolve => unstarted.port2.on("close", () => { peerClosed = true; resolve(); }));
unstarted.port1.postMessage(42);
unstarted.port1.close();
await turn();
await turn();
assert.equal(peerClosed, false);
assert.deepEqual(receiveMessageOnPort(unstarted.port2), { message: 42 });
unstarted.port2.start();
const deadline = setTimeout(() => { throw new Error("peer close event did not follow synchronous draining"); }, 2000);
await peerClose;
clearTimeout(deadline);
assert.equal(peerClosed, true);
console.log("unstarted peer keeps its queue until drained");

const batch = new MessageChannel();
const delivered: unknown[] = [];
const batchDone = new Promise<void>(resolve => batch.port2.on("message", value => {
  delivered.push(value); batch.port2.close();
  if (delivered.length === 2) resolve();
}));
batch.port1.postMessage(1);
batch.port1.postMessage(2);
await batchDone;
assert.deepEqual(delivered, [1, 2]);
batch.port1.close();
console.log("closing inside a delivery preserves its current batch");

const sequential = new MessageChannel();
sequential.port1.postMessage(1);
sequential.port1.postMessage(2);
assert.deepEqual(await once(sequential.port2, "message"), [1]);
assert.deepEqual(await once(sequential.port2, "message"), [2]);
sequential.port1.close(); sequential.port2.close();
console.log("promise continuations run between selected messages");
