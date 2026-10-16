import assert from "node:assert/strict";
import { Readable } from "node:stream";

async function expectOriginalError(source, original) {
  const reader = Readable.toWeb(source).getReader();
  const results = await Promise.allSettled([reader.read(), reader.closed]);
  reader.releaseLock();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
  for (const result of results) assert.equal(result.reason, original);
}

const immediate = new Readable({ read() {} });
const original = new Error("original source failure");
immediate.destroy(original);
await expectOriginalError(immediate, original);
console.log("queued destroy error");

const alreadyClosed = new Readable({ read() {} });
const closedError = new Error("already closed failure");
const closed = new Promise(resolve => alreadyClosed.once("close", resolve));
alreadyClosed.once("error", error => assert.equal(error, closedError));
alreadyClosed.destroy(closedError);
await closed;
await expectOriginalError(alreadyClosed, closedError);
console.log("closed destroy error");

const cancelled = new Readable({ read() {} });
const cancelledClosed = new Promise(resolve => cancelled.once("close", resolve));
await Readable.toWeb(cancelled).cancel(new Error("cancelled"));
await cancelledClosed;
console.log("cancel reaches close");
