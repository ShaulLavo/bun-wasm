# Run the pinned Next acceptance fixture

Use `examples/next-acceptance/` for the shared Next workflow. It pins Next and its WASM SWC compiler to 16.4.3 and React/React DOM to 19.2.0. Dev and production builds use webpack. Turbopack is outside this suite.

## Run one engine

Build the playground using the repository's existing workflow, with the matching guest core and side module. Use its absolute build directory and the producer's full bun-wasm source revision. The runner checks served artifact bytes against `engine-builds.json`; use `--runtime-receipt` with the producer's unchanged `GuestBuildReceipt`. The canonical verifier checks `program.core`, the engine companion and its origin, source-manifest digest and source revision. Omitting the receipt leaves provenance blocked and cannot pass acceptance.

```sh
source env.sh
bun scripts/app-matrix/next-acceptance.ts \
  --engine quickjs --web-root /absolute/playground-build \
  --runtime-revision FULL_40_CHARACTER_PRODUCER_SOURCE_SHA \
  --runtime-receipt /absolute/bun.wasm.build.json \
  --output /absolute/new-report-directory --port 43701
```

Repeat with `--engine jsc` and `--engine browser`, each with its own report directory and the corresponding verified build. The engine selector and ready label are checked before staging the fixture. Every phase row records the selected and observed engine. `rebuilds` records edit-to-visible and revert-to-visible times separately from the full cycle duration. The report also records the Chromium version, source revision, fixture digest, lock digest, runtime artifact digests, command timings and cleanup result.

The runner uses the existing playground session, filesystem, shell, root-origin preview, registry and HMR helpers. It opens no visible browser window. The guest port is explicit; the local playground and preview servers request free ports.

For offline replay, use the existing registry helper to stage missing locked tarballs without changing its shared recording:

```sh
bun web/tests/next-framework-registry.ts /work/tmp/bun-wasm-next-registry examples/next-acceptance/bun.lock
# Add to the acceptance command:
# --registry-extra /work/tmp/bun-wasm-next-registry
```

`--registry DIRECTORY` instead replays a complete app-matrix registry recording. These two options are mutually exclusive. Replay fails on a missing object or blocked external request. Remove the supplemental directory after its consumer runs finish. A run without replay is labeled a live npm diagnostic.

## Use the shared config

The authoritative config is `examples/next-acceptance/next.config.ts`. `stageFixture` in `scripts/app-matrix/next-acceptance-fixture.ts` uses host Bun's TypeScript transpiler to generate `next.config.mjs` and omits the `.ts` config from the staged app. It performs this same step for every engine and the native control. Settings are identical: one compile CPU, fixture-local tracing root, and no automatic agent-rule file generation. Reports record source and generated digests, settings and the transpiler recipe. No generated JavaScript is checked in.

This is a Next-supported ESM config. It does not prove the guest's separate TypeScript config-loading path works. To reproduce that boundary, stage the original `.ts` file instead of generated `.mjs` in disposable scratch and run `bun run launch.ts dev --webpack --hostname 127.0.0.1 --port 43701`. Historical JSC returned `Unexpected keyword export` from `module_compile`; HTTP-01 also reproduced the export failure on native Node and QJS, identifying upstream SWC config compilation. Preserve the original log when comparing a compiler fix.

## Read the results

`run.json` contains structured evidence. `results.md` contains the per-engine phase table. Command logs retain original runtime errors. Output directories must be new, preventing stale results from supplying a pass.

The full run installs with `--frozen-lockfile`, builds, checks `.next/BUILD_ID`, starts production, and checks every public URL. It then starts one dev server, warms all routes, and runs 30 edit/revert cycles. Cycles rotate client code on `/`, server code on `/dynamic`, and CSS on `/`. They repeatedly edit the same already-compiled routes. Each edit and restoration is checked before and after a reload, and each cycle also checks overlapping marked SSR, GET and POST requests. Compile-error recovery, application-error recovery, streaming cancellation, Server Actions and client navigation have separate cells. The dev server stays alive throughout. After route warm-up, the context endpoint records the serving process PID; each edit/revert cycle verifies that PID before and after the update.

Evaluated HTTP probes carry the configured deadline into a browser-side AbortController. It covers response headers and the entire body, including EOF. A stream requires HTTP 200, both timed payloads, and EOF; intentional cancellation is a separate request. Every exit aborts unfinished requests and cancels/releases acquired readers. This also applies to overlapping SSR/API reads, PID reads and compile-error polling.

Production build commands have a 300-second budget. Other commands, server startup, routes and edit probes keep their 180-second default. `--build-timeout-ms` overrides only the production build budget; `--timeout-ms` overrides the other operations. Both accept integer milliseconds from 1000 through 900000. Neither option changes the other. The build allowance follows the measured QuickJS completion time of 190–200 seconds, compared with 7.7 seconds on native Node. The former 180-second build bound interrupted legitimate build tracing. This is an acceptance execution change; progress-output buffering is separate runtime work.

`run.json` records the selected `parameters.timeoutMs` and `parameters.buildTimeoutMs`. Each phase row records its actual `budgetMs` watchdog deadline in JSON and the `Watchdog ms` column in Markdown. Rows recorded without running a watchdog use `null` and `n/a`. The build watchdog defaults to 305000 ms, including the existing five-second allowance.

A phase watchdog allows five additional seconds for sampling/teardown beyond the configured probe budget. If browser work ignores its own deadline, the watchdog closes the owned browser, with a forced process kill if graceful close stalls, before persisting the failed phase. The full edit-session watchdog scales with its cycle count. Terminal capture, session and registry cleanup also have deadlines. Browser loss fails later operations; it cannot produce a pass.

A failed prerequisite blocks dependent cells. Failures retain their actual diagnostics. `--phases install,dev --cycles 0` makes a short diagnostic; unrequested phases and the long-session gate remain blocked. A diagnostic cannot pass full acceptance. An engine's result never supplies another engine's cells.

The fixture lock is generated by bun-wasm's resolver, with matching SWC declared explicitly. Its Next record includes the WASM compiler dependency. It preserves versions, integrity, os and cpu selectors; the current WASI lock writer does not emit libc selectors. Frozen installation of the same lock has been checked on host Bun and a WASI QuickJS guest, with no host lock rewrite. Regenerating solely with native Bun changes platform metadata and makes the current guest's strict comparison fail. Regenerate in disposable scratch through the guest with `install --lockfile-only`, then verify both host and guest frozen installs before replacing the committed lock. Acceptance itself always uses frozen install.

## Supply memory attribution

QJS/JSC measurement lanes can pass `--memory-hook /absolute/hook.ts`. Export `sample({ page, phase, engine })`, returning a promise with these fields:

| Field | Meaning |
|---|---|
| `wasmCapacityBytes` | Current linear-memory capacity, separate from live allocations |
| `memoryLimitBytes` | Configured guest memory limit |
| `allocatorLiveBytes` | Current guest allocator live bytes, including its engine allocations |
| `allocatorPeakBytes` | Allocator high-water mark for the current server process |
| `jsHeapBytes` | Engine heap accounting, with its semantics named in `notes` |
| `arrayBufferBytes` | Engine's ArrayBuffer backing-store accounting |
| `swcBytes` | Attributed SWC module/instance memory |
| `failedAllocation` | `null`, or `{ bytes: number | null, category: string }` |
| `notes` | Counter source, overlaps and limitations |

Every counter is an integer byte count or `null` when unavailable. Categories may overlap; the suite does not add them together. No forced GC runs in acceptance. Hooks must identify the actual Next server process, including a dev child process if Next launches one. Reading the CLI parent's heap alone does not attribute the compiler's memory.

The driver samples at startup, every 500 ms while a phase runs, around each edit, and after an idle period following warm-up and each complete edit/revert cycle. Samples are capped at 8192; dropped samples or sampler errors block the memory gate. Calls do not overlap and each hook call has a five-second deadline. A timed-out hook stops further sampling for the run; it is not treated as a settled hook that can overlap the next call. `--idle-ms` defaults to 1500 and cannot be less than 1000. The hook owns any additional observers it creates and must clean them up before the run ends.

JSON stores bytes; human summaries use MiB. The memory gate needs 30 completed cycles and complete attribution. By default it requires at least 32 MiB of headroom against the allocator peak, at most 16 MiB retained growth from warm-up, and at most 16 MiB growth across the final ten samples. It checks allocator live, JS heap, ArrayBuffer and SWC retention separately. Override thresholds with `--min-headroom-mib` and `--max-growth-mib`; their values are recorded. Missing counters block the gate. A larger linear-memory capacity is neither live-memory evidence nor a pass. A failed allocation from logs is recorded with its size when printed; an unreported size stays unknown.

These checks describe this bounded session. They do not establish Next's minimum working set or prove every future workload stays bounded.

For the separate method/body-aware advisory overlay, see [advisory replay](next-advisory-replay.md).

## Verify the fixture and probes

```sh
bun test scripts/app-matrix/next-acceptance.test.ts scripts/app-matrix/product-browser.test.ts
bunx tsc -p tsconfig.scripts.json
# Real Chromium regressions, through the executing host's shared queue:
bun test scripts/next-acceptance-http.test.ts
# Run through the executing host's shared job queue:
bun scripts/app-matrix/next-acceptance-reference.ts /absolute/native-control-report
```

The native control installs the exact lock in disposable scratch, runs the same URL assertions, checks one client/server/CSS edit-revert cycle each and compile-error recovery, then builds and checks production start. It is a control for the fixture and assertions; its results never count as QuickJS, JSC or browser-engine acceptance. Its scratch, server process groups and browser are removed on exit.
