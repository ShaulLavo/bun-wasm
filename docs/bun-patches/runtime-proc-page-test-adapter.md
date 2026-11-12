# Runtime process page test adapter

Class **Host feature**, **original test adapters** in
`web/tests/runtime-proc-ios-adapter.ts`, `runtime-proc-page-contract.ts`,
`runtime-proc-page-suite.ts`, and `runtime-proc-result.ts`.
No upstream Bun, Node or WebKit source is copied or patched.

`browser-runtime-proc.ts ios-safari --result /absolute/result.json` uses the
published Waffle page runner with an exact `IOS_UDID`. Dispatch precedes
Playwright value imports. Its complete default inventory is pipes/automatic,
pipes/explicit, job-wait/automatic, and job-wait/explicit. Native execution
rejects stress and subset environment overrides. Desktop selection is unchanged.

The command retains one absolute 160-second clock from before native setup,
a 40-second result wait after navigation for each row, and the original
20-second page guest sequence limit. Desktop retains its original formula for
multiple browsers and iterations. Both hosts call `checkRuntimeProcResult`,
which requires strict success, complete ordered checks, the original stop codes,
zero active and forced workers, and an empty observed error array.

`runtime-proc-case-runner.ts` holds the complete original page fixture from
bun-wasm `2609b9d39e8548751f5895a191c28458bf4df942`. It adds a callable envelope,
the supported filesystem `name` option, and a return after the original finally.
The original body, diagnostics, blocking wait-job observer, assertions and
finalizer have a frozen TypeScript printer hash in the source controls.
The original finally still awaits disposal, records forced workers, terminates
remaining workers, revokes bootstrap URLs, restores Worker and publishes the
result. A disposal failure still replaces provisional success.

Hosted list and finish never import that fixture or replace Worker. Each case
awaits an allocation ACK for exactly `bun-runtime-proc-${run}` before importing
and invoking it. Sequential rows reuse that name after original runtime disposal.
Finish calls the shared exact-ledger storage cleanup. Native page error and
unhandled rejection listeners preserve observed messages, and a page-owned
console.error observer also forwards late console failures to the shared reporter
until document retirement. Shared host observation remains active throughout.

Asset preparation uses the existing `processBundle("runtime-proc", out)` through
the same cancellable, joined subprocess helper used by the process command.
It retains the full output closure, MIME types and captured process-bundles
branch. No guest, engine or alternative producer is added. Captured assets must
come from the exact adapter source and installed Waffle tuple. A historical
compiled page cannot supply the new hosted entry.

Source controls exercise allocation rejection, every host assertion, complete
ordered inventory, original finalizer ordering and failure, and frozen fixture
preservation. `checks/web-browser-runtime-proc-page-hosted.json` assigns real
Chromium and WebKit hosted controls to the existing browser owner. They run all
four rows, verify owned storage deletion and a foreign database sentinel, reject
host assertion failures, and reject a console failure after provisional success.
They verify session, launcher, listener, storage and scratch cleanup. These local
browser controls do not claim native iPhone acceptance.
