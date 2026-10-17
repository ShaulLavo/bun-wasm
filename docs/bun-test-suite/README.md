# Bun's upstream suite

A bounded compatibility census of the pinned Bun tests, measured on 2026-10-15. Tests run unchanged, one file per process. Counts describe observed results, including collection failures, rather than assertions that native Bun would eventually execute.

<!-- baseline:start -->
## Measured baseline

Upstream `4ceda2c2868d3a7703c7737ddd9de7244ec384df`, engine `quickjs`.

2,305 files; 282 fully passing; 12,663/43,144 observed tests passing; 57 file timeouts.

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| bake | 27 | 1 | 1/37 | 0 | 0 |
| bundler | 107 | 9 | 212/908 | 23 | 1 |
| cli | 257 | 5 | 720/10,241 | 258 | 44 |
| config | 2 | 0 | 0/51 | 2 | 1 |
| integration | 23 | 3 | 51/80 | 0 | 1 |
| internal | 66 | 36 | 556/652 | 9 | 0 |
| js/bun | 557 | 62 | 6,064/13,994 | 402 | 535 |
| js/deno | 16 | 0 | 0/16 | 0 | 0 |
| js/first_party | 7 | 0 | 1/19 | 0 | 0 |
| js/junit-reporter | 1 | 0 | 0/9 | 0 | 0 |
| js/node | 340 | 33 | 2,363/4,600 | 118 | 16 |
| js/sql | 71 | 0 | 0/76 | 4 | 0 |
| js/third_party | 120 | 13 | 174/601 | 9 | 11 |
| js/valkey | 15 | 0 | 2/41 | 8 | 0 |
| js/web | 185 | 16 | 908/8,220 | 96 | 5 |
| js/workerd | 3 | 0 | 2/250 | 1 | 0 |
| napi | 60 | 0 | 0/153 | 0 | 21 |
| packages | 15 | 2 | 1,233/2,110 | 0 | 0 |
| regression | 430 | 100 | 354/1,061 | 44 | 0 |
| root | 1 | 1 | 21/21 | 0 | 0 |
| snippets | 1 | 1 | 1/3 | 0 | 2 |
| v8 | 1 | 0 | 0/1 | 0 | 0 |

| Category | Meaning | Failing files | Observed tests passed/total |
|---|---|---|---|
| a | platform limitation | 87 | 30/450 |
| b | missing subprocess capability | 67 | 29/1,277 |
| c | fixable, small | 147 | 2,112/3,928 |
| d | fixable, big | 1505 | 5,270/30,897 |
| e | not worth the cost | 92 | 7/116 |
| f | engine difference | 18 | 26/479 |

1,916 failing files + 282 fully passing + 107 empty/skip-only = 2,305 files.


Categories are mutually exclusive first-blocker assignments. Passing, empty and skip-only files are excluded. 'Needs reproduction' is a conservative big-work bucket, not a claim that every assertion failure needs a subsystem rewrite. No unexecuted tests are counted.

| Engine | Compared files | Fully passing | Observed passes | File timeouts | QuickJS failures passing here | QuickJS passes failing here |
|---|---|---|---|---|---|---|
| browser | 1082 | 116 | 15143 | 43 | 18 | 13 |
| jsc | 1082 | 113 | 8878 | 46 | 5 | 3 |

### browser comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| js/bun | 557 | 62 | 11,873/24,225 | 408 | 536 |
| js/node | 340 | 32 | 1,887/4,718 | 121 | 16 |
| js/web | 185 | 22 | 1,383/8,431 | 116 | 5 |

### jsc comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| js/bun | 557 | 62 | 6,269/14,265 | 403 | 536 |
| js/node | 340 | 35 | 1,847/3,884 | 114 | 14 |
| js/web | 185 | 16 | 762/7,949 | 114 | 5 |
<!-- baseline:end -->

## Reading the results

[summary.json](summary.json) records artifact hashes, upstream revision, deadlines, categories, engine comparisons and changes since the previous baseline. [failures.tsv](failures.tsv) gives every failing file a first error, test name, category and confidence. [triage.md](triage.md) groups those assignments and lists all timeouts and formerly passing files. [investigations.md](investigations.md) explains the regressions, timeout controls and the ten next fixes.

A fully passing file must exit zero, finish a test report, have at least one pass, and have no reported failures or unhandled errors. Empty and skip-only files are separate. Observed totals include skips, todos and the runner's synthetic collection failures. They exclude tests that never registered. A timeout preserves only the results seen before the deadline.

Self-spawn means that inherited child output can also contain test markers and reports. A report observed before a timeout does not establish that the parent finished. A child's summary can replace earlier counters in an unfinished file; treat counts from these files as bounded observations, not a complete parent-test count. Individual first-blocker assignments are provisional when marked `needs reproduction`.

Discovery includes tracked files under `test/` ending in `.test`, `_test`, `.spec` or `_spec` with a JS/TS extension, including fixture tests. This revision contains 2,305 such files. This is a source census, not Bun's CI shard manifest. Untracked files and submodules are excluded. Explicit JS/TS file paths can also select Node assertion scripts outside that naming pattern. Those run with `bun run`; a clean exit counts as a passing file and adds no observed test count. The suite is Bun 1.4.4 with local WASI patches; installed native Bun 1.4.2 only sets up dependencies and drives host-side verification.

Categories describe the current first blocker. Category b now requires evidence of a missing subprocess capability, such as an external executable, IPC or descriptor redirection. Using `spawn` in a failing test no longer qualifies by itself. Category c covers bounded helpers and setup gaps. Category d includes unresolved behavior until reproduced. Category a covers native or OS facilities beyond the host ABI; TCP itself already works. Category e covers private native-engine instrumentation. Category f means a measured QuickJS failure fully passes on another engine, without claiming a root cause.

## Node adapter selection

`--node-parallel` also discovers tracked `test-*.js`, `.mjs` and `.cjs` scripts
in Node's parallel directory. Plain assertion scripts use `bun run`, so delayed
callbacks remain part of the process lifetime. Files importing `node:test` use
the test runner. A plain script passes only after a clean process exit; its
assertions are not converted into invented subtest counts. Native script skips
remain skips. `--log-dir` retains bounded output from every selected file.

The fixed [stream adapter selection](stream-adapter-files.txt) contains 22 files.
Run it on each built engine with the same launcher, deadlines and dependency set:

```bash
source env.sh
mapfile -t files < docs/bun-test-suite/stream-adapter-files.txt
scripts/bun-suite.sh --node-parallel --engine quickjs --jobs 1 --timeout 15 \
  --network loopback --output /work/tmp/bun-wasm-adapters/quickjs.json \
  --log-dir /work/tmp/bun-wasm-adapters/quickjs-logs "${files[@]}"
```

Run this through the host's heavy-job wrapper. Repeat with `--engine jsc` and
`--engine browser`, using fresh output paths. Compare file outcomes separately
from registered test counts, and check matching suite, runner and dependency
hashes before comparing revisions.

The focused [HTMLRewriter and X509Certificate measurement](htmlrewriter-x509.md)
records the 2026-10-17 API selection, all-engine gates and wasm size changes.

## Reproduce

From a checkout with the pinned `vendor/bun` and all three wasm artifacts built:

```sh
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-suite-target
systemd-run --user --scope -p MemoryMax=4G nice -n 5 \
  cargo build -j 6 --release -p bunwasm-host
BUN_INSTALL_CACHE_DIR=/work/cache/bun bun install \
  --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
results=/work/tmp/bun-wasm-bun-suite-results-new
systemd-run --user --scope -p MemoryMax=4G nice -n 5 \
  scripts/bun-suite.sh --network loopback --jobs 6 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output "$results/quickjs.json"
systemd-run --user --scope -p MemoryMax=2G nice -n 5 \
  scripts/bun-suite.sh --engine browser --network loopback --jobs 2 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output "$results/browser.json" js/bun js/node js/web
systemd-run --user --scope -p MemoryMax=2G nice -n 5 \
  scripts/bun-suite.sh --engine jsc --network loopback --jobs 2 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output "$results/jsc.json" js/bun js/node js/web
python3 scripts/bun-suite-report.py "$results/quickjs.json" \
  --compare "$results/browser.json" --compare "$results/jsc.json" \
  --previous /path/to/previous-full-quickjs.json --runtime-commit "$(git rev-parse HEAD)"
python3 scripts/test-bun-suite-report.py
```

Each file has a 15-second wall limit excluding snapshot setup/reset. The initial per-test limit is 2 seconds; tests can override it. Longer diagnostic runs retain their own JSON and never replace the bounded baseline. Repeat any timeout with the same runner command, a new output path, `--jobs 1 --timeout 60`, and its exact file path from the index. Preserve cleanup ownership when creating your own target or evidence directory.

`--network loopback` gives every test process an independent user/network namespace with loopback enabled. Fixed-port tests can bind port 3000 without touching the owner's existing listener. This needs Linux `unshare` and `ip` and has no route to external networks. For an external-network control use `--network host`, the exact affected file, and a separate output path. The mode is part of provenance.

`--resume` requires identical suite, wasm, launcher, runner, host sources, dependencies and deadlines. `--resume --rerun --jobs 1 'path/to/file.test.ts'` replaces selected records while retaining the rest. Quote shell globs. The JSONL checkpoint survives handled interruption; the JSON summary is rewritten on exit. `wall_seconds` describes the latest invocation, so selective reruns replace that value. A completed census exits zero even when upstream tests fail. Runner errors and interruption exit nonzero.

## Isolation and harness

QuickJS and JSC use the native launcher and its networking/subprocess ABI. The browser comparison uses Node's host engine with `--net`. Only the private source snapshot at `/bun` and a private `/tmp` are preopened. Host and guest cwd are the snapshot's `test/` directory. The runner uses the actual upstream shared harness and `bunfig.toml` preload. Generated alias packages resolve harness imports because general tsconfig paths are not implemented. No upstream test or harness source changes.

Every worker owns a source snapshot, restores tracked changes and deletes generated files after each test, verifies clean Git status, then clears its temp directory. Snapshot attributes preserve fixture bytes. Per-file process groups are killed and reaped on timeout/interruption. The runner removes its scratch directory on success, failure and handled signals. After an uncatchable SIGKILL, inspect the named scratch directory and its processes before deleting it.

Pinned supplemental dependencies are installed from the checked-in manifest and lockfile. The new run installs all 198 packages, with 4,248 hashed files, versus 137 dependency files in the previous baseline. Root upstream dependencies are unchanged at 537 files. This setup change is recorded in provenance and contributes to progress; it is not a pure runtime comparison. Native addons and the full upstream framework/app dependency graph are not installed. Missing packages remain setup blockers.

`bun:jsc.heapStats()` exposes engine memory totals with unavailable per-type/protected counters left empty or zero. Passing leak assertions against these counters does not establish leak freedom. `isASANEnabled()` is false, and unsupported unsafe operations still throw. Self-spawn runs fresh wasm instances, never native Bun. External programs, child IPC, terminals, real OS process trees and several stdio modes remain unsupported.

## Verification and retained evidence

The baseline started from main `a8ef9ca`, then reran after the focused fixes recorded in [investigations.md](investigations.md). [progress.json](progress.json) preserves the previous baseline and the intermediate main run as well as the final run. Category changes partly reflect corrected classification. The intermediate main row has no comparison-engine assignments, so its f count is zero. Artifact hashes and runner revisions identify the actual measured inputs.

Raw JSON, JSONL, command logs, diagnostic output tails and the source diagnosis table are retained in `/work/reports/bun-wasm-baseline-2026-10-15/` for coordinator review. The coordinator owns removal after accepting this baseline. The task removes private build targets, execution snapshots, generated web output and dependency installations, while leaving its committed worktree and wasm artifacts for review. Shared caches and the existing port-3000 service are preserved.

<!-- progress:start -->
## Progress

| Date | Runtime commit | Files fully passing | Tests passing | Timeouts | a | b | c | d | e | f |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-15 | 42262f8 | 137 | 5802 | 90 | 164 | 694 | 218 | 876 | 104 | 6 |
| 2026-10-15 | a8ef9ca | 282 | 12651 | 61 | 89 | 50 | 146 | 1523 | 108 | 0 |
| 2026-10-15 | 5ed3e9e | 282 | 12663 | 57 | 87 | 67 | 147 | 1505 | 92 | 18 |

Category counts use each run's classifier. The current classifier requires an explicit missing subprocess capability for b; category movement alone is not a compatibility gain.
<!-- progress:end -->
