import assert from "node:assert/strict";
import http from "node:http";
import { pipeline } from "node:stream";

const pipe = (...streams) => new Promise((resolve, reject) => pipeline(...streams, error => error ? reject(error) : resolve()));
const server = http.createServer((request, response) => {
  pipe(request, new TransformStream({ transform(chunk, controller) {
    controller.enqueue(chunk.toString().toUpperCase());
  } }), response).catch(error => response.destroy(error));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const request = http.request({ hostname: "127.0.0.1", port: server.address().port, method: "POST" });
  const received = new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", response => {
      let body = "";
      response.on("data", chunk => { body += chunk.toString(); });
      response.on("error", reject);
      response.on("end", () => resolve(body));
    });
  });
  await pipe(ReadableStream.from(["hello"]), request);
  assert.equal(await received, "HELLO");
  assert.equal(request.writableFinished, true);
  console.log("HTTP Web pipeline finishes");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
