# Next build observer

Classification: original adapter. No upstream implementation is copied or patched.

Upstream references: published Next 15.5.6 (tarball SHA-256 `b164a2a51bff93b19ccf0abbb7bd25d4868aa6926a0573dee5e40e4c76864964`) and Waffle 0.0.123, interface 2. The local reader follows the existing diagnostic reader's retained-handle rule; it does not change that reader.

This opt-in goals-matrix tool observes the stock Next build through the maintained foreground driver. It reads only supported memory/process metadata and a fixed set of public build files through a forked Waffle filesystem client. The build command, template, engine policies and whole-phase deadline remain unchanged.

Next 15.5.6 owns the diagnostic and trace formats (`dist/build/index.js`, `dist/build/collect-build-traces.js`, `dist/trace/report/to-json.js`). Completed trace batches and complete server manifests are evidence of progress; absent events, partial files and stale dev artifacts are not evidence of a stall. One observation cannot separate CPU work from filesystem waits.

## Selection and lifetime

Pass `--next-build-observation` to `scripts/goals-matrix/run.ts` or `fleet.ts`, with exactly one browser, `--frameworks=next` and `--engines=quickjs`. Use the existing prepared site and its actual `--asset-source`; the observer does not build or replace an asset. The runner writes a separate `logs/<cell>.next-build.jsonl` alongside its ordinary output.

For the bounded Safari observation, pass `--timeout-ms=90000` and explicit Mac admission values `--mac-expected-seconds=600 --mac-wait-seconds=3600 --mac-timeout-seconds=900`. The existing Next build exception keeps the whole build phase at 110,000 ms. Launch-failure capture, final-log fallback and native cleanup policy retain the current driver's behavior alongside the optional observer.

The small internal `Execution.nextBuildObservation` callback receives baseline, snapshot, milestone, end and cleanup records. `ForegroundObservation` adds a read-only expression to the existing command-state evaluation, then calls the observer only while that command is pending. There is no additional polling loop or keepalive. Without the callback, foreground polling follows its original path.

The baseline runs after dev-server stop and immediately before the single stock `bun run build` dispatch. The first pending foreground poll at or after phase time 100,000 ms attempts one snapshot. Each read has at most 2,000 ms, clipped to the original phase admission deadline, with 25 ms reserved for disposal. A command that completes before capture is dispatched keeps its own result and skips the snapshot. Completion during a capture is checked again immediately afterward. No command is resubmitted.

Each capture uses a fresh filesystem fork. Every path component is resolved without following links and checked by kind. Resolve completions pin their inode handles through the read. A deadline or cleanup releases all completions and disposes the client before owned transport cleanup. Failed optional observations stay diagnostic records; they do not become a build result.

Optional observer closure has a one-second child admission within the unchanged cleanup allowance, reserving the existing logging and transport teardown time. A delayed memory or process-service result checks capture liveness before processing values or reading metadata; expiration and explicit closure admit no later metadata calls.

## Retained observations

The reader uses Waffle 0.0.123's public `FilesystemClient` and `runtime.processes().workerMemory()` / `memoryGroups()` APIs (host interface 2). It calls `__bunMemorySnapshots("quickjs", false)` once per capture. It neither waits on nor controls a child process. Process directory fields and other opaque properties are omitted. The retained fields contain selected identities, byte counts, group counts, QuickJS counters and allocation failures. Missing counters and acknowledgements remain unknown; timestamps and hook notes retain stale or unacknowledged observations. No stack sample or memory headroom is inferred.

Only these guest files are read:

- `.next/diagnostics/build-diagnostics.json`: at most 16 KiB; selected build stage/options only.
- `.next/next-server.js.nft.json` and `.next/next-minimal-server.js.nft.json`: at most 256 KiB each. Complete parsed versions and sorted file lists are compared internally; output retains completeness, file count and whether contents changed from a complete baseline. A size or hash is never completion evidence.
- `.next/trace`: at most the last 64 KiB. The leading tail fragment is discarded. Only complete JSON arrays contribute selected spans; partial and invalid batches are counted. Tags and unrelated spans are omitted. A fresh production trace ID requires a selected production span whose start time follows command dispatch and whose identity was not observed in the baseline.

The selected trace names are `next-build`, `node-file-trace-build`, `apply-include-excludes`, `collect-build-traces`, `webpack-compilation`, `run-webpack-compiler`, `static-generation` and `collect-page-data`. Missing spans can reflect batching or truncation. A complete manifest without a usable baseline has unknown freshness. These reads are sequential service observations within one bounded capture, not an atomic filesystem snapshot.

Terminal milestones are timestamped when the existing foreground poll first sees an additional occurrence beyond the dev baseline. They are observations, not emission timestamps; a recycled terminal scrollback can hide a milestone. The reader does not retain arbitrary terminal text.

## Executable coverage

`scripts/goals-matrix/next-build-observer.test.ts` runs the bundled page reader through the maintained scoped driver and a real `FilesystemService` / `FilesystemClient` pair. It covers pending commands, baseline changes, complete trace batches, missing and truncated files, stalled service and memory reads, unknown acknowledgements, cancellation, bounded deadlines, inode retention, disposal and single dispatch. The feature-owned quality manifest keeps this in the existing blocking owner.
