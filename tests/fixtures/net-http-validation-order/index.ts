import assert from "node:assert/strict";
import http from "node:http";

const badHeaders = { "X\r\n": "x" };
const cases = [
  [{ method: "GET\n", path: "/a b", headers: badHeaders }, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters"],
  [{ method: "GET\n", headers: badHeaders }, "ERR_INVALID_HTTP_TOKEN", 'Method must be a valid HTTP token ["GET\n"]'],
  [{ path: "/a b", headers: badHeaders }, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters"],
  [{ method: 123, path: "/a b" }, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters"],
  [{ headers: badHeaders }, "ERR_INVALID_HTTP_TOKEN", 'Header name must be a valid HTTP token ["X\r\n"]'],
];
for (const [options, code, message] of cases) {
  assert.throws(() => http.request(options), { code, message });
}
console.log("HTTP path method header validation order matches Node");
