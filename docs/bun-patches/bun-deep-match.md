# Bun.deepMatch

Class: Original adapter.

`crates/bunwasm-runtime/src/js/bun_deep_match.ts` implements
`Bun.deepMatch(subset, object)`, following `functionBunDeepMatch` in Bun's
`src/jsc/bindings/BunObject.cpp` and `Bun__deepMatch` (with asymmetric
matchers off) in `src/jsc/bindings/bindings.cpp` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.
No upstream code is copied. Before this, `bun.js` called the `Bun.deepEquals`
helper with an extra argument it ignored, so `deepMatch` compared for equality.

The result is whether `object` contains `subset`. Each enumerable key of the
subset is checked, including inherited string keys and own symbols, as JSC's
`getPropertyNames` lists them. The key must exist on the object, own or
inherited. Objects and functions are compared recursively, and every other value
with `Object.is`. Two arrays must have the same length and the same number of
keys. An object pair already being compared on either side counts as a match,
as Bun's visited sets do. Fewer than two arguments throw `Expected 2 values to
compare`, and a non-object argument throws `Expected 2 objects to match`.

`toMatchObject` keeps its own implementation in `bun_test.js`; this module
serves only `Bun.deepMatch`. The `test-bun-deep-match` fixture covers these
rules on every engine.
