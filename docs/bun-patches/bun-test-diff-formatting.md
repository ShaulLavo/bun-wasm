### Bun test diff formatting

`crates/bunwasm-runtime/src/js/bun_test.js`, pretty-value and diff-formatting helpers. Class **Port**. Upstream `src/runtime/test_runner/pretty_format.rs` and `src/runtime/test_runner/diff/printDiff.rs` at the Bun pin.

Translate the colorless formatting path, sorted keys, expected/received sections, context chunking, line prefixes, and agent-mode thresholds to JavaScript. Replace Bun's tuned Myers line differ with a local common-prefix/suffix trim and LCS implementation for small diffs, with a bounded large-diff path. This reproduces useful test diagnostics without the native test runner. Discovery, scopes, matchers, mock tracking, scheduling, and snapshot storage in the rest of the file are local implementations that follow Bun's observable contract.

Assertion diagnostics enumerate own string property names, including
non-enumerable properties. This preserves a non-callable FormData.toJSON value
in the diagnostic without calling it. Accessor properties print as
`[native code]` without running the getter, as native Bun does, so a throwing
getter cannot replace the assertion error. Snapshot property enumeration keeps
its existing behavior. Native Bun 1.4.4 and the unchanged upstream
`test/js/bun/test/expect-formdata-tojson-crash.test.ts` qualify this difference.

Mixed object and primitive mismatches use labeled Expected and Received
sections. This keeps the object's class attached to Received, as the pinned
FormData test requires. Native Bun 1.4.4 instead uses a multiline diff for this
case; its current formatting does not satisfy that pinned test's label check.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/bun_test.js`, diff formatting](#bun-test-diff-formatting) | Port | Translate Bun's colorless diff rendering around a local line differ. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
