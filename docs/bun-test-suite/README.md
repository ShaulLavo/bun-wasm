# Bun's upstream suite

This is a bounded compatibility baseline, measured on 2026-10-15. It runs the pinned Bun tests unchanged through bun-wasm, one file per process. The numbers describe what this runner actually collected, rather than the full number of assertions that native Bun would eventually execute.

<!-- baseline:start -->
## Measured baseline

Upstream `4ceda2c2868d3a7703c7737ddd9de7244ec384df`, engine `quickjs`.

2,305 files; 137 fully passing; 5,802/35,344 observed tests passing; 90 file timeouts.

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| bake | 27 | 0 | 0/37 | 0 | 0 |
| bundler | 107 | 4 | 41/490 | 23 | 1 |
| cli | 257 | 2 | 16/8,930 | 280 | 37 |
| config | 2 | 0 | 0/51 | 2 | 1 |
| integration | 23 | 2 | 27/80 | 0 | 1 |
| internal | 66 | 12 | 103/236 | 7 | 0 |
| js/bun | 557 | 31 | 1,153/9,015 | 391 | 514 |
| js/deno | 16 | 0 | 0/16 | 0 | 0 |
| js/first_party | 7 | 0 | 0/19 | 0 | 0 |
| js/junit-reporter | 1 | 0 | 0/1 | 0 | 0 |
| js/node | 340 | 25 | 2,229/4,503 | 119 | 13 |
| js/sql | 71 | 0 | 0/76 | 4 | 0 |
| js/third_party | 120 | 0 | 0/134 | 2 | 0 |
| js/valkey | 15 | 0 | 0/41 | 8 | 0 |
| js/web | 185 | 11 | 811/8,230 | 96 | 5 |
| js/workerd | 3 | 0 | 2/250 | 1 | 0 |
| napi | 60 | 0 | 0/60 | 0 | 0 |
| packages | 15 | 2 | 1,216/2,110 | 0 | 0 |
| regression | 430 | 46 | 182/1,040 | 44 | 0 |
| root | 1 | 1 | 21/21 | 0 | 0 |
| snippets | 1 | 1 | 1/3 | 0 | 2 |
| v8 | 1 | 0 | 0/1 | 0 | 0 |

| Category | Meaning | Failing files | Observed tests passed/total |
|---|---|---|---|
| a | platform limitation | 164 | 21/1,045 |
| b | test needs a subprocess | 694 | 1,769/15,086 |
| c | fixable, small | 218 | 333/832 |
| d | fixable, big | 876 | 1,782/15,012 |
| e | not worth the cost | 104 | 44/307 |
| f | engine difference | 6 | 16/432 |

2,062 failing files + 137 fully passing + 106 empty/skip-only = 2,305 files.


Categories are mutually exclusive first-blocker assignments. Passing, empty and skip-only files are excluded. 'Needs reproduction' is a conservative big-work bucket, not a claim that every assertion failure needs a subsystem rewrite. No unexecuted tests are counted.

| Engine | Compared files | Fully passing | Observed passes | QuickJS failures passing here | QuickJS passes failing here |
|---|---|---|---|---|---|
| browser | 1082 | 64 | 9966 | 6 | 9 |
| jsc | 1082 | 68 | 3572 | 2 | 1 |

### browser comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| js/bun | 557 | 30 | 6,995/19,450 | 396 | 514 |
| js/node | 340 | 24 | 1,682/4,485 | 119 | 13 |
| js/web | 185 | 10 | 1,289/8,437 | 116 | 5 |

### jsc comparison

| Directory | Files | Fully passing | Observed tests passed/total | Skipped | Todo |
|---|---|---|---|---|---|
| js/bun | 557 | 31 | 1,184/9,058 | 395 | 514 |
| js/node | 340 | 26 | 1,690/3,789 | 115 | 13 |
| js/web | 185 | 11 | 698/8,008 | 114 | 5 |
<!-- baseline:end -->

## Reading the results

[summary.json](summary.json) records the artifact hashes, upstream commit, time limits and category totals. [failures.tsv](failures.tsv) assigns every failing file to one primary category, with a test name, first error and confidence. [triage.md](triage.md) groups those assignments with representative failures. These assignments describe the first blocker, so fixing one often reveals a second. The script deliberately leaves uncertain assertion failures in category d with `needs reproduction`; it does not promise they take less than an hour.

A fully passing file must finish the runner report, exit zero, report at least one pass and have no failures or unhandled errors. Empty and skip-only files are separate from failing files. The total observed tests includes skips, todos and the runner's synthetic failure for a collection error. It excludes tests that never registered after an import failure. A timeout preserves the pass/fail lines already observed, but cannot establish the remaining test count. Failures are not converted into skips because they use unsupported APIs.

Discovery uses tracked files under `test/` ending in `.test`, `_test`, `.spec` or `_spec`, followed by a JS/TS extension. This revision contains 2,305 such files, including fixture test files. It is a source-file census, not Bun's CI shard manifest. The task's earlier 2,359-file inventory refers to a different count or revision. Git submodules and untracked generated files are excluded. The suite is Bun 1.4.4 plus the local WASI patch series, at the exact hash above; the installed native Bun driving dependency setup is 1.4.2.

## Reproduce

From a checkout with `vendor/bun` and the three wasm artifacts built:

```sh
source env.sh
# Build the networking launcher if its release binary does not exist.
cargo build -j 6 --release -p bunwasm-host
BUN_INSTALL_CACHE_DIR=/work/cache/bun bun install \
  --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
scripts/bun-suite.sh --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-bun-suite-results/quickjs.json
scripts/bun-suite.sh --engine browser --jobs 2 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-bun-suite-results/browser.json 'js/bun' 'js/node' 'js/web'
scripts/bun-suite.sh --engine jsc --jobs 2 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-bun-suite-results/jsc.json 'js/bun' 'js/node' 'js/web'
python3 scripts/bun-suite-report.py /work/tmp/bun-wasm-bun-suite-results/quickjs.json \
  --compare /work/tmp/bun-wasm-bun-suite-results/browser.json \
  --compare /work/tmp/bun-wasm-bun-suite-results/jsc.json
```

The measured run used eight QuickJS workers with a 4 GiB systemd scope, and two workers per comparison engine with 2 GiB scopes. Each file has a 15-second wall limit, excluding setup and reset. The initial per-test limit is 2 seconds, and the suite can change it through `setDefaultTimeout`. These limits intentionally bound stress, memory-leak and network waits. Increase them for a targeted investigation.

Add `--resume` to the identical command to keep completed files. The runner rejects changed upstream commits, wasm, runner code, dependencies, launcher or timeouts. `--resume --rerun --jobs 1 'path/to/file.test.ts'` replaces selected results while keeping the rest. Quote shell globs, for example `'js/web/*url*.test.ts'`; directory names also select their descendants. The JSONL checkpoint survives normal interruption, and the JSON summary is rewritten on exit. Use a fresh output path for different artifacts or timeouts. The command exits zero for a completed census even if upstream tests fail, and exits nonzero for runner errors or interruption.

The native launcher provides the real networking ABI for QuickJS and JSC. The browser comparison uses Node's host engine with `--net`, matching `scripts/test.sh --engine browser`. Only the private suite copy at `/bun` and private temp directory at `/tmp` are preopened. The host cwd and guest cwd are both the suite's `test/` directory. The runner reads `test/bunfig.toml` and supplies its real `preload.ts` with `--preload`; nested fixture configs and install settings are not treated as the runner's config. A temporary `test/node_modules` supplies the suite's harness aliases because general tsconfig-path resolution is not yet implemented. No upstream test or harness source is patched.

Each worker starts from an independent source snapshot, restores tracked edits and deletes generated/ignored files after every file, checks clean Git status, then clears its temp directory. Snapshot attributes preserve CRLF and other fixture bytes. Wasm is copied once per run. Per-file processes get their own process groups, which the runner kills and reaps on timeout or interruption. The top-level temporary directory is removed on success, error and handled signals. An uncatchable SIGKILL can leave scratch behind; remove only the named `bun-wasm-bun-suite-*` directory after checking that its run stopped.

## Harness work included

The runtime now loads the real shared harness and preload. `bun test` installs test globals, accepts `--preload`, exports `setDefaultTimeout`, and keeps `.serial` / `.concurrent` aliases on skip/todo groups. Concurrency still follows the existing sequential wasm runner. TypeScript uses Bun's normal unused-import policy, so type names such as `BuildConfig`, `Server` and `Subprocess` do not become runtime imports.

`bun:jsc.heapStats()` returns the declared object shape, with memory totals from the engine abstraction. Per-type and protected-cell counters are unavailable and return empty maps/zero. **A passing GC/leak assertion against these counters is not evidence of leak freedom.** `bun:internal-for-testing` exposes only `isASANEnabled() === false`. `Bun.unsafe` is importable, but unsupported operations throw a named error. `process.report.getReport().header` exists without claiming a glibc version. `Bun.spawnSync` returns a failed result with an explicit unsupported error and stderr. Async spawning and `child_process.execSync` still throw when called; importing them succeeds. `bunExe()` is the real harness helper and returns the guest exec path, never a native Bun escape hatch.

The five pinned extra dependencies cover common helpers: filenamify, source-map, semver, jest-extended and lodash. Already installed root dependencies are copied and hashed too. The full upstream app/framework/native-addon dependency graph is not installed. Missing packages are category c setup blockers, not assertions about those packages' runtime compatibility. Hoisted installation is deliberate because the guest resolver does not canonicalize Bun's isolated-linker package symlinks correctly.

## Small follow-ups, category c

These are concrete bounded changes; file counts and representatives come from the first-blocker index above.

| Work | Where | Bound |
|---|---|---|
| Run default-port server tests in an isolated loopback network namespace; preserve the existing service on port 3000 | runner host setup, `unshare --user --map-root-user --net`, bring `lo` up | 15-30 minutes; external-network cases need routing |
| Add Bun's `fs/promises.exists(path)` extension by wrapping the existing existence check | `crates/bunwasm-runtime/src/js/node_fs.js`, promise exports | 15-30 minutes |
| Accept boxed String paths, which `harness.tempDir()` returns; native Bun's `path.join(new String("x"), "a")` returns `x/a` | `crates/bunwasm-runtime/src/js/path.js`, argument validation; audit the same fs boundary | 30-60 minutes |
| Install a missing pure-JS suite dependency at its upstream-pinned version, rerun that group, then reclassify the resulting API failure | `docs/bun-test-suite/dependencies/package.json` and lockfile | 15-30 minutes per package; native addons move to a |
| Reproduce the recorded missing matcher/helper with one native-Bun comparison, then add the exact method | `crates/bunwasm-runtime/src/js/bun_test.js` | Up to 1 hour per method, not all matcher failures together |

The trivial fixes made in this pass were test globals/preloads, the heap/ASAN import stubs, failed spawnSync results, TypeScript type-import erasure, default test timeout, and modifier aliases. No tests under `vendor/bun/test` changed.

## Test-command shutdown, investigate first

QuickJS printed its final test report in 66 of its 90 file timeouts. Browser did so in 46 of 69, and JSC in 42 of 68. These are completed reports followed by live handles, rather than proof that the test body itself ran too slowly. All of these census files also reported test failures, so fixing shutdown alone does not make them fully passing.

[repro-open-server.test.js](repro-open-server.test.js) isolates one root cause. Native Bun 1.4.2 exits zero after reporting `1 pass`; the rebuilt QuickJS runtime reports the same pass and stays alive until the host's 3-second deadline kills it. The measured outputs are `open-server-result.json` in the retained evidence. Reproduce with:

```sh
source env.sh
bun test ./docs/bun-test-suite/repro-open-server.test.js
timeout --kill-after=1 3 "$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$PWD/dist/bun.wasm" \
  --dir "$PWD/docs/bun-test-suite::/" --env PWD=/ test /repro-open-server.test.js
```

Start at `crates/bunwasm-runtime/src/lib.rs:360`: test entry invokes `runTests`, then uses the ordinary program event loop, which continues polling referenced network/timer handles after the test promise settles. The host-engine equivalents are entry dispatch and `pump()` in `web/src/engine-host.js`. Add test-command completion semantics across both paths, preserve cleanup hooks and pending rejection reporting, and verify with the open-server reproducer and all existing fixtures. Budget 1-2 days for a reviewed fix. Longer deadlines alone do not solve this. Do not infer the cause of every post-report timeout from this one reproduction.

## Larger follow-ups, category d

Estimates are implementation time for a bounded first slice, excluding full upstream conformance. Start from a representative in [triage.md](triage.md), unblock collection, and measure again.

| Subsystem | Starting point | Estimate |
|---|---|---|
| Portable `bun:jsc.callerSourceOrigin()` for bundler test collection | `builtins.js`, mapped stack/caller metadata on each engine | 1-2 days; proper tail calls need special care |
| Glob matching and traversal, including `Bun.Glob` and `fs.globSync` | `bun.js`, `node_fs.js`, Rust filesystem natives | 2-4 days |
| `node:test` adapter | builtins registry and `bun_test.js` | 1-3 days |
| Module mocking and cache invalidation on all engines | `bun_test.js`, `bootstrap.js`, Rust resolver/engine loaders, `web/src/engine-host.js` | 3-7 days |
| TOML/YAML/JSON5 public APIs and serialization | `bun.js`, parser/printer natives; share Bun parser where practical | 2-4 days |
| Bun TCP socket callbacks | `net.js` plus `bun.js`; the existing host ABI already offers TCP | 1-3 days |
| Stream correctness and cancellation/backpressure | `builtins.js` stream classes and `web.js` | 1-2 weeks |
| HTTP server routing/static HTML, fetch/body/WebSocket gaps | `net.js`, `web.js`, host adapters | 1-3 weeks in separate slices |
| TLS, certificates and HTTP/2 | native launcher and host ABI, guest `node:tls` / `node:http2` | 2-4 weeks |
| WebCrypto algorithm/key coverage | Rust crypto natives and `builtins.js` | 1-2 weeks |
| Bundler plugin callbacks, output metadata, compile targets | `bunwasm-build`, transpiler, `bun.js` | 1-3 weeks; native executable targets need a separate product decision |
| Bun shell, install/pm commands, database/Redis/S3 clients | separate command/client modules; do not hide them in the test runner | 2-6 weeks each for a useful initial slice |
| Thread/Worker emulation | message/event-loop abstraction and module loader; no true shared-memory execution implied | 1-3 weeks for a limited in-process model |

Unresolved assertion failures also sit in d until reproduced. The index marks these `needs reproduction`; some will turn out to be small. Timeout files need individual reruns with longer budgets before assigning a missing subsystem. Fixed TCP ports are shared across workers. Eleven QuickJS files with bind errors were rerun serially. Port 3000 belongs to a pre-existing Bun service, PID 4541, which had been running for over ten days. It was preserved. A separate `port-control.json` run uses an isolated user/network namespace with loopback enabled and no external networking. That control does not replace the main baseline records. It increases `serve-types.test.ts` from 20 to 43 passes and allows `serve-listen.test.ts` to collect tests, confirming the setup interference. None of the eleven control files becomes fully passing; other implementation gaps remain. Default-port bind failures are setup blockers in c, not missing HTTP behavior.

## Subprocess tests, category b

The groups in [triage.md](triage.md) distinguish what the spawned program checks: package management, bundling/compilation, test runner output, CLI arguments/environment/cwd, lifecycle/signals, network children, and general runtime regressions. `source inference` means the file contains subprocess setup and the failure is an output/exit assertion, rather than an explicit unsupported-process error. Inspect that test before converting it.

An external coordinator can run child guest invocations with independent WASI instances for CLI/build/test-output checks. Pure runtime regression fixtures can often become direct in-process calls in a separate adapter. Both approaches require preserving argv, cwd, env, stdout/stderr, exit and per-child filesystem semantics. Process tree, real signal, inherited-FD, pty and real thread tests remain category a. Never point `bunExe()` at native Bun to make the numbers pass.

## Platform and cost decisions

Category a covers native addons/FFI/dlopen, OS process primitives and signals, real threads/shared memory, ptys, file watching, and network operations beyond this host ABI. Those need a different platform or an explicitly scoped emulation. TCP itself already works through the launcher and is not an inherent WASI limitation.

Category e is limited to native-engine/compiler instrumentation and private implementation details. Each entry carries its reason in `failures.tsv`: reproducing private JSC/JIT/bytecode/heap-cell counters in QuickJS or a browser is not a useful compatibility goal. Public behavior those tests happen to exercise can still deserve an independent portable test. The heapStats shape shim does not make engine-internal measurements portable.

Category f requires a measured QuickJS failure that fully passes on a comparison engine. Different error strings and stacks are plausible causes, but the index only claims a measured difference, not a confirmed root cause. Other cross-engine count changes remain in `summary.json` and deserve targeted runs.

## Verification and retained evidence

The measured runner is commit `1ff3730`; the final progress-label correction changes only the printed denominator on selective reruns. `summary.json` resolves the recorded runner hash back to that commit. Restoring that exact script is required to resume these particular saved checkpoints. New output files use the current script. The engine/runtime source is commit `42262f8`.

`wall_seconds` records the latest runner invocation, so a selective rerun replaces that field; per-file durations remain attached to their actual invocation. The baseline JSON files and command logs are retained in `/work/tmp/bun-wasm-bun-suite-results/` for the coordinator. The checked-in summary and triage are generated by `scripts/bun-suite-report.py`; detailed JSON includes exits, durations, pass/fail/skip/todo, named failures, first errors and bounded excerpts. `python3 scripts/test-bun-suite.py` checks report parsing, partial timeouts, synthetic import failures and resume provenance.

All three final `scripts/test.sh --no-build` runs passed, 63 fixtures per engine. `scripts/test-web.sh` passed Chromium/WebKit, web unit tests and type checks. All six runner/report unit tests passed; real resume preserved the exact existing result without rerunning it. Every failing file appears once in the index, and all counts reconcile with the JSON.

Cleanup was checked on the execution host. No task processes or execution directories remain. The three private Cargo targets, dependency staging directory, generated web output and duplicate checkpoints/probes were removed. The shared checkout and upstream test tree remain clean. Pre-existing services and shared caches were preserved. Cleanup evidence is `cleanup.json` alongside the raw results. Retained evidence is about 36 MiB; the review worktree is about 72 MiB, including 62 MiB of rebuilt wasm artifacts. The coordinator owns both until evidence review and integration finish, then removes the results directory and worktree. Nothing was pushed, deployed or merged by this worker.
