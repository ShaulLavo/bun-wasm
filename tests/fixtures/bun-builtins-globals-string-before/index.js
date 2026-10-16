const assert = require("node:assert/strict");
const saved = String;
let querystring, punycode, result, decoded;
globalThis.String = function () { throw Error("poisoned String"); };
try {
  querystring = require("querystring");
  punycode = require("punycode");
  result = JSON.stringify(querystring.parse("a=1", "&", "="));
  decoded = punycode.decode("maana-pta");
} finally {
  globalThis.String = saved;
}
assert.equal(result, `{"a":"1"}`);
assert.equal(decoded, "mañana");
console.log(result);
