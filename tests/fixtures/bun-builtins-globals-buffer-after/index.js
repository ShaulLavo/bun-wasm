const assert = require("node:assert/strict");
const saved = Buffer;
let querystring, punycode, result, decoded;
querystring = require("querystring");
globalThis.Buffer = function () { throw Error("poisoned Buffer"); };
try {
  result = querystring.unescape("%C3%A9%ZZ");
} finally {
  globalThis.Buffer = saved;
}
assert.equal(result, "é%ZZ");
console.log(result);
