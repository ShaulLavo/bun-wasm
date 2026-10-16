import assert from "node:assert/strict";
import { Writable } from "node:stream";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("stream settlement timed out")), 300);
    })]);
  } finally { clearTimeout(timer); }
}
for (const state of ["finished", "ended", "destroyed", "errored", "destroying", "erroring"]) {
  const seen = [];
  const original = new Error(state);
  const source = new Writable({ write(chunk, encoding, callback) { seen.push(chunk); callback(); } });
  const observed = [];
  if (state === "finished" || state === "ended") source.end();
  else source.destroy(state === "errored" || state === "erroring" ? original : undefined);
  if (state === "errored") source.once("error", error => observed.push(error));
  if (state === "finished" || state === "destroyed" || state === "errored") await tick();
  const writer = Writable.toWeb(source).getWriter();
  if (state === "erroring") source.once("error", error => observed.push(error));
  await settle(writer.closed);
  await assert.rejects(writer.write("late"), TypeError);
  await tick();
  assert.equal(seen.length, 0);
  if (state === "errored" || state === "erroring") assert.equal(observed[0], original);
  writer.releaseLock();
  console.log(state);
}
const failed = new Writable({ write(chunk, encoding, callback) { callback(); } });
const writer = Writable.toWeb(failed).getWriter();
const reason = new Error("live failure");
const closed = assert.rejects(writer.closed, error => error === reason);
failed.destroy(reason);
await settle(closed);
await assert.rejects(writer.write("late"), error => error === reason);
await tick();
console.log("live error");

const direct = new Writable({ write() { throw new Error("must not write"); } });
direct.destroy();
const writeError = await new Promise(resolve => direct.write("late", resolve));
assert.equal(writeError.code, "ERR_STREAM_DESTROYED");
await tick();
console.log("node late write");
