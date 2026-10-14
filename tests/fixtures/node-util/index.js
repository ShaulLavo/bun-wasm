const util = require("util");
console.log(util.format("%s=%d %j %o", "a", 42, { x: 1 }, [1]));
console.log(util.format("no args", 1, "two", { three: 3 }));
console.log(util.inspect({ a: 1, b: "str", c: [1, 2, { d: 3 }], e: new Map([["k", 1]]) }));
console.log(util.inspect("string"), util.inspect(new Set([1])), util.inspect(null));
console.log(util.inspect({ deep: { deeper: { deepest: { gone: 1 } } } }));
console.log(util.inspect({ deep: { deeper: { deepest: { gone: 1 } } } }, { depth: 0 }));
console.log("types:", util.types.isPromise(Promise.resolve()), util.types.isDate(new Date()), util.types.isRegExp(/x/), util.types.isUint8Array(new Uint8Array()), util.types.isAsyncFunction(async () => {}));
console.log("isDeepStrictEqual:", util.isDeepStrictEqual({ a: [1] }, { a: [1] }), util.isDeepStrictEqual([1], ["1"]));
function legacy(a, cb) {
  setTimeout(() => (a < 0 ? cb(new Error("negative")) : cb(null, a * 2)), 1);
}
const p = util.promisify(legacy);
p(21).then((v) => console.log("promisify:", v));
p(-1).catch((err) => console.log("promisify reject:", err.message));
const cbified = util.callbackify(async (x) => x + 1);
cbified(1, (err, v) => console.log("callbackify:", err, v));
function Base() {}
Base.prototype.hello = () => "hi";
function Child() {}
util.inherits(Child, Base);
console.log("inherits:", new Child().hello(), Child.super_ === Base);
console.log("TextEncoder:", util.TextEncoder === TextEncoder);
const { values, positionals } = util.parseArgs({ args: ["-f", "--name", "x", "pos"], options: { f: { type: "boolean", short: "f" }, name: { type: "string" } }, allowPositionals: true });
console.log("parseArgs:", JSON.stringify(values), positionals.join(","));
console.log("stripVTControlCharacters:", util.stripVTControlCharacters("\u001b[1mbold\u001b[22m"));
