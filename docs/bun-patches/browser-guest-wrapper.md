# Browser guest wrapper boundary

Classification: original adapter. No upstream implementation is copied or patched.

`scripts/browser-guest-wrapper.ts` adapts the local coverage foundation at
`25cb86e72528a783356ea479a0029da042a019a6` to the scheduled wrapper environment.
It requires an explicit owner, engine subset, browser leg, artifact root and report
root. It verifies the owner's selected closure and supplies the verified serving
root to children. It finalizes the durable ledger on failures and removes private
scratch only after the existing supervisor proves descendant drain.

The source-only controls use synthetic verified sites and owned small children.
They do not qualify guest runtime behavior or replace the original browser drivers.

`scripts/browser-existing-drivers.ts` preserves the installer, subprocess and
network driver commands and requires their complete positive markers. Subprocess
always runs the full API, executable, stdin, configuration, pipe and Worker
continuations. Each selected engine has its own supervised child.

`web/tests/browser-tools.ts` remains the original local tools driver, with explicit
engine and serving-root options. The intentional
wrong QuickJS payload now comes from that same root, including for Browser and
JSC rows. Result markers follow the original negative and final cache assertions.
No upstream source is adapted. The local source revision is the foundation named
above; the original driver assertions, context reuse and operation order remain.

The tools driver and `web/tests/tools-lifecycle.ts` are original diagnostic
adapters. They synchronously record each awaited operation, body errors and the
existing five-minute guard before awaiting cleanup. Cleanup failure remains
blocking and retains a primary body failure. These records cannot satisfy the
two original coverage markers. Initial navigation reuses
`web/tests/playground-navigation.ts` with an explicit `load` wait, preserving this
driver's original readiness condition and timeouts. The helper's other consumers
retain their existing `domcontentloaded` default. Its original-request journal
is owned by the session scratch and reported before that scratch is removed.
The tools owner declares both imported diagnostic helpers as coverage inputs.
