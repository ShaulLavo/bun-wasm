# Platform equality and expectation diagnostics

Class: Original adapter.

The Bun comparison helpers in `crates/bunwasm-runtime/src/js/util.ts` follow
`src/jsc/bindings/bindings.cpp` at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`. The expectation changes in
`bun_test.js` and `test_matchers.ts` follow `src/runtime/test_runner/expect.rs`
at that revision and native Bun 1.4.4. These additions copy no upstream code.

URL comparisons check the underlying href before ordinary properties.
URLSearchParams and Headers compare their contents before properties, using
prototype operations to avoid instance method shadows. URLSearchParams retains
Bun's first-value lookup for duplicate keys. Boxed strings also compare their
constructor names, so different String subclasses remain distinct.

Array comparisons read own data descriptors. Indexed accessors remain unread
unless a loose expectation comparison encounters an asymmetric matcher on the
other side. Strict comparisons check index presence before invoking matchers.
Proxy arrays retain ordinary property reads. Both comparison paths visit arrays
before the intrinsic brand probes used for other object types. This removes
repeated caught exceptions from Set searches containing arrays, without a new
candidate index, result cache, or collection copy. Public Bun.deepEquals remains
synchronous. The [awaited comparison contract](test-awaited-asymmetric.md) stays
in effect for private expectation comparisons.

A resolved function is invoked by toThrow; a rejected function remains the
rejection value. Nonempty string assertion labels replace the default matcher
signature and survive modifiers. Each expectation retains its label directly.

Expectation chains retain only an opaque file token from the runner's private
read-only getter. Positive toMatchSnapshot calls reject a different token before
snapshot reservation. Negated snapshot calls reject before reservation or the
file check and retain their existing assertion count. Inline snapshots permit
cross-file reuse. Same-file cached, hook-created, and delayed expectations use
the current test and invocation for counters, tracking, and snapshot naming.
The file guard does not implement native Bun's additional concurrent-test file
snapshot restrictions for hook-created expectations.

`scripts/test-equality-platform.test.ts` exercises the actual factories. The
feature-owned native fixtures cover platform contents, getter order, awaited
matchers, promise throws, labels, snapshot file identity, and reservation order.
The utility migration AST guard excludes these Bun-owned function changes; its
new hash is derived from unchanged pre-change source with the same exclusions.
Mutation controls still reject changes to Node comparison and argument parsing.
The raw-operation manifest retains its 47 expressions, views, and classifications;
only their source line numbers move.

The separate adapters are the Bun equality helpers, expectation file tokens and
labels, and promise throw outcomes. Diagnostic pretty formatting remains the
port described in [Bun test diff formatting](bun-test-diff-formatting.md).
