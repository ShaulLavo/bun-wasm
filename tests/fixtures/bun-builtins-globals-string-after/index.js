const assert = require("node:assert/strict");
const saved = String;
let querystring, punycode, result, decoded;
querystring = require("querystring");
  punycode = require("punycode");
globalThis.String = function () { throw Error("poisoned String"); };
try {
  result = JSON.stringify(querystring.parse("a=1", "&", "="));
  decoded = punycode.decode("maana-pta");
} finally {
  globalThis.String = saved;
}
assert.equal(result, `{"a":"1"}`);
assert.equal(decoded, "mañana");
console.log(result);
