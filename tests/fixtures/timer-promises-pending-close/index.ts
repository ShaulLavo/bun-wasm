import assert from "node:assert/strict";
import { setInterval } from "node:timers/promises";

const controller = new AbortController();
const iterator = setInterval(50, "unexpected tick", { signal: controller.signal });
try {
  const first = iterator.next();
  const queued = iterator.next();
  const close = iterator.return;
  assert.ok(close);
  const returned = close.call(iterator);
  assert.equal((await first).done, true);
  assert.equal((await queued).done, true);
  const result = await returned;
  assert.equal(result.value, undefined);
  assert.equal(result.done, true);
  assert.equal((await iterator.next()).done, true);
} finally { controller.abort(); await iterator.return?.(); }
console.log("return cancels pending and queued interval reads without another tick");

const throwing = setInterval(50, "unexpected tick");
const failure = new Error("stop");
try {
  const pending = throwing.next();
  const fail = throwing.throw;
  assert.ok(fail);
  const thrown = fail.call(throwing, failure).catch(error => error);
  assert.equal((await pending).done, true);
  assert.equal(await thrown, failure);
  assert.equal((await throwing.next()).done, true);
} finally { await throwing.return?.(); }
console.log("throw cancels a pending interval read without another tick");
