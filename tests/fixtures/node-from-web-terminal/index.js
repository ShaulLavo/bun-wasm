import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
async function settle(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("stream settlement timed out")), 300);
    })]);
  } finally { clearTimeout(timer); }
}
for (const type of ["closed", "errored"]) {
  const reason = new Error("web failure");
  const web = new WritableStream({ start(controller) { if (type === "errored") controller.error(reason); } });
  if (type === "closed") await web.close();
  const node = Writable.fromWeb(web);
  const errors = [];
  node.on("error", error => errors.push(error));
  await settle(new Promise(resolve => node.once("close", resolve)));
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
  await settle(done);
  assert.deepEqual(events, [type === "errored" ? "error" : "end"]);
  console.log("readable " + type);
}
const web = new WritableStream();
const node = Writable.fromWeb(web);
await new Promise((resolve, reject) => { node.on("error", reject); node.end(resolve); });
assert.equal(node.writableFinished, true);
console.log("normal fromWeb end");
for (const failed of [false, true]) {
  const reason = failed ? new Error("destroy adapter") : undefined;
  const actions = [];
  const web = new WritableStream({
    write() { actions.push("write"); },
    close() { actions.push("close"); },
    abort(error) { assert.equal(error, reason); actions.push("abort"); },
  });
  const node = Writable.fromWeb(web);
  node.on("error", error => assert.equal(error, reason));
  const closed = new Promise(resolve => node.once("close", resolve));
  node.destroy(reason);
  const writeError = await new Promise(resolve => node.write("late", resolve));
  assert.equal(writeError.code, "ERR_STREAM_DESTROYED");
  await settle(closed);
  assert.deepEqual(actions, [failed ? "abort" : "close"]);
  console.log("destroy writable " + failed);
}
for (const failed of [false, true]) {
  const reason = failed ? new Error("cancel adapter") : undefined;
  const cancelled = [];
  const web = new ReadableStream({ cancel(error) { cancelled.push(error); } });
  const node = Readable.fromWeb(web);
  node.on("error", error => assert.equal(error, reason));
  const closed = new Promise(resolve => node.once("close", resolve));
  node.destroy(reason);
  await settle(closed);
  assert.equal(cancelled.length, 1);
  if (failed) assert.equal(cancelled[0], reason);
  else assert.equal(cancelled[0] == null, true);
  console.log("destroy readable " + failed);
}
