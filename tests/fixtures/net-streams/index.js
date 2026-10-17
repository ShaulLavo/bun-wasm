import assert from "node:assert/strict";

const response = await fetch(process.env.TEST_SERVER + "/text");
const reader = response.body.getReader({ mode: "byob" });
let size = 0;
for (;;) {
  const { done, value } = await reader.read(new Uint8Array(8));
  if (done) break;
  size += value.length;
}
assert.ok(size > 0);
reader.releaseLock();
console.log("fetch byob end");

const cancelled = await fetch(process.env.TEST_SERVER + "/text");
await cancelled.body.cancel("not needed");
console.log("fetch cancel");

const request = new Request(process.env.TEST_SERVER + "/echo", {
  method: "POST",
  body: ReadableStream.from(["hello ", "world"]).pipeThrough(new TextEncoderStream()),
  duplex: "half",
});
const echoed = await fetch(request);
assert.equal((await echoed.json()).body, "hello world");
console.log("fetch streamed upload");
