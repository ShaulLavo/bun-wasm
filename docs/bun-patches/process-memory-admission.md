# Process memory admission

Classification: original host adapters and test adapters. No upstream implementation
is copied. The reference contract is published Waffle 0.0.111 at
`96acfb246bb565cd008ad498e08230829c3a773a`, especially `MemoryDeclaration`,
`RuntimeRootOptions`, `retainRoot`, `rootControlGrant`, `rootControlAllocated` and
`rootStopped`.

`src/engine-kind.ts` extends the existing Wasm section reader to retain every
actual imported and defined memory's initial size, maximum and origin. It remains
independent of the runtime package. `src/program-memory.ts` converts those limits
with Waffle's public `pages` constructor and records the same source through
`declareModuleMemory`. It retains the root declaration by compiled module identity.

`src/assets.ts` records single-module preparation from its owned byte snapshot,
and paired preparation from the exact prepared link-plan source. The streaming
and cached compilation paths in `web/src/engine-loader.ts` retain the same
association. The streaming path shares one owned Blob and one materialized byte
snapshot between declarations, integrity checking and cache storage. It releases
the temporary chunk list rather than restaging the complete source for caching.
An unknown compiled root is rejected, not declared memory-free.
The package file list includes the new source helper.

`web/src/runner.ts` keeps the original manual-root ownership and outcome path.
The actual selected tools module is loaded before root admission. The request
remains incomplete until `SubprocessBroker.adoptRuntimeRoot` supplies the
broker-issued grant for that root. Only the complete request reaches the worker.
Allocation messages reach the shared process service before ordinary exit-message
filtering. Successful physical termination supplies `rootStopped`; logical exit
alone does not. An admitted root holds the public `retainRoot` lease across logical
retirement. Synchronous termination supplies its receipt in the same task;
asynchronous termination waits for settlement. Only successful stop accounting
releases the lease. A rejected stop retains its cleanup owner and makes page
disposal fail instead of reporting successful physical cleanup.

When the page runtime disposes, it owns the broker and physical cleanup. The
adapter joins its worker stop but does not call a revoked public service facade.
The runtime's broker supplies that final stop receipt and then retires the lease. Existing root outcome,
filesystem fencing, networking ownership and single-use worker behavior remain.
No memory cap, default platform, pool, group policy or version fallback changes.

Controller-only fixtures explicitly declare no Wasm memory. Browser worker
fixtures declare their actual source module and forward allocation and stop
receipts. Source-known runner fixtures use `process-module-fixture.ts` rather
than a fabricated declaration. Isolated bootstrap fixtures receive issued
control grants and ledger-charged pipe registries through public APIs. The
artifact-free runtime-proc browser page registers its original byte-encoded
modules through the same source-known fixture helper, including foreground-stop
modules, without changing their bytes or assertions. The filesystem and signal-clock
fixtures use that helper too. The network and transfer pages use the production
streaming loader, and the interruption candidate loader records the bytes it
already fetched. No raw compiled fixture is labeled memory-free.
`tests/helpers/process-reservations.ts` obtains reservations from the public
`processHost` hook and disposes its memory-filesystem owner after its borrowers.
Bun test commands resolve the invoking consumer's public package entries; browser
builds use their existing single-runtime package resolver.

`runner-process.test.ts` exercises the actual request path, source limits,
admission grant identity, allocation receipts and deferred physical-stop release.
`runtime-owned-runs.test.ts` retains the actual page-disposal checks. Isolated
`runner-stop-ownership.test.ts` controls normal exit followed immediately by page
disposal with synchronous, delayed and rejected physical stops. The loader copy
control uses real HTTP streaming, compilation, declarations and verified cache
bytes to require one source snapshot. Package
controls preserve the existing memory-limit reader result shape and verify source
snapshots, all memory origins and an actual omitted Wasm maximum. The existing
bootstrap, IPC, signal, network and package tests retain their assertions. The
lazy-disposal fixture now checks each of its two distinct broker owners exactly
once, including the public reservation owner. Fixture reservations activate only
when a process host is requested, not when a module creates a test runtime.

The web and sandbox shell consumers select the merged public bash-web source
`09a12427275ad14b8db2ee7c78ee02330cfac866`. Its source pin and generated locks move
together. The earlier external memory/grant type errors remain recorded as failed
integration attempts, not qualified native results.

This wiring does not reinterpret earlier iOS evidence. The process adapter's
original fourth-case `SharedMemoryAdmissionError` remains its recorded failure.
No native acceptance or new guest artifact is claimed.
