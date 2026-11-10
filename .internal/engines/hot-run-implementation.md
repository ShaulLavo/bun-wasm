# Server hot-run implementation

Status: Approved. Implementation in progress.

Execute the reviewed design in `/work/reports/goals/engines/hot-run/PLAN.md` and its November 8 parent corrections. This branch owns server reload, loader sessions, source snapshots, diagnostics, watcher recovery and focused server regressions. The browser subscription and document update client remain separate work.

The acceptance gate is an imported file edit followed by a new HTTP response in the same process, realm and actual listener, including compile-error recovery. A passing server gate does not establish a browser DOM update.

The implementation starts from main after PR 522. It does not change Engine interfaces, shared-memory work, templates, matrix assertions or deadlines. PR 570's ordinary CommonJS changes remain separately owned.

## Source checkpoint

The implementation uses fresh same-realm record sessions and strict exact-byte snapshots. The first native Wasmtime/QuickJS fixture passed with a changed common core and a retained QuickJS side. The same fixture failed against the retained pre-feature core at its first edited-response assertion. JSC also passed the initial native fixture. These runs establish server response behavior, not browser DOM success.

The private read-only capability is `BunWasm.HotCommittedRevisions`. `HotServers.revisions(actualServer)` returns it. `subscribe` registers and delivers its current stamp synchronously, returns an idempotent unsubscribe, and delivers one close when listener ownership ends. Each immutable `HotSnapshot` holds `stamp`, `fetch`, optional `error`, `context` and its graph lease. The generation owner calls `publish` only after callback swap, graph ownership and watch reconciliation. Browser-only files remain separately owned.

Focused source tests and the runtime type project pass at this checkpoint. Matching browser/Waffle and full cross-engine non-hot regression proof remain in progress. No CI or independent implementation review is yet claimed.

The external native control additionally repairs an initially malformed entry and deletes/recreates an imported file while keeping the prior HTTP callback. Its teardown checks real port reuse. The browser-owned guest check uses the same dependency-free CLI fixture in Waffle and explicitly treats the Node fixture host's ENOTSUP watch result as a negative control. Neither check changes a Hono template or goal deadline.

## Local proof

The source checkpoint passes the dependency-free live fixture on native QuickJS, JSC and experimental SpiderMonkey, plus the actual Waffle path in Chromium and Linux WebKit. Linux WebKit is not desktop Safari. The separate native external driver recovers an initially malformed entry, keeps the last response after imported-file deletion, recovers on recreation, and verifies port reuse after teardown.

The five non-hot controls pass on native QuickJS, JSC and SpiderMonkey and on browser-host store/native and records/hooks configurations. They cover text imports, source cache, ordinary engine modules, direct default re-exports and TypeScript stacks. A browser response proof still does not establish DOM updates.

The new browser fixture is a maintained transcript caller. It uses the explicit `prompt=off` arm, and its registration is checked by the existing automatic Web owner. A local isolated Bun install needed a local root `@types/node` link for two existing standalone type probes. No dependency manifest or type-check policy was weakened.
