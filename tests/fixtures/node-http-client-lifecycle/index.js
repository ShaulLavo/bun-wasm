import assert from "node:assert/strict";
import http from "node:http";
const server = http.createServer((request, response) => response.end("ok"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let request;
try {
  const received = new Promise((resolve, reject) => {
    request = http.request({ hostname: "127.0.0.1", port: server.address().port, method: "POST" }, response => {
      response.resume();
      response.once("end", resolve);
      response.once("error", reject);
    });
    request.on("error", reject);
  });
  received.catch(() => {});
  const finished = new Promise(resolve => request.once("finish", resolve));
  request.end("hello");
  assert.equal(request.writableEnded, true);
  await finished;
  assert.equal(request.writableFinished, true);
  await received;
  console.log("HTTP request uses Node completion state");
  request.destroy();
  assert.equal(request.destroyed, true);
  const lateError = await new Promise(resolve => request.write("late", resolve));
  assert.equal(lateError.code, "ERR_STREAM_DESTROYED");
  console.log("destroyed HTTP request rejects writes");
} finally {
  request?.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
