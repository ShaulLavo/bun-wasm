import assert from "node:assert/strict";

const factory = require("./factory.mts");
assert.equal(typeof factory, "function", 'require(esm) selects the "module.exports" export');
const importDefault = (value: typeof factory) => value && value.__esModule ? value : { default: value };
assert.equal(importDefault(factory).default(), "factory called");
assert.equal(require("./factory.mts"), factory);
assert.equal(require.cache[require.resolve("./factory.mts")].exports, factory);
const namespace = await import("./factory.mts");
assert.equal(namespace["module.exports"], factory);
assert.equal(namespace.default(), "default called");
assert.equal(namespace.calls, 1);
assert.equal(typeof namespace, "object");
console.log("CommonJS factory, cached identity and ES namespace stay distinct");

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
