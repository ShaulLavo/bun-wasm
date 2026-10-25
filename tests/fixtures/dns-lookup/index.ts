import assert from "node:assert/strict";
import dns from "node:dns";
import promises from "node:dns/promises";

assert.equal(dns.promises, promises);
assert.deepEqual(await promises.lookup("127.0.0.1"), { address: "127.0.0.1", family: 4 });
assert.deepEqual(await promises.lookup("127.0.0.1", { family: null as never }), { address: "127.0.0.1", family: 4 });
assert.deepEqual(await promises.lookup("::1", { all: true, verbatim: true }), [{ address: "::1", family: 6 }]);
assert.deepEqual(await promises.lookup("", { all: true }), []);
assert.deepEqual(await promises.lookup("", { family: 6 }), { address: null, family: 4 });
assert.throws(() => promises.lookup({} as never, 4), { code: "ERR_INVALID_ARG_TYPE" });
const callback = new Promise(resolve => dns.lookup("127.0.0.1", 4, (...result) => resolve(result)));
assert.deepEqual(await callback, [null, "127.0.0.1", 4]);
console.log("DNS lookup literals, overloads, callback delivery and promise identity passed");
