// Bun.deepMatch(subset, object): whether `object` contains `subset`, following
// Bun__deepMatch in Bun's src/jsc/bindings/bindings.cpp (asymmetric matchers off) and
// functionBunDeepMatch in BunObject.cpp. See docs/bun-patches/bun-deep-match.md.
(function () {
  "use strict";

  type Seen = Set<object>;

  function isObject(value: unknown): value is object {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  // JSC getPropertyNames: enumerable string keys along the prototype chain, then symbols.
  function enumerableKeys(value: object): (string | symbol)[] {
    const keys: (string | symbol)[] = [];
    for (const key in value) keys.push(key);
    const symbols = Object.getOwnPropertySymbols(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key));
    return keys.concat(symbols);
  }

  // Arrays match exactly: the same length and the same number of keys.
  function arrayShapeDiffers(object: object, subset: object, subsetKeys: readonly (string | symbol)[]): boolean {
    if (!Array.isArray(object) || !Array.isArray(subset)) return false;
    return object.length !== subset.length || enumerableKeys(object).length !== subsetKeys.length;
  }

  function matches(object: object, subset: object, seenObject: Seen, seenSubset: Seen): boolean {
    if (object === subset) return true;
    const keys = enumerableKeys(subset);
    if (arrayShapeDiffers(object, subset, keys)) return false;
    for (const key of keys) {
      if (!(key in object)) return false;
      const value: unknown = Reflect.get(object, key);
      const expected: unknown = Reflect.get(subset, key);
      if (!isObject(value) || !isObject(expected)) {
        if (!Object.is(value, expected)) return false;
        continue;
      }
      // A property cycle already being compared counts as a match, as in Bun.
      const fresh = !seenObject.has(value) && !seenSubset.has(expected);
      seenObject.add(value);
      seenSubset.add(expected);
      if (fresh && !matches(value, expected, seenObject, seenSubset)) return false;
    }
    return true;
  }

  return function deepMatch(count: number, subset: unknown, object: unknown): boolean {
    if (count < 2) throw new TypeError("Expected 2 values to compare");
    if (!isObject(subset) || !isObject(object)) throw new TypeError("Expected 2 objects to match");
    return matches(object, subset, new Set(), new Set());
  };
})
