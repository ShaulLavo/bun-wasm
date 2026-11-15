import assert from "node:assert/strict";
import { types } from "node:util";
import * as staticNamespace from "./static.mts";

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
assert.deepEqual(Object.getOwnPropertyDescriptor(namespace, "count"), {
  value: 0, writable: true, enumerable: true, configurable: false,
});
const markerDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(namespace), "__esModule");
assert.equal(markerDescriptor?.enumerable, false);
assert.equal(markerDescriptor?.configurable, false);
assert.equal(Reflect.defineProperty(namespace, "count", { value: 0 }), true);
assert.equal(Reflect.defineProperty(namespace, "count", { value: 99 }), false);
assert.equal(Reflect.deleteProperty(namespace, "count"), false);
console.log("default marker, call, and cached identity");

namespace.increment();
assert.equal(namespace.count, 1);
assert.equal(Object.getOwnPropertyDescriptor(namespace, "count")?.value, 1);
const imported = await import("./default.mts");
assert.equal(namespace, imported, "require and dynamic import preserve namespace identity");
assert.equal(require("./reexport.mts").child, namespace, "namespace re-exports preserve identity");
assert.equal(types.isModuleNamespaceObject(namespace), true, "required values remain recognized module namespaces");
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

assert.equal(types.isModuleNamespaceObject(imported), true);
assert.equal(types.isModuleNamespaceObject(own), true);
assert.equal(require("./static.mts"), staticNamespace, "static-first imports keep canonical identity");
assert.equal(staticNamespace.__esModule, true);
const dynamicFirst = await import("./dynamic.mts");
assert.equal(require("./dynamic.mts"), dynamicFirst, "dynamic-first imports keep canonical identity");
assert.equal(dynamicFirst.__esModule, true);
const empty = await import("./empty.mts");
assert.equal(require("./empty.mts"), empty);
assert.equal(empty.__esModule, true);
assert.deepEqual(Object.keys(empty), []);
assert.equal(types.isModuleNamespaceObject(empty), true);
assert.equal(Object.getPrototypeOf(empty), Object.getPrototypeOf(namespace));
assert.equal(Reflect.setPrototypeOf(namespace, Object.getPrototypeOf(namespace)), true);
assert.equal(Reflect.setPrototypeOf(namespace, null), false);
assert.equal(Reflect.set(namespace, "count", 10), false);
assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(namespace)), null);
console.log("canonical namespaces across static-first and dynamic-first imports");

const prototype = Object.getPrototypeOf(namespace);
const inheritedSymbol = Symbol("namespace prototype");
for (const key of ["namespacePrototypeValue", inheritedSymbol]) {
  Object.defineProperty(prototype, key, {
    configurable: true,
    get() { return this.count; },
  });
  assert.equal(namespace[key], namespace.count, "inherited getters retain the native namespace receiver");
  assert.equal(key in namespace, true);
  assert.equal(Object.hasOwn(namespace, key), false);
  assert.equal(types.isModuleNamespaceObject(namespace), true);
  assert.equal(delete prototype[key], true);
  assert.equal(namespace[key], undefined);
  assert.equal(key in namespace, false);
}
for (const base of [null, prototype]) {
  const fabricated = Object.create(base);
  Object.defineProperty(fabricated, Symbol.toStringTag, { value: "Module" });
  Object.defineProperty(fabricated, "__esModule", { value: true });
  Object.preventExtensions(fabricated);
  assert.equal(types.isModuleNamespaceObject(fabricated), false, "tags and markers do not confer a namespace brand");
}
assert.equal(types.isModuleNamespaceObject(new Proxy(namespace, {})), false);
const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
assert.equal(types.isModuleNamespaceObject(throwingProxy), false);
for (const value of [null, undefined, {}, common, prototype, "Module", 0, () => {}]) {
  assert.equal(types.isModuleNamespaceObject(value), false);
}
console.log("native namespace branding rejects fabricated values and proxies");
