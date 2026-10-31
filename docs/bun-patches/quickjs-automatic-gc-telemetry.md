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

The focused direct-declaration experiment requires all six unique ESM paths and
all four revisions of `/reload/changed.mjs` to complete. It drops each promise,
runs pending jobs, explicitly collects, and samples the raw readout. QuickJS
marks the successful declarations in `JSContext.loaded_modules` until context
release, so this experiment observes normal declaration-registry lifetime.
It does not reproduce the actual Next webpack CommonJS reload path, which uses
`native.compileCjs` and global script evaluation. It establishes neither a Next
leak nor the owner of the earlier application memory limit failure.

## Classification

| Path | Class | Change |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c` | Host feature | Record automatic threshold-GC count, post-GC allocator floor, threshold, and live allocator bytes. |
| `third_party/rquickjs-sys/quickjs/quickjs.h` | Host feature | Append the four raw counters to `JSBunwasmMemoryTelemetry`. |
| `crates/bunwasm-engine-quickjs/src/vm.rs` | Original adapter | Match the 128-byte ABI and require the complete direct-declaration control. |
| `web/src/memory-telemetry.ts` | Original adapter | Decode and preserve the four raw fields without aggregation. |
| `scripts/fixtures/quickjs-memory-telemetry.c`, `scripts/engine-memory-hook.test.ts` | Original test adapter | Assert ABI size and exercise automatic collection state. |
