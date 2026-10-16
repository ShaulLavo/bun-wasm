import assert from "node:assert/strict";
import { Duplex } from "node:stream";
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const state of ["ended", "destroyed", "erroring"]) {
  const seen = [];
  const source = new Duplex({ read() {}, write(chunk, encoding, callback) { seen.push(chunk); callback(); } });
  const reason = new Error("duplex failure");
  if (state === "ended") source.end();
  else source.destroy(state === "erroring" ? reason : undefined);
  const pair = Duplex.toWeb(source);
  assert(pair.readable instanceof ReadableStream);
  assert(pair.writable instanceof WritableStream);
  const writer = pair.writable.getWriter();
  const reader = pair.readable.getReader();
  const readClosed = reader.closed.catch(error => error);
  await writer.closed;
  await assert.rejects(writer.write("late"), TypeError);
  assert.equal(seen.length, 0);
  if (state === "ended") { source.push(null); source.resume(); assert.equal((await reader.read()).done, true); }
  else await readClosed;
  await tick();
  console.log(state);
}
