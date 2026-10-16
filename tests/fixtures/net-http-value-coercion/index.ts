import assert from "node:assert/strict";
import http from "node:http";

for (const value of [[undefined], [null, undefined, "x"], [], null]) {
  assert.equal(http.validateHeaderValue("X", value), undefined);
}
assert.throws(() => http.validateHeaderValue("X", undefined), { code: "ERR_HTTP_INVALID_HEADER_VALUE" });
for (const value of [Symbol("x"), [Symbol("x")]]) {
  assert.throws(() => http.validateHeaderValue("X", value), {
    name: "TypeError", message: "Cannot convert a Symbol value to a string",
  });
}
const server = http.createServer((req, res) => {
  assert.deepEqual(req.headersDistinct.x, ["undefined", "null", "x"]);
  res.setHeader("X", [undefined, null, "x"]);
  assert.throws(() => res.setHeader("Y", Symbol("x")), { name: "TypeError" });
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, agent: false, headers: { X: [undefined, null, "x"] } }, res => {
      assert.deepEqual(res.headersDistinct.x, ["undefined", "null", "x"]);
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
} finally { await new Promise(resolve => server.close(resolve)); }
console.log("HTTP header coercion matches Node");
