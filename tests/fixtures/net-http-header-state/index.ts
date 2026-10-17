import assert from "node:assert/strict";
import http from "node:http";

const headers: Record<string, string> = Object.create(null);
headers.__proto__ = "safe";
headers.undefined = "present";
headers.constructor = "ctor";
const probe = http.request({ host: "127.0.0.1", port: 1, headers });
probe.on("error", () => {});
try {
  assert.equal(probe.getHeader("__proto__"), "safe");
  assert.equal(probe.getHeader("missing"), undefined);
  probe.removeHeader("missing");
  assert.equal(probe.getHeader("undefined"), "present");
  probe.setHeader("X-Mixed", "old");
  probe.setHeader("x-mixed", "new");
  assert.deepEqual(probe.getRawHeaderNames(), ["__proto__", "undefined", "constructor", "Host", "x-mixed"]);
} finally {
  probe.destroy();
}

const server = http.createServer((request, response) => {
  assert.equal(request.rawHeaders.includes("__proto__"), true);
  assert.equal(request.headers.constructor, "ctor");
  assert.deepEqual(request.headersDistinct.__proto__, ["safe"]);
  response.setHeader("X-First", "one");
  response.setHeader("1234", "numeric");
  response.setHeader("__proto__", "safe");
  response.setHeader("constructor", "reply");
  assert.deepEqual(response.getHeaderNames(), ["1234", "x-first", "__proto__", "constructor"]);
  assert.deepEqual(response.getRawHeaderNames(), ["1234", "X-First", "__proto__", "constructor"]);
  response.end("ok");
});
server.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
try {
  await new Promise<void>((resolve, reject) => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = http.get({ host: "127.0.0.1", port: address.port, headers }, response => {
      assert.deepEqual(response.rawHeaders.slice(0, 8), ["1234", "numeric", "X-First", "one", "__proto__", "safe", "constructor", "reply"]);
      assert.equal(response.headers.constructor, "reply");
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("error", reject);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log("HTTP header dictionaries preserve valid names and Node key order");
