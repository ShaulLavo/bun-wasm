import assert from "node:assert/strict";
import { Writable } from "node:stream";
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const throwing of [false, true]) {
  let release;
  let sinkDone = false;
  let closed = false;
  const original = new Error("destroy source");
  const hookFailure = new Error("destroy hook failed");
  const events = [];
  const web = new WritableStream({ abort(reason) {
    assert.equal(reason, original);
    return new Promise(resolve => { release = () => { sinkDone = true; events.push("sink"); resolve(); }; });
  } });
  const node = Writable.fromWeb(web, { destroy(reason, callback) {
    assert.equal(this, node);
    assert.equal(reason, original);
    assert.equal(sinkDone, true);
    events.push("hook");
    if (throwing) throw hookFailure;
    setImmediate(() => callback(reason));
  } });
  node.on("error", reason => { assert.equal(reason, throwing ? hookFailure : original); events.push("error"); });
  const done = new Promise(resolve => node.once("close", () => { closed = true; events.push("close"); resolve(); }));
  node.destroy(original);
  assert.equal(node.destroyed, true);
  await tick();
  assert.equal(closed, false);
  assert.deepEqual(events, []);
  release();
  await done;
  assert.deepEqual(events, ["sink", "hook", "error", "close"]);
  console.log("custom destroy " + throwing);
}
