# Object key and value matchers

Class: Original adapter.

`crates/bunwasm-runtime/src/js/bun_test.js` adds `toContainAllKeys`,
`toContainValue`, `toContainValues`, `toContainAllValues`, `toContainAnyValues`
and `toBeEmptyObject`, and corrects `toBeObject`. They follow
`src/runtime/test_runner/expect/` (`toContainAllKeys.rs`, `toContainValue.rs`,
`toContainValues.rs`, `toContainAllValues.rs`, `toContainAnyValues.rs`,
`toBeEmptyObject.rs`, `toBeObject.rs`), `Expect::contain_matcher` in
`expect.rs` and `JSValue::is_object_empty` in `src/jsc/JSValue.rs` at Bun
revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun
1.4.4. No upstream code is copied. See also the [extended
matchers](test-extended-matchers.md).

Keys are own enumerable string keys and values are `Object.values`, each
compared with `toEqual`'s equality, so asymmetric matchers work inside them.
Bun's edge cases are kept: `toContainAllKeys` reads keys from null or undefined
and throws, `toContainValues` passes for null or undefined, `toContainValue`,
`toContainAllValues` and `toContainAnyValues` fail for them, and
`toContainAllValues` needs equal counts and fails an empty expectation.
Failures print Bun's verbs, and `toContainAllKeys` prints the received keys.

`toBeObject` counts functions and classes as objects, like JSC's `isObject`,
and its failure says `Expected value to be an object` (or `not to be`) before
the received value, as in Bun. `toBeEmptyObject` accepts objects and functions
with no own enumerable string keys, except Map, Set, WeakMap, WeakSet, RegExp
and Date. That is Bun's `is_object_empty` rule; JSC's map and set checks include
the weak kinds, so it is wider than jest-get-type's. The adapter checks those
kinds with `instanceof` where Bun reads the JSC cell type, so an
`Object.create(Map.prototype)` object fails here and passes in Bun.

The `test-object-value-matchers` fixture covers these rules on every engine.
