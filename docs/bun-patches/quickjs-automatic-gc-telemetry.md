# QuickJS automatic-GC telemetry

Class **Host feature**. The upstream baseline is QuickJS-ng bundled in
`third_party/rquickjs-sys/quickjs/quickjs.c` and `quickjs.h`. This patch adds
raw, allocation-free fields to the existing cached QuickJS memory readout so a
reload experiment can distinguish collection timing from live retention.

`automatic_gc_count` increments only when QuickJS's malloc-threshold path calls
`JS_RunGC`. `malloc_size_after_automatic_gc` records the allocator counter after
that collection, and `malloc_gc_threshold` records the next threshold. These
fields do not count explicit `JS_RunGC` calls. `current_malloc_size` reads the
runtime allocator counter at the cached-read boundary, including after a
failure; it is not an aggregate or headroom calculation.

The ABI grows from 96 to 128 bytes by appending four little-endian u64 fields.
Normal refreshes continue to report the existing heap-walk counters. Cached
reads remain allocation-free and do not force collection. The QuickJS engine
readout exports the raw fields as `automaticGcCount`,
`mallocBytesAfterAutomaticGc`, `mallocGcThreshold`, and `currentMallocBytes`.

The focused module experiment evaluates six unique ESM paths and then four
revisions of the exact path `/reload/changed.mjs`. It drops each promise, runs
pending jobs, forces a normal explicit GC, and samples the raw readout. On the
current source `automaticGcCount` stayed at `1` and the automatic-GC floor
stayed at `108,264` bytes. Unique paths rose from `mallocBytes = 125,568` to
`133,168` and `structuralBytes = 114,001` to `119,586`; the changed path then
rose from `151,136` to `155,504` and `structuralBytes = 137,134` to `140,323`.
Because the floor grows after explicit collection while the automatic counter
does not, the module declaration/source structures are retained by QuickJS's
module lifetime rather than merely waiting for another automatic collection.
The test bypasses Core's path caches, so it does not attribute any core
module-cache or interpreted-Wasm ownership.

## Classification

| Path | Class | Change |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c` | Host feature | Record automatic threshold-GC count, post-GC allocator floor, threshold, and live allocator bytes. |
| `third_party/rquickjs-sys/quickjs/quickjs.h` | Host feature | Append the four raw counters to `JSBunwasmMemoryTelemetry`. |
| `crates/bunwasm-engine-quickjs/src/vm.rs` | Original adapter | Match the 128-byte ABI and print the focused unique-module reload experiment. |
| `web/src/memory-telemetry.ts` | Original adapter | Decode and preserve the four raw fields without aggregation. |
| `scripts/fixtures/quickjs-memory-telemetry.c`, `scripts/engine-memory-hook.test.ts` | Original test adapter | Assert ABI size and exercise automatic collection state. |
