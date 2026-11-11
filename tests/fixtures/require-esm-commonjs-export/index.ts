import assert from "node:assert/strict";

const factory = require("./factory.mts");
assert.equal(typeof factory, "function", 'require(esm) selects the "module.exports" export');
const importDefault = (value: typeof factory) => value && value.__esModule ? value : { default: value };
assert.equal(importDefault(factory).default(), "factory called");
assert.equal(require("./factory.mts"), factory);
assert.equal(require.cache[require.resolve("./factory.mts")].exports, factory);
const namespace = await import("./factory.mts");
assert.equal(namespace["module.exports"](), "factory called");
assert.equal(namespace.default(), "default called");
assert.equal(typeof namespace, "object");
console.log("CommonJS factory, cached identity and ES namespace stay distinct");

assert.deepEqual(require("./parent.mts").values, ["import-first default", "default called"]);
assert.equal(require("./import-first.mts")(), "import-first factory");
assert.equal(require("./factory.mts"), factory);
console.log("converted ES imports preserve namespaces before and after require");

assert.equal(require("./falsy.mts")["module.exports"], null);
assert.equal(require("./undefined.mts")["module.exports"], undefined);
assert.equal(require("./false.mts"), false);
assert.equal(require("./zero.mts"), 0);
console.log("nullish exports keep the namespace; false and zero override it");

const ordinary = require("./ordinary.mts");
assert.equal(ordinary.default(), "ordinary default");
assert.equal(ordinary.named, 7);
assert.equal(require("./common.cts")["module.exports"], "ordinary CommonJS property");
console.log("ordinary ES namespaces and CommonJS exports stay unchanged");
