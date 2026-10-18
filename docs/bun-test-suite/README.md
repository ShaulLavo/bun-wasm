# Bun's upstream suite

<!-- history-comparison:start -->
## Historical and current observations

QuickJS 282 → 411 is the sole comparable baseline by matched file selection, with all 2,305 files selected on both sides. JSC and browser are non-comparable. They previously selected 1,082 files under js/bun, js/node, and js/web, while each current run selected all 2,305 files. Runner, suite, and supplemental-dependency hashes changed on all engines, so the matched QuickJS selection does not establish an isolated runtime gain.

| Engine | Historical selected files | Current selected files | Historical result | Current result | Comparison |
| --- | --- | --- | --- | --- | --- |
| quickjs | 2305 | 2305 | 282 fully passing files; 12663 observed passes; 57 timeouts | 411 fully passing files; 20162 observed passes; 51 timeouts | Comparable baseline (matched selection) |
| jsc | 1082 | 2305 | 113 fully passing files; 8878 observed passes; 46 timeouts | 411 fully passing files; 19290 observed passes; 50 timeouts | Non-comparable |
| browser | 1082 | 2305 | 116 fully passing files; 15143 observed passes; 43 timeouts | 418 fully passing files; 29457 observed passes; 62 timeouts | Non-comparable |

| Input on all engines | Historical | Current |
| --- | --- | --- |
| Suite revision | 4ceda2c2868d3a7703c7737ddd9de7244ec384df | cd95fa7a13b3f13be73e512b38ec111c1c228084 |
| Runner SHA-256 | 402ec80ab03e0a367a6a8fc49fe6605847a37c99b69fb8f93d9c66ebc8539d44 | 9df69cce25bc9d94722cfd323d018943da08456e7c000c9d1f0c884426d52767 |
| Supplemental dependency files | 4248 | 2483 |
| Supplemental dependency SHA-256 | fa39a9d0c87fde12be431f502e4803f0445b844dfdbb59cd19773965e33046ae | 59663e62be14bd8b6cf77bf3eca5ccb4506ad635ed2c795327b238b32ea6e787 |
| Root dependency SHA-256 | febca47f17827dfe5386aec03585583cac2b7b12a587303447051d29a894d5f7 | febca47f17827dfe5386aec03585583cac2b7b12a587303447051d29a894d5f7 |
| File deadline / test deadline | 15 seconds / 2,000 ms | 15 seconds / 2,000 ms |

The historical inputs are preserved in [historical-summary.json](historical-summary.json). The current inputs are in [summary.json](summary.json). No historical artifact was rerun with the current runner and dependencies. Regenerate these tables with `bun scripts/refresh-compatibility-docs.ts`; `--check` rejects stale tables.
<!-- history-comparison:end -->

<!-- baseline:start -->
## Historical measured baseline

QuickJS is the sole comparable baseline by matched file selection. JSC and browser used a smaller historical selection and remain non-comparable. Changed runner, suite, and supplemental-dependency hashes prevent an isolated runtime-gain claim. See the input table above.

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

<!-- current:start -->
## Current measured run

Upstream `cd95fa7a13b3f13be73e512b38ec111c1c228084`, engine `quickjs`.

2,305 files; 411 fully passing; 20,162/58,881 observed tests passing; 51 file timeouts.

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| bake | 27 | 1 | 1/173 | 0 | 1 |
| bundler | 107 | 18 | 1,982/4,017 | 29 | 253 |
| cli | 257 | 5 | 1,141/13,368 | 1442 | 44 |
| config | 2 | 0 | 0/51 | 2 | 1 |
| integration | 23 | 3 | 50/81 | 0 | 1 |
| internal | 66 | 44 | 574/663 | 9 | 0 |
| js/bun | 557 | 82 | 8,101/15,335 | 405 | 536 |
| js/deno | 16 | 3 | 194/244 | 17 | 0 |
| js/first_party | 7 | 0 | 32/117 | 0 | 3 |
| js/junit-reporter | 1 | 0 | 0/9 | 0 | 0 |
| js/node | 340 | 42 | 2,896/5,600 | 165 | 25 |
| js/sql | 71 | 0 | 0/76 | 4 | 0 |
| js/third_party | 120 | 38 | 1,973/2,373 | 11 | 123 |
| js/valkey | 15 | 0 | 2/41 | 8 | 0 |
| js/web | 185 | 28 | 1,484/13,303 | 98 | 6 |
| js/workerd | 3 | 0 | 0/53 | 1 | 0 |
| napi | 60 | 0 | 0/153 | 0 | 21 |
| packages | 15 | 2 | 1,234/2,110 | 0 | 0 |
| regression | 430 | 143 | 476/1,089 | 46 | 1 |
| root | 1 | 1 | 21/21 | 0 | 0 |
| snippets | 1 | 1 | 1/3 | 0 | 2 |
| v8 | 1 | 0 | 0/1 | 0 | 0 |

| Category | Meaning | Failing files | Observed tests passed/total |
|---|---|---|---|
| a | platform limitation | 84 | 26/429 |
| b | missing subprocess capability | 81 | 52/1,091 |
| c | fixable, small | 54 | 314/476 |
| d | fixable, big | 1451 | 12,607/48,196 |
| e | not worth the cost | 93 | 7/117 |
| f | engine difference | 23 | 554/998 |

1,786 failing files + 411 fully passing + 108 empty/skip-only = 2,305 files.


Categories are mutually exclusive first-blocker assignments. Passing, empty and skip-only files are excluded. 'Needs reproduction' is a conservative big-work bucket, not a claim that every assertion failure needs a subsystem rewrite. No unexecuted tests are counted.

| Engine | Compared files | Fully passing | Observed passes | File timeouts | QuickJS failures passing here | QuickJS passes failing here |
|---|---|---|---|---|---|---|
| browser | 2305 | 418 | 29457 | 62 | 19 | 12 |
| jsc | 2305 | 411 | 19290 | 50 | 7 | 7 |

### browser comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| bake | 27 | 1 | 1/173 | 0 | 1 |
| bundler | 107 | 17 | 1,943/4,004 | 31 | 253 |
| cli | 257 | 4 | 1,036/12,526 | 1324 | 40 |
| config | 2 | 0 | 0/51 | 2 | 1 |
| integration | 23 | 3 | 50/81 | 0 | 1 |
| internal | 66 | 43 | 572/660 | 9 | 0 |
| js/bun | 557 | 84 | 17,882/25,112 | 405 | 536 |
| js/deno | 16 | 4 | 198/244 | 17 | 0 |
| js/first_party | 7 | 0 | 32/117 | 0 | 3 |
| js/junit-reporter | 1 | 0 | 0/9 | 0 | 0 |
| js/node | 340 | 42 | 2,565/5,150 | 162 | 25 |
| js/sql | 71 | 0 | 0/76 | 4 | 0 |
| js/third_party | 120 | 38 | 1,524/2,374 | 11 | 123 |
| js/valkey | 15 | 0 | 2/41 | 8 | 0 |
| js/web | 185 | 30 | 1,916/13,322 | 116 | 6 |
| js/workerd | 3 | 0 | 0/53 | 1 | 0 |
| napi | 60 | 0 | 0/153 | 0 | 21 |
| packages | 15 | 2 | 1,233/2,110 | 0 | 0 |
| regression | 430 | 148 | 481/1,090 | 46 | 1 |
| root | 1 | 1 | 21/21 | 0 | 0 |
| snippets | 1 | 1 | 1/3 | 0 | 2 |
| v8 | 1 | 0 | 0/1 | 0 | 0 |

### jsc comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| bake | 27 | 1 | 1/60 | 0 | 0 |
| bundler | 107 | 18 | 1,993/4,017 | 29 | 253 |
| cli | 257 | 5 | 1,142/13,078 | 1163 | 44 |
| config | 2 | 0 | 0/51 | 2 | 1 |
| integration | 23 | 3 | 50/81 | 0 | 1 |
| internal | 66 | 44 | 574/663 | 9 | 0 |
| js/bun | 557 | 83 | 8,094/15,432 | 405 | 536 |
| js/deno | 16 | 3 | 192/244 | 17 | 0 |
| js/first_party | 7 | 0 | 32/117 | 0 | 3 |
| js/junit-reporter | 1 | 0 | 0/9 | 0 | 0 |
| js/node | 340 | 43 | 2,371/4,934 | 162 | 24 |
| js/sql | 71 | 0 | 0/76 | 4 | 0 |
| js/third_party | 120 | 38 | 1,973/2,373 | 11 | 123 |
| js/valkey | 15 | 0 | 2/41 | 8 | 0 |
| js/web | 185 | 27 | 1,133/12,354 | 116 | 6 |
| js/workerd | 3 | 0 | 0/53 | 1 | 0 |
| napi | 60 | 0 | 0/153 | 0 | 21 |
| packages | 15 | 2 | 1,234/2,110 | 0 | 0 |
| regression | 430 | 142 | 477/1,088 | 46 | 1 |
| root | 1 | 1 | 21/21 | 0 | 0 |
| snippets | 1 | 1 | 1/3 | 0 | 2 |
| v8 | 1 | 0 | 0/1 | 0 | 0 |
<!-- current:end -->

### Current run provenance

The current replay used `scripts/bun-suite.sh` with `--network loopback`, a 15-second file deadline, a 2,000 ms test deadline, and the installed dependency tree at `docs/bun-test-suite/dependencies/node_modules`. It ran all 2,305 discovered files on each engine.

```sh
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-measure-suite-matrix/quickjs-target
deps="$PWD/docs/bun-test-suite/dependencies/node_modules"
scripts/bun-suite.sh --network loopback --jobs 6 --timeout 15 --dependencies "$deps" --output /work/reports/bun-wasm-main-2026-10-17/suite/quickjs.json
scripts/bun-suite.sh --engine jsc --network loopback --jobs 2 --timeout 15 --dependencies "$deps" --output /work/reports/bun-wasm-main-2026-10-17/suite/jsc.json
scripts/bun-suite.sh --engine browser --network loopback --jobs 2 --timeout 15 --dependencies "$deps" --output /work/reports/bun-wasm-main-2026-10-17/suite/browser.json
```

The suite revision was `cd95fa7a13b3f13be73e512b38ec111c1c228084`. The artifact hashes are QuickJS `794e4b24f5755f4f18d2e2aac5149d87de73f7d7f2c27fba2d0fdf8ff7ec82c9`, JSC `596e8f29bfd9d48c556b1f9a26ca9e8b9e439a4d8351551718cb13cbefe7b36f`, browser `accc747792ac2e53e4ea86e51b15c3f3ec5354e20516288d95a79aae7cea7e0e`, and native launcher `0b61ddaa7e30cbe3e26fbed3d3c78d529e8727462efd9f9eb302de7dcd38b300`. Artifact and launcher hashes are recorded in `/work/reports/bun-wasm-main-2026-10-17/artifact-sha256.txt`. The raw per-engine JSON and bounded logs are in `/work/reports/bun-wasm-main-2026-10-17/suite/`. The ranked next-fix list with reproduction commands and suspected file locations is in [triage.md](triage.md#ranked-next-fixes).


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
  --output "$results/browser.json"
systemd-run --user --scope -p MemoryMax=2G nice -n 5 \
  scripts/bun-suite.sh --engine jsc --network loopback --jobs 2 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output "$results/jsc.json"
python3 scripts/bun-suite-report.py "$results/quickjs.json" \
  --compare "$results/browser.json" --compare "$results/jsc.json" \
  --previous /path/to/previous-full-quickjs.json --runtime-commit "$(git rev-parse HEAD)"
python3 scripts/test-bun-suite-report.py
```

Each file has a 15-second wall limit excluding snapshot setup/reset. The initial per-test limit is 2 seconds; tests can override it. Longer diagnostic runs retain their own JSON and never replace the bounded baseline. Repeat any timeout with the same runner command, a new output path, `--jobs 1 --timeout 60`, and its exact file path from the index. Preserve cleanup ownership when creating your own target or evidence directory.

`--network loopback` gives every test process an independent user/network namespace with loopback enabled. Fixed-port tests can bind port 3000 without touching the owner's existing listener. This needs Linux `unshare` and `ip` and has no route to external networks. For an external-network control use `--network host`, the exact affected file, and a separate output path. The mode is part of provenance.

`--resume` requires identical suite, wasm, launcher, runner, host sources, dependencies and deadlines. `--resume --rerun --jobs 1 'path/to/file.test.ts'` replaces selected records while retaining the rest. Quote shell globs. The JSONL checkpoint survives handled interruption; the JSON summary is rewritten on exit. `wall_seconds` describes the latest invocation, so selective reruns replace that value. A completed census exits zero even when upstream tests fail. Runner errors and interruption exit nonzero.

## Isolation and harness

QuickJS and JSC use the native launcher and its networking/subprocess ABI. The browser comparison uses Node's host engine with `--net`. Only the private source snapshot at `/bun` and a private `/tmp` are preopened. The guest cwd is the snapshot's source root. Test paths and preloads are absolute, so discovery still selects files under `test/`. Earlier runs used `test/` as cwd; those runs print different relative report paths. The runner uses the actual upstream shared harness and `bunfig.toml` preload. Generated alias packages resolve harness imports because general tsconfig paths are not implemented. No upstream test or harness source changes.

Every worker owns a source snapshot, restores tracked changes and deletes generated files after each test, verifies clean Git status, then clears its temp directory. Snapshot attributes preserve fixture bytes. Per-file process groups are killed and reaped on timeout/interruption. The runner removes its scratch directory on success, failure and handled signals. After an uncatchable SIGKILL, inspect the named scratch directory and its processes before deleting it.

The current supplemental dependency tree has 2,483 hashed files, compared with 4,248 in the historical baseline. Root upstream dependencies retain the same 537 files and hash. The changed runner, suite revision, and supplemental dependency hash make these runs non-comparable as isolated runtime gains. Native addons and the full upstream framework/app dependency graph are not installed. Missing packages remain setup blockers.

`bun:jsc.heapStats()` exposes engine memory totals with unavailable per-type/protected counters left empty or zero. Passing leak assertions against these counters does not establish leak freedom. `isASANEnabled()` is false, and unsupported unsafe operations still throw. Self-spawn runs fresh wasm instances, never native Bun. External programs, child IPC, terminals, real OS process trees and several stdio modes remain unsupported.

## Verification and retained evidence

The baseline started from main `a8ef9ca`, then reran after the focused fixes recorded in [investigations.md](investigations.md). [progress.json](progress.json) preserves the previous baseline and the intermediate main run as well as the final run. Category changes partly reflect corrected classification. The intermediate main row has no comparison-engine assignments, so its f count is zero. Artifact hashes and runner revisions identify the actual measured inputs.

Raw JSON, JSONL, command logs, diagnostic output tails and the source diagnosis table are retained in `/work/reports/bun-wasm-baseline-2026-10-15/` for coordinator review. The coordinator owns removal after accepting this baseline. The task removes private build targets, execution snapshots, generated web output and dependency installations, while leaving its committed worktree and wasm artifacts for review. Shared caches and the existing port-3000 service are preserved.

<!-- progress:start -->
## Progress

QuickJS 282 → 411 is the sole comparable baseline by matched file selection. JSC and browser are non-comparable because their selections changed. Changed runner, suite, and supplemental-dependency hashes prevent an isolated runtime-gain claim for any engine.

| Date | Runtime commit | Files fully passing | Tests passing | Timeouts | a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-15 | 42262f8 | 137 | 5802 | 90 | 164 | 694 | 218 | 876 | 104 | 6 |
| 2026-10-15 | a8ef9ca | 282 | 12651 | 61 | 89 | 50 | 146 | 1523 | 108 | 0 |
| 2026-10-15 | 5ed3e9e | 282 | 12663 | 57 | 87 | 67 | 147 | 1505 | 92 | 18 |
| 2026-10-17 | 6e93c80c6f9bccc879990bedb999c3efdcd3166f | 411 | 20162 | 51 | 84 | 81 | 54 | 1451 | 93 | 23 |

Category counts use each run's classifier. Category movement alone is not a compatibility gain.
<!-- progress:end -->
