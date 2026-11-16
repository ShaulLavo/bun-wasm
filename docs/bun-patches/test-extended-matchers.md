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
Array sizes retain Bun's signed integer-argument range. Message and whitespace
inputs recognize boxed string data independently of its prototype or realm.
Boxed messages normalize once before the assertion result. Forged prototypes do not confer string or
ArrayBuffer data, and function receivers retain their non-iterating behavior.
Repeated-substring counts reject negative zero, preserving the existing
non-overlapping search and unsigned count conversion.

Emptiness checks use Blob and file sizes, ArrayBuffer byte lengths, and iterable
contents instead of object property counts. Iterables are consumed completely,
without materializing their contents, and iterator exceptions propagate unchanged.
Bun probes iterability before acquiring the iterator. The adapter preserves both
iterator getter reads, reads `next` once, and uses the second iterator method.
Existing array, string, Map, Set and ordinary object behavior remains in place.
Blob and typed-array sizes come from their captured accessors instead of instance
properties. BunFile uses its existing internal prototype's stat-based accessor,
so checking a file does not load its bytes or trust an own size shadow.
Async asymmetric extension results and recursive deep equality are outside this
adapter. No mock, spy, engine or host interface code changes.

`tests/fixtures/test-extended-contract` runs the same contract on the guest and
through the source factory in `scripts/test-extensions.test.ts`.
