import assert from "node:assert/strict";
import { Readable, Writable, Duplex } from "node:stream";
const tick = () => new Promise(resolve => setImmediate(resolve));

const writes = [];
const completeWrites = [];
const sink = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
  writes.push(String(chunk));
  completeWrites.push(callback);
} });
const writer = Writable.toWeb(sink).getWriter();
let firstDone = false;
const first = writer.write("a").then(() => { firstDone = true; });
const second = writer.write("b");
await tick();
assert.deepEqual(writes, ["a"]);
assert.equal(firstDone, false);
completeWrites[0]();
await first;
await tick();
assert.deepEqual(writes, ["a", "b"]);
let closed = false;
const close = writer.close().then(() => { closed = true; });
await tick();
assert.equal(closed, false);
completeWrites[1]();
await second;
await close;
await assert.rejects(writer.write("late"), TypeError);
console.log("writable backpressure and close");

let generated = 0;
const source = new Readable({ highWaterMark: 4, read() {
  while (generated < 50) {
    const bytes = new Uint8Array(4).fill(generated++);
    if (!this.push(bytes)) return;
  }
  this.push(null);
} });
const readable = Readable.toWeb(source);
await tick();
assert(generated <= 3);
let total = 0;
for await (const chunk of readable) {
  for (const byte of chunk) assert.equal(byte, Math.floor(total++ / 4));
}
assert.equal(total, 200);
assert.equal(generated, 50);
console.log("readable backpressure and drain");

let completeCancel;
let readClosed = false;
const original = new Error("cancel source");
const input = new ReadableStream({ cancel(reason) {
  assert.equal(reason, original);
  return new Promise(resolve => { completeCancel = resolve; });
} });
const node = Readable.fromWeb(input);
node.on("error", reason => assert.equal(reason, original));
const nodeClosed = new Promise(resolve => node.once("close", () => { readClosed = true; resolve(); }));
node.destroy(original);
assert.equal(node.destroyed, true);
await tick();
assert.equal(readClosed, false);
completeCancel();
await nodeClosed;
console.log("readable waits for cancel");

let cancelDone;
let abortDone;
let pairClosed = false;
const pairReason = new Error("duplex source");
const pair = Duplex.fromWeb({
  readable: new ReadableStream({ cancel(reason) {
    assert.equal(reason, pairReason);
    return new Promise(resolve => { cancelDone = resolve; });
  } }),
  writable: new WritableStream({ abort(reason) {
    assert.equal(reason, pairReason);
    return new Promise(resolve => { abortDone = resolve; });
  } }),
});
pair.on("error", reason => assert.equal(reason, pairReason));
const pairClose = new Promise(resolve => pair.once("close", () => { pairClosed = true; resolve(); }));
pair.destroy(pairReason);
assert.equal(pair.destroyed, true);
await tick();
assert.equal(pairClosed, false);
cancelDone();
await tick();
assert.equal(pairClosed, false);
abortDone();
await pairClose;
console.log("duplex waits for both sides");
