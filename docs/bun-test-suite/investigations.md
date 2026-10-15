# Baseline investigations

## What the rerun changed

Main `a8ef9ca` was measured first with copied artifacts, six QuickJS workers, loopback isolation, and the pinned dependency installation. That run had 282 fully passing files, 12,651 observed passes and 61 timeouts. After the fixes, a fresh full run at runtime commit `5ed3e9e` has 282 fully passing files, 12,663 observed passes and 57 timeouts. The four-file timeout difference includes ordinary deadline variability; only two upstream timeout files have a demonstrated fix in this branch.

Compared with the checked-in baseline, the final run gains 149 fully passing files and loses four, for a net gain of 145. It resolves 64 old timeouts and exposes 31 new ones. These totals include setup improvements from installing the complete checked-in dependency manifest. They are not a pure runtime A/B comparison.

## Fixes made here

- `50f204e` fixes shared-pipe EOF ordering. A reader could snapshot an empty pipe, then observe close after the producer published its final bytes, returning EOF before reading them. The deterministic interleaving test fails before the fix and passes after it. The existing WebKit/JSC subprocess browser check caught the real symptom: 1,048,576 bytes received from a 1,200,000-byte stdin write. Full web verification passes after the fix.
- `5ed3e9e` rejects command arrays longer than `u32::MAX - 2` before mapping them, matching pinned Bun. The old validation fixture reaches its three-second process deadline without printing a result. The new fixture completes on all engines. The upstream large-array file changes from a 15-second timeout with no outcomes to two passes and one failure in 0.165 seconds. The remaining assertion invokes the external `echo` executable, which is unavailable.
- The same commit rejects unsupported `Bun.spawn` IPC callbacks instead of silently accepting them. `websocket-custom-headers.test.ts` previously waited forever for a child URL callback and reached its file deadline. It now finishes in 0.165 seconds with ten explicit unsupported-IPC failures. This does not implement WebSockets or IPC.
- `3b0a4dc` adds subprocess, filesystem and WASI source hashes to browser-run provenance, so a transport change cannot silently reuse an incompatible checkpoint.

The report generator now ignores numbered source excerpts when selecting an error, requires evidence for missing subprocess capabilities, removes broad `/spawn`, `/child_process` and `/jsc` path verdicts, and avoids calling every missing `.parse` method a data-parser gap. Private instrumentation imports remain separate from public engine behavior.

## The earlier 745-file selection

The self-spawn lane selected `cli/`, `regression/`, `js/bun/spawn*`, `js/node/child_process*`, and `bundler/bun-build-api.test.ts`. Extracting those exact 745 paths from the saved full runs reproduces its original before numbers: 48 fully passing files, 215 passes and 14 timeouts.

| Measurement | Fully passing files | Observed passes | Timeouts |
|---|---:|---:|---:|
| Previous baseline on these 745 paths | 48 | 215 | 14 |
| Self-spawn lane's reported result | 103 | 1,063 | 30 |
| Current main, before this branch's fixes | 112 | 1,134 | 10 |
| Final branch run | 112 | 1,134 | 8 |

All fourteen originally timed-out paths in this selection now finish. The final eight are:

| File | Current reason |
|---|---|
| `cli/check/check.test.ts` | Large unavailable-check-command matrix; 60-second control completes in 13.865 seconds at lower concurrency with 10 passes and 605 failures. |
| `cli/hot/hot.test.ts` | Unsupported hot reload and repeated reload-marker waits. Still timed out at 60 seconds. |
| `cli/lint/config-files.test.ts` | Large lint/config matrix. Completes in 30.281 seconds with 24 passes and 1,046 failures. |
| `cli/lint/oxc-names.test.ts` | Lint/parser-case matrix. Serial control finishes in 3.571 seconds with 35 failures. |
| `cli/test/isolation.test.ts` | Child test isolation matrices. Completes in 36.124 seconds with 7 passes and 39 failures. |
| `cli/test/parallel.test.ts` | Unsupported parallel runner semantics and intentional worker failures. Longer trace reaches individual 20-second timeouts and remains unfinished at 60 seconds. |
| `js/bun/spawn/spawn-signal.test.ts` | Synchronous child sleeps 100 seconds while its parent expects a 10-ms `AbortSignal.timeout`. `spawnSync` polls native I/O without servicing JS timers or checking a newly aborted signal. |
| `regression/issue/42989.test.ts` | Parent waits for a server child to print its idle-timeout error before killing it. The missing idle-timeout callback leaves stdout read pending. |

Fix the last two in the runtime, not by giving the census a larger deadline. Start at `spawn.js:274` for synchronous cancellation and `net.js` server request/idle-timeout handling for the regression fixture. Do not implement arbitrary OS subprocesses to make the external-command cases pass.

## Longer timeout controls

The 15-file main-revision control uses a 60-second file deadline, unchanged 2-second initial per-test deadline, and two workers. Thirteen files finish; five fully pass. A separate fixed-runtime control confirms the two spawn fixes and structured cloning. These records remain separate from the 15-second baseline.

| File/group | Result with the longer deadline |
|---|---|
| `glob/leak.test.ts` | 4 passes, zero failures, 29.509 seconds; each case performs 100,000 filesystem scans. |
| `jsonl/jsonl-parse.test.ts` | 312 passes, 3 failures, 21.247 seconds. The remaining failures are two 4-GiB allocations and excessive nesting, as documented in `docs/parsers-glob.md`. |
| Four main-run source-lint timeouts | All pass: byte-search 3 tests in 9.432 seconds; dead-code-escapes 1 in 2.467 seconds; empty-jsvalue-laundering 2 in 3.119 seconds; port-era-markers 7 in 3.821 seconds. These files glob/read the source census before registering tests. |
| `bun-object/deep-equals-temporal.test.ts` | 16 passes, 61 failures, 22.514 seconds; equality/calendar behavior and unavailable time-zone support remain. |
| `gc/gc-controller-cadence.test.ts` | 3 passes, 15 failures, 32.726 seconds; several child programs deliberately idle for seconds and inspect unavailable GC instrumentation. |
| `cli/watch/watch.test.ts` | 2 passes, 12 failures, 22.226 seconds; unsupported watch behavior. This file finishes within 15 seconds in the final census. |
| `structured-clone-fastpath.test.ts` | 93 passes, zero failures, 13.134 seconds in a serial control, and fully passing in the final census. The initial main run had timed out after 83 passes. |

Two additional source-lint files reach the deadline in the final census. Both pass in a serial 60-second control: `fn-long-mut-reborrow.test.ts`: 3 passes in 3.169 seconds, `frozen-nonnull-reborrow.test.ts`: 2 passes in 4.821 seconds.

All 57 remaining timeouts have source locations, a diagnosis and confidence in [timeout-diagnoses.tsv](timeout-diagnoses.tsv). Several network cases remain source-backed hypotheses rather than traced root causes. The table distinguishes large stress loops from parent/child waits and missing protocol callbacks. It does not label them orphaned-pipe bugs without evidence. Terminal options are another narrow boundary gap: `spawn.js` accepts terminal options without creating a terminal, leaving callbacks unresolved. Reject unsupported terminal options before starting the child, then rerun `js/bun/terminal/terminal-platform-gaps.test.ts`.

Reproduce any remaining timeout without modifying upstream tests:

```sh
source env.sh
file=js/bun/spawn/spawn-signal.test.ts
scripts/bun-suite.sh --network loopback --jobs 1 --timeout 60 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output "/work/tmp/bun-wasm-timeout-${file//\//_}.json" "$file"
```

The runner intends to recognize the parent report, but an inherited child report can also set its `complete` observation. The single final QuickJS timeout with a report is `js/node/http/node-http-connect.test.ts`, whose trace contains nested test commands. It is not evidence that the shutdown fix regressed.

## Formerly passing files

The final baseline has four formerly fully passing files that now fail. Each has a concrete explanation:

| File | Investigation |
|---|---|
| `js/bun/io/fetch/fetch-abort-slow-connect.test.ts` | Loopback isolation immediately rejects the external TEST-NET-1 address with `TypeError`; the test expects a later `TimeoutError`. An unchanged-artifact host-network control passes all 3 tests. This is a documented isolation difference. |
| `js/node/promise/reject-tostring.test.ts` | Old false positive: the test compared two identical unsupported-spawn results, one for `node`, one for Bun. Bun now starts; external Node remains unavailable, and Bun's `--unhandled-rejections=throw` flag is also unimplemented. Matching those two errors again would conceal the actual gaps. |
| `regression/issue/01466.test.ts` | Both revisions print 2 passes followed by unhandled unsupported `crypto.subtle.generateKey` errors because the test does not await its helper. The old process exited zero; the shutdown fix correctly makes the unhandled errors exit nonzero. Crypto support remains missing. |
| `regression/issue/015201.test.ts` | Both revisions print 1 pass followed by an unhandled promisified-timer `ERR_INVALID_ARG_TYPE`. The old zero exit hid it; the final runtime exits nonzero. Implement timer promisification in `builtins.js`/timer globals rather than restoring the false pass. |

`js/web/structured-clone-fastpath.test.ts` was an additional initial-run decrease, but its serial control and final census both pass all 93 tests. No unexplained formerly passing file remains.

## Next fixes

Rank by the size of the observed first-blocker group and a bounded implementation slice. Counts below describe files and already observed failures in their first-blocker context; they are opportunity estimates, not promised future passes. Collection blockers hide further tests, so their synthetic one-failure counts do not estimate eventual coverage. Exclude the parallel DevServer/WebSocket work.

<!-- next-fixes:start -->
| Rank | Work | Measured opportunity | Where to change what | First slice |
|---|---|---|---|---|
| 1 | Boolean matchers | 12 files; 320 observed failures | `bun_test.js` expectation methods. Implement `toBeTrue` and `toBeFalse` using exact boolean comparison and existing negation handling. Start with `js/bun/glob/match.test.ts`. | 30–60 minutes |
| 2 | Pinned pure-JS dependencies | At least 18 explicit collection blockers: supertest 9, sinon 5, https-proxy-agent 4 | Dependency manifest and lockfile. Install supertest 6.3.3, sinon 6.0.0 and https-proxy-agent 7.0.6 from upstream `test/package.json`; rerun only those import groups. Native packages remain separate platform work. | 30–60 minutes per package |
| 3 | Async disposal on HTTP and TCP servers | 16 files; 137 observed failures | `net.js` Server classes at lines 777 and 1090. Add `Symbol.asyncDispose` over real close/drain completion, including error propagation. Reproduce `js/node/http/node-http-connect.test.ts` before changing close behavior. | Half a day for a bounded slice |
| 4 | Snapshot matchers | 64 files; 1309 observed failures | `bun_test.js` matcher/printing code. Implement inline snapshots first, then file snapshots with stable formatting and property matchers. Rerun `js/bun/yaml/yaml.test.ts` and `js/bun/jsonc/jsonc.test.ts`; do not make absent snapshots unconditional passes. | 1–2 days for the first slice |
| 5 | Portable caller-source tracking | 83 first-blocker collection failures | `builtins.js` bun:jsc module at line 1102, engine stack/source metadata, and upstream `bundler/expectBundled.ts`. Export `callerSourceOrigin` with measured caller identity across engines, then rerun the 83 import-blocked files. DevServer execution remains with its other lane. | 1–2 days |
| 6 | Node test adapter | 29 explicit first-blocker contexts; collection failures | Builtin registry plus `bun_test.js`. Adapt `node:test` callbacks, hooks, skip/todo and assertion failure propagation onto the existing runner. Start with `js/bun/perf_hooks/histogram.test.ts`. | 1–3 days for the first slice |
| 7 | Bun.ArrayBufferSink | 3 first-blocker collection failures; hidden test counts unknown | `bun.js`, shared byte/stream helpers and native output boundaries. Add constructor/start/write/end/flush semantics. Start with `js/bun/spawn/spawn.test.ts`, `js/bun/util/arraybuffersink.test.ts` and `js/web/streams/streams.test.js` as listed by the index. | 1–2 days |
| 8 | Bun.semver | 3 first-blocker contexts; collection failures | `bun.js` public exports and Rust parser natives. Reuse pinned `bun_semver` rather than inventing a second version parser. Start with `js/node/child_process/child_process.test.ts` and `js/bun/test/ci-restrictions.test.ts`; private `semverIntersects` instrumentation is separate. | About 1 day |
| 9 | Bun TCP callbacks | 17 first-blocker files | `bun.js` listen/connect stubs and `net.js:982`. Adapt the existing TCP host API to Bun socket callbacks and ownership. Start with `js/bun/net/tcp-server.test.ts`, then rerun the exact first-blocker group. | 1–3 days |
| 10 | Bun.Cookie and CookieMap | 5 first-blocker contexts; 81 observed failures | `bun.js` public API. Implement attribute parsing/validation and serialization with existing Headers. Start with `js/bun/cookie/cookie.test.ts` and `cookie-exotic-inputs.test.ts`; generic missing `.parse` errors must not be sent back to TOML/YAML work. | 1–2 days for parsing and validation |
<!-- next-fixes:end -->

## Verification and cleanup

All three engines were rebuilt in private Cargo targets, six jobs per build, within 4-GiB systemd scopes. All 73 local fixtures pass on each engine. `scripts/test-web.sh` passes type checks, 12 web tests, CLI network checks, Chromium, WebKit and browser subprocess checks. The report classifier's nine focused tests pass. The final report is regenerated twice and checked for identical bytes.

Raw evidence is in `/work/reports/bun-wasm-baseline-2026-10-15/`. Preliminary comparison runs were interrupted when fixes changed their inputs. The baseline uses only `quickjs-fixed.json`, `browser-final.json`, and `jsc-final.json`. Builds, timeout controls, the host-network control and failing-before/passing-after checks have separate logs. The task removes its private target directories, dependencies and generated web output, and verifies that its runner scopes and servers have exited. The committed worktree and copied/rebuilt wasm files remain for coordinator review. Shared caches, other workers' resources and port 3000's pre-existing service remain untouched.
