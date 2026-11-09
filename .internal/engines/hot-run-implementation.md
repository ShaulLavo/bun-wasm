# Server hot-run implementation

Status: Approved. Implementation in progress.

Execute the reviewed design in `/work/reports/goals/engines/hot-run/PLAN.md` and its November 8 parent corrections. This branch owns server reload, loader sessions, source snapshots, diagnostics, watcher recovery and focused server regressions. The browser subscription and document update client remain separate work.

The acceptance gate is an imported file edit followed by a new HTTP response in the same process, realm and actual listener, including compile-error recovery. A passing server gate does not establish a browser DOM update.

The implementation starts from main after PR 522. It does not change Engine interfaces, shared-memory work, templates, matrix assertions or deadlines. PR 570's ordinary CommonJS changes remain separately owned.

## Source checkpoint

The implementation uses fresh same-realm record sessions and strict exact-byte snapshots. The first native Wasmtime/QuickJS fixture passed with a changed common core and a retained QuickJS side. The same fixture failed against the retained pre-feature core at its first edited-response assertion. JSC also passed the initial native fixture. These runs establish server response behavior, not browser DOM success.

The private read-only capability is `BunWasm.HotCommittedRevisions`. `HotServers.revisions(actualServer)` returns it. `subscribe` registers and delivers its current stamp synchronously, returns an idempotent unsubscribe, and delivers one close when listener ownership ends. Each immutable `HotSnapshot` holds `stamp`, `fetch`, optional `error`, `context` and its graph lease. The generation owner calls `publish` only after callback swap, graph ownership and watch reconciliation. Browser-only files remain separately owned.

Focused source tests and the runtime type project pass at this checkpoint. Matching browser/Waffle and full cross-engine non-hot regression proof remain in progress. No CI or independent implementation review is yet claimed.
