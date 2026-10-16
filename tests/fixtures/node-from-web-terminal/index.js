import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const type of ["closed", "errored"]) {
  const reason = new Error("web failure");
  const web = new WritableStream({ start(controller) { if (type === "errored") controller.error(reason); } });
  if (type === "closed") await web.close();
  const node = Writable.fromWeb(web);
  const errors = [];
  node.on("error", error => errors.push(error));
  await tick();
  assert.equal(node.destroyed, true);
  assert.equal(errors.length, 1);
  if (type === "errored") assert.equal(errors[0], reason);
  else assert.equal(errors[0].code, "ERR_STREAM_PREMATURE_CLOSE");
  const writeError = await new Promise(resolve => node.write("late", resolve));
  assert.equal(writeError.code, "ERR_STREAM_DESTROYED");
  console.log("writable " + type);
}
for (const type of ["closed", "errored"]) {
  const reason = new Error("read failure");
  const web = new ReadableStream({ start(controller) { if (type === "errored") controller.error(reason); else controller.close(); } });
  const node = Readable.fromWeb(web);
  const events = [];
  const done = new Promise(resolve => {
    node.on("error", error => { assert.equal(error, reason); events.push("error"); });
    node.on("end", () => events.push("end"));
    node.on("close", resolve);
  });
  node.resume();
  await done;
  assert.deepEqual(events, [type === "errored" ? "error" : "end"]);
  console.log("readable " + type);
}
const web = new WritableStream();
const node = Writable.fromWeb(web);
await new Promise((resolve, reject) => { node.on("error", reject); node.end(resolve); });
assert.equal(node.writableFinished, true);
console.log("normal fromWeb end");
