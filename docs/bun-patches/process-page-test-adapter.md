# Process page test adapter

Class **Host feature**, **original test adapters** in
`web/tests/process-ios-adapter.ts`, `process-page-suite.ts`,
`process-page-adapter.ts`, `process-page-assets.ts`, and
`process-diagnostic-adapter.ts` and its `process-diagnostic-error.ts` helper.
No upstream Bun, Node or WebKit implementation is copied or patched.

The page wraps the original command in one callable envelope. Hosted list and
finish do not replace Worker or start the command. Hosted run awaits the actual
shared allocation callback before invoking the envelope. The original desktop
branch still invokes it once. The original case bodies, assertions and awaited
scope finalizers remain unchanged from bun-wasm
`3b46c7fb6cc4eef1fb5493d05ebf16a90473d396`.

The shared policy requires a result and validates a transported non-null record,
strict success, all 23 ordered labels and the actual page-error message array.
The page snapshots error messages separately from host transport and cleanup
failures. Shared error observation remains active through retirement. Results
return only after the original finally, including cleanup-failure replacement
and Worker restoration. Partial checks and currentTest survive failure.

The runtime filesystem uses the supported `name` option without changing its
IndexedDB fast default. The shared `ownedDatabase("bun-process")` policy accepts
only `bun-process-${run}`. The page awaits its allocation ACK before opening any
runtime. Sequential scopes reuse that exact name after disposal. Finish uses the
shared exact-ledger cleanup. The controller-root setup supplies the published
runtime's required `memory: []` declaration; it is a JavaScript controller, not a
registered guest program.

Asset preparation invokes only existing `processBundle("supervisor", out)` in
one owned Bun subprocess and preserves its captured-bundle branch. Cancellation
requests termination and joins the producer before settlement. Every output file
maps lazily under `/current/`, including chunks, Worker siblings, mirrors, maps
and index HTML. Blob MIME types are preserved. The shared host owns isolation
headers, token-bound documents, reserved routes and scratch cleanup.

The actual shared adapter retains a 120-second absolute clock from before setup,
a 90-second result wait after navigation, and the original 10-second page waits.
Native CLI dispatch precedes desktop-only Playwright value imports. Desktop
artifact and benchmark branches and their bounds remain unchanged.

`browser-process-hosted.ts` uses the public shared host and Playwright driver for
local diagnostics, including seeded foreign-data survival and errors before
retirement. It supplies the platform temporary directory as the shared host
scratch root, so the local browser controls do not require a `/work` mount.
The controls also run with an unusable inherited scratch root to verify that
this explicit caller option wins without changing storage or cleanup policy. Its seeded database belongs only to each fresh control profile.
List checks database absence before execution. Finish checks absence only after
acknowledged completion, under the existing combined 10-second observation bound.
The `delayed-finish` regression defers finish entry initialization by 500 ms;
it does not change command budgets or any original case. The late-error control
also permits the shared host's existing single interrupted-finish cleanup document,
never another execution of the case body.
The consumer uses published Waffle 0.0.111, source
`96acfb246bb565cd008ad498e08230829c3a773a`, through public tarball pins.
The page-suite object uses `satisfies PageSuite<ProcessRequest>` so its callable
page-owned run method stays narrow while the shared type also permits host-owned
cases. No private Waffle checkout or future `HostCase.allocateDatabase` API is used.
`checks/web-browser-process-page-hosted.json` gives the real Chromium and WebKit
controls to the existing browser gate. Source controls use the existing automatic
Web test owner. The original 16 callback bodies, 17 scope finalizers and command
finalizer have frozen printer hashes in `process-page-adapter.test.ts`, so the
preservation check also works in shallow CI checkouts.
No native or whole-suite acceptance is implied. The earlier iOS result at Bun
`04d9f359fc815aeb05785e6427e21f46383f2c6f` with unpublished Waffle `cf1972e3`
remains a failure at the fourth case, `cpu-default-signal-13-status-141`.
The filesystem-segment refusal has no recorded constructor ordinal or cause.
This dependency adoption does not change or explain that result.

## Optional same-document diagnostics

A diagnostic entry can install the test-only synchronous
`window.__bunProcessPageDiagnostic` callback before importing the original page
entry. `createProcessPageSuite` accepts that callback as its optional third
argument. It runs only after `runCases` resolves, including its awaited finalizer.
List and finish never invoke it. Without the callback, the result is unchanged.
A missing original result stays missing and does not invoke the callback.

The diagnostic envelope nests the exact `processResultForTransport` value under
`processResult`. It separately carries a `captured` JSON snapshot or an `error`.
Capture errors, unserializable values, and diagnostics over 16 KiB become
secondary errors rather than rejecting the case. The consumer snapshots the primary
JSON once and checks the complete serialized envelope against the shared page
runner's unchanged 48 KiB limit. If necessary it replaces diagnostics with a small
secondary omission error. When even that envelope cannot fit, it returns the exact
serialized primary without a wrapper and the diagnostic adapter delegates it
unchanged. It never truncates the primary or increases the shared limit. Error
formatting uses a bounded constant fallback if the thrown value cannot be printed. The callback must be synchronous and read-only.
It must not mutate the original result, throw page events, or start background work.

`processDiagnosticAdapter` preserves the original adapter settings and delegates
its policy check to the original check with the nested result, or the original
unwrapped result when diagnostic metadata cannot fit. It does not copy
or relax any process assertions. Use this adapter only with the diagnostic entry.
After the shared host writes the primary result, `writeProcessDiagnostics` writes
its separate diagnostic through the public `writeResult`. It returns write errors
as secondary data. The caller must retain the primary exit code, including when
the diagnostic sink fails. Neither a captured diagnostic nor a sink failure is a
new verdict on the original process case.
