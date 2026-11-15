# Extended expectation matchers

Class: Original adapter.

`crates/bunwasm-runtime/src/js/test_matchers.ts` supplies the extended matcher
predicates and validation used by `bun_test.js`. This is original TypeScript,
checked against Bun's unchanged `test/js/bun/test/jest-extended.test.js` at
revision `9510e74152073d850a18758ca41114d8f214ffa6` and native Bun 1.4.4.
The reference implementations are under `src/runtime/test_runner/expect/`:
`toBeEmpty.rs`, `toBeArrayOfSize.rs`, `toBeEven.rs`, `toBeOdd.rs`,
`toEqualIgnoringWhitespace.rs`, and `toIncludeRepeated.rs`. The explicit pass
and fail helpers live in `src/runtime/test_runner/expect.rs`.

The adapter adds the missing pass, fail, array-size and whitespace matchers.
It validates arguments before applying negation, preserves unsigned array
lengths, handles arbitrary-size bigint parity, and ignores only ASCII whitespace.
Repeated-substring counts reject negative zero, preserving the existing
non-overlapping search and unsigned count conversion.

Emptiness checks use Blob and file sizes, ArrayBuffer byte lengths, and iterable
contents instead of object property counts. Iterables are consumed completely,
without materializing their contents, and iterator exceptions propagate unchanged.
Existing array, string, Map, Set and ordinary object behavior remains in place.
Async asymmetric extension results and recursive deep equality are outside this
adapter. No mock, spy, engine or host interface code changes.

`tests/fixtures/test-extended-contract` runs the same contract on the guest and
through the source factory in `scripts/test-extensions.test.ts`.
