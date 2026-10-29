# Common memory telemetry

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-cli/memory-telemetry.c` and `build.rs` | Port | Original adapter around the existing WASI libc allocation ABI. No upstream allocator implementation is copied or changed. |
| `web/src/memory-telemetry.ts`, executor and launchers | Host feature | Original readers and transport for core and engine snapshots. Uses Waffle's public linked-group API from the pinned package. |

The core retains its existing WASI libc allocator. Linker wrapping observes
`malloc`, `calloc`, `realloc`, `free`, `aligned_alloc`, and `posix_memalign`.
The wrappers return the original result and preserve the original failure path.
They add no per-allocation headers and allocate no diagnostic data.

Live bytes are the sum of `malloc_usable_size` for outstanding allocations,
including padding. Peak is a high-water mark at successful outer allocation
boundaries. Realloc's internal temporary peak and allocator free-list metadata
are outside these counters. Nested libc calls are counted once. A failed
reallocation leaves its original allocation live. The first failure latches
its underlying libc request size and category before returning to its caller.
An overflowing calloc product has unknown size. The failure latch records an
allocation failure, including a recoverable one; it does not prove fatal OOM.
The counter storage matches the single-agent WASI build.

`bun_memory_telemetry` returns 10 little-endian u64 fields, 80 bytes. They are
ABI version 1, byte length, allocator live bytes, allocator peak bytes, first
failed request bytes, category, failure count, allocation count, free count,
and current Wasm capacity. UINT64_MAX means unknown. Categories are zero for
none, then malloc, calloc, realloc, aligned_alloc, and posix_memalign.
Reading the record neither allocates nor enters a VM. A trap before an allocator
returns cannot establish an allocation failure and must not be reported as one.

The host reads JSC ABI 1 with exactly 24 u64 fields and QuickJS ABI 1 with
exactly 12. It preserves each engine's accounting semantics. JSC's GC-accounted
ArrayBuffer estimate is separate from the unavailable exact backing-store
aggregate. SWC remains null until independently attributed. These values overlap
allocator bytes and must not be added to them.

Only normal phase samples may invoke engine refresh. A detected failure or
terminal cleanup permanently disables refresh for that process. Terminal
snapshots use cached getters before linked-group disposal. The Next hook reads
host diagnostics, never process.memoryUsage or other JS on a faulted guest,
and never requests GC. Counter and process identities remain in its result.
