const assert = require("node:assert/strict");
const saved = Buffer;
let querystring, punycode, result, decoded;
globalThis.Buffer = function () { throw Error("poisoned Buffer"); };
try {
  querystring = require("querystring");
  result = querystring.unescape("%C3%A9%ZZ");
} finally {
  globalThis.Buffer = saved;
}
assert.equal(result, "é%ZZ");
console.log(result);
