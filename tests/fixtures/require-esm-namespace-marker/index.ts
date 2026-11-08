import assert from "node:assert/strict";

const namespace = require("./default.mts");
assert.equal(namespace.__esModule, true, "require(esm) marks a default namespace");
const importDefault = (value: typeof namespace) => value && value.__esModule ? value : { default: value };
assert.equal(importDefault(namespace).default(), "default called");
assert.equal(require("./default.mts"), namespace);
assert.equal(require.cache[require.resolve("./default.mts")].exports, namespace);
assert.equal("__esModule" in namespace, true);
assert.equal(Object.prototype.propertyIsEnumerable.call(Object.getPrototypeOf(namespace), "__esModule"), false);
assert.deepEqual(Object.keys(namespace), ["count", "default", "increment"]);
assert.equal(Object.prototype.propertyIsEnumerable.call(namespace, "__esModule"), false);
assert.equal(Object.hasOwn(namespace, "__esModule"), false);
assert.equal(Object.prototype.toString.call(namespace), "[object Module]");
console.log("default marker, call, and cached identity");

namespace.increment();
assert.equal(namespace.count, 1);
const imported = await import("./default.mts");
assert.equal(imported.count, 1);
imported.increment();
assert.equal(namespace.count, 2);
assert.equal(namespace.default, imported.default);
console.log("live exports across require and import");

const named = require("./named.mts");
assert.equal(named.named, 7);
assert.equal(named.__esModule, true);
assert.equal(Object.hasOwn(named, "__esModule"), false);
console.log("named-only namespace marker");

const own = require("./marker.mts");
assert.equal(own.__esModule, false);
assert.equal(Object.prototype.propertyIsEnumerable.call(own, "__esModule"), true);
own.mark();
assert.equal(own.__esModule, "own marker");
assert.equal(own.default(), "own default");
const undefinedMarker = require("./undefined-marker.mts");
assert.equal(undefinedMarker.__esModule, undefined);
assert.equal(Object.prototype.hasOwnProperty.call(undefinedMarker, "__esModule"), true);
undefinedMarker.mark();
assert.equal(undefinedMarker.__esModule, false);
console.log("explicit markers stay live and unchanged");

const common = require("./common.cts");
assert.equal(common.__esModule, false);
assert.equal(common.default, "common default");
assert.equal(common.named, 9);
assert.equal(require("./common.cts"), common);
console.log("CommonJS exports unchanged");
