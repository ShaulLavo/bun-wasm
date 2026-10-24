# HTML handler lifetime

Status: Approved. The recovery candidate is unmerged. Native validation of its
final source remains pending.

An abandoned native handler Promise must reject the output read and close its
parser session. Output cancellation must release the input graph even when the
caller retains the handler Promise and output reader. The independent waiter
lives outside the observed Promise's closure and settles when Rewrite closes.

The recovery checkpoint is `d2a2db3a545a52edeaef871489cc6236b0bef1ea`.
Its native-Promise shortcut bypassed observable `then` access. A throwing getter
and an overridden callable were ignored, while a non-callable `then` parked the
rewrite. The recovery fixes all three contracts without changing global Promise
machinery. Constructor and species operations retain ordinary `then` behavior.

Independent source review found that the browser engine's `isPromise` hook walks
the prototype chain. Calling it added a second Proxy prototype query before a
custom `then`, or replaced the intrinsic incompatible-receiver error with a Proxy
trap error. The correction selects attachment by the already-read method alone.
The captured intrinsic validates its receiver, with synchronous cleanup on error.
No engine hook, global Promise, or lifetime ownership changed.

Run the cheap adapter regression and source-emission checks:

```sh
source env.sh
bun test scripts/html-handler-observation.test.ts scripts/runtime-emission.test.ts
```

The adapter tests use the repository's actual TypeScript erasure script, genuine
host streams and GC, and a small parser-event seam. They verify abandonment with
held readers, input collection before handler settlement after cancellation,
exact rejection objects, receiver identity, and ignored fulfillment values. The
default seam supplies the actual browser hook expression rather than a genuine
brand check. Both Proxy regressions, species access and errors, falsy failures, and
reentrant cancellation are covered. A genuine-brand control remains separate.
They measure calls to `htmlClose`, not native parser memory or guest-engine GC.
One Web discovery manifest owns the regression in CI. Local runtime preflight
also selects it; Rust CI does not repeat it.

The corrected source check passed 31 tests and 192 assertions. Both Proxy cases
failed before the correction and pass afterward. Strict runtime and
test typing, changed-file lint, owned Rust formatting and shell syntax also
passed. The three focused failure cases first failed against the checkpoint.

A retained raw QuickJS guest passed `html-handler-lifetime` during recovery.
Its SHA-256 is
`2bffe7a1c9fbd40a1f9212bfea49b225b237c9219a7ab451aca98edfa3254b02`.
Its complete embedded HTML payload matches `38c84048` and `42e1b3a9`, not the
checkpoint or final source. It has no original build receipt. That run is only
historical lifetime evidence, not final-source guest acceptance. No baseline,
JSC, or other guest build was run during recovery.

Exact logs, artifact qualification, dirty-tree preservation and cleanup evidence
are in `/work/reports/bun-wasm/html-lifecycle-20261024/recovery-20261024`.
The source-review correction evidence is in
`/work/reports/bun-wasm/html-lifecycle-20261024/correction-r1`.
The unchanged upstream lifecycle file and all-engine final-source acceptance
remain separate from these bounded checks.

## Current integration limits

The current-main integration includes only the source-approved runtime change
and its original source controls and lifetime fixture. The later 17-file acceptance
harness and expanded guest contracts at `2d3ccc23f3ba77de5836cc2d4ec0c2b43344f088`
are excluded. Their independent review has no verdict after refusal. Final-source
guest qualification and the required all-engine matrix remain blockers. Nothing
in this integration retries that harness or reclassifies historical guest evidence.
