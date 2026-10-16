import assert from "node:assert/strict";
import { Writable } from "node:stream";
const source = new Writable({ autoDestroy: false });
await new Promise(resolve => source.end(resolve));
const before = [source.listenerCount("error"), source.listenerCount("close")];
for (let i = 0; i < 20; i++) {
  const writer = Writable.toWeb(source).getWriter();
  await writer.closed;
  writer.releaseLock();
}
assert.deepEqual([source.listenerCount("error"), source.listenerCount("close")], before);
console.log("finished observers released");
