# Nth mock return matcher

Class: Port.

Upstream Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`.
Sources: `src/runtime/test_runner/expect/toHaveNthReturnedWith.rs` and the
`toHaveNthReturnedWith` / `nthReturnedWith` entries in
`src/runtime/test_runner/jest.classes.ts`.

`crates/bunwasm-runtime/src/js/test_matchers.ts` translates the selected-call
lookup, integer validation, return-versus-throw distinction, negation and
colorless diagnostics to TypeScript. Index validation preserves Bun's signed
52-bit integer range and rejects negative zero, then clamps accepted positive
indices to the signed 32-bit maximum before lookup and diagnostics. The existing runner supplies its mock
records, deep equality and formatting functions. Calls that throw or remain
incomplete retain their positions; successful calls returning `undefined`
still match. Both upstream matcher names use the same implementation.

The runner wiring in `bun_test.js` is an original adapter. It registers the
matcher through the existing assertion path, including promise modifiers,
assertion counts and error locations. No engine, mock implementation or
upstream suite source changes are required.

The local `test-nth-returned` fixture adapts the observable cases from upstream
`test/js/bun/test/spyMatchers.test.ts` and `mock-fn.test.js`, adding explicit
index validation and alias controls. The unmodified upstream files are measured
separately; fixture results are not added to upstream counts.
