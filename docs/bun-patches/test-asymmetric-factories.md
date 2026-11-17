# Asymmetric matcher factories and promise chains

Class: Original adapter.

The asymmetric matcher factories in `crates/bunwasm-runtime/src/js/bun_test.js`
follow Bun's `ExpectStatic` and matcher classes in
`src/runtime/test_runner/expect.rs`, the matching rules in
`matchAsymmetricMatcherAndGetFlags` in `src/jsc/bindings/bindings.cpp`, and the
printed forms in `src/runtime/test_runner/pretty_format.rs`, at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.
No upstream code is copied.

`expect`, `expect.not`, `expect.resolvesTo`, `expect.rejectsTo` and their chains
(`expect.not.resolvesTo`, `expect.rejectsTo.not` and so on) are flag holders that
create every factory: `anything`, `any`, `stringContaining`, `stringMatching`,
`objectContaining`, `arrayContaining`, `closeTo` and `expect.extend` matchers.
Chaining `resolvesTo` onto `rejectsTo`, or the reverse, throws Bun's message.
One holder exists per flag pair.

Factories validate their sample when called and throw Bun's plain `Error`
messages: a number and an optional number precision for `closeTo`, a constructor
for `any`, a string for `stringContaining`, a string or RegExp for
`stringMatching` (Bun's message names `stringContaining` here too), an object
or function for `objectContaining` and an array for `arrayContaining`. `any()`
with no argument keeps the existing TypeError text that the upstream test checks.

Matching follows Bun's rules:

- A promise-flagged matcher accepts only a real promise, read through the
  intrinsic reaction (`internal.promiseThen`), never the public `then`. A
  non-promise, a thenable or the other settlement fails before `not` inverts,
  so `expect.not.resolvesTo.x()` matches a rejected promise.
- `closeTo` never matches a non-number, even negated.
- `any(Object)` is Jest's `typeof other === "object"`: null matches and
  functions do not. Other constructors match their primitive type, then fall
  back to `instanceof`, so boxed BigInt and Symbol values match.
- `objectContaining` compares enumerable own symbol keys as well as string keys.

Printed forms add `NotAny<...>`, `NotAnything`, `NumberNotCloseTo` and the
`promise resolved to ` / `promise rejected to ` prefixes. One difference is
intentional: Bun prints `closeTo`'s number truncated to an integer and omits the
space after `NumberNotCloseTo`; this adapter prints the full number with a space.

`toThrow` (`throwOutcome` in `crates/bunwasm-runtime/src/js/test_matchers.ts`)
marks a thrown promise handled through an intrinsic reaction only when it has
already rejected by the time the function returns. Bun's `get_value_as_to_throw`
captures rejections that become unhandled while the function runs, so its
rejection is not reported against a later test. A pending promise that rejects
after `toThrow` returns stays unhandled and is reported, as in Bun. The
`test-throw-handled-promise` fixture covers both cases.

One gap remains: a promise that was already rejected before the function was
called, then thrown, is also marked handled here. Bun drains such rejections
before the call and reports them. Telling the two apart would need each engine's
rejection tracker to say whether the promise is already queued, which the
`Engine` interface does not expose.

Each flag pair has one cached holder, so `expect.not === expect.not` is true
here and false on Bun.

Matching a promise makes the assertion return a Promise, as other asynchronous
asymmetric matches do under the [awaited comparison
contract](test-awaited-asymmetric.md); native Bun instead drains the event loop
and returns undefined. The `test-asymmetric-factories` fixture covers these
rules on every engine.
