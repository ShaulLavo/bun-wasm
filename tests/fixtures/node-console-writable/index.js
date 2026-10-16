import { Console } from "node:console";
import { Writable } from "node:stream";
import assert from "node:assert/strict";

let output = "";
let finish = false;
const destroyed = new Promise(resolve => {
  const stream = new Writable({
    write(chunk, encoding, callback) { output += chunk; callback(); },
    destroy(error, callback) { resolve(error); callback(error); },
    autoDestroy: true,
  });
  stream.on("finish", () => { finish = true; });
  new Console(stream).log("hello");
  stream.end();
});
assert.equal(await destroyed, null);
assert.equal(output, "hello\n");
assert.equal(finish, true);
console.log("finish calls custom destroy");

const written = new Promise(resolve => {
  const stream = new Writable({ write(chunk, encoding, callback) {
    setImmediate(() => { callback(); resolve(chunk.toString()); });
  } });
  new Console(stream).log("async");
});
assert.equal(await written, "async\n");
await new Promise(resolve => setImmediate(resolve));
console.log("asynchronous writes complete");

const handled = new Promise(resolve => {
  const failure = new Error("write failed");
  const stream = new Writable({ write(chunk, encoding, callback) {
    setImmediate(() => { callback(failure); resolve(); });
  } });
  new Console(stream).error("ignored");
});
await handled;
await new Promise(resolve => setImmediate(resolve));
console.log("asynchronous write errors are ignored");

let autoDestroyed = false;
const retained = new Writable({ autoDestroy: false, destroy(error, callback) { autoDestroyed = true; callback(error); } });
retained.end();
await new Promise(resolve => setImmediate(resolve));
assert.equal(autoDestroyed, false);
retained.destroy();
assert.equal(autoDestroyed, true);
assert.equal(retained.destroyed, true);
console.log("autoDestroy false and explicit destroy");

for (const stream of [process.stdout, process.stderr]) {
  assert.equal(await new Promise(resolve => stream.write("", resolve)), null);
  const listeners = stream.listenerCount("error");
  new Console(stream).log("stdio");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.listenerCount("error"), listeners);
}
console.log("stdio callbacks preserve listeners");
