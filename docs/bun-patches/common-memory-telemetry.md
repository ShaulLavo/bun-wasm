# Common memory telemetry

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-cli/memory-telemetry.c` and `build.rs` | Port | Original adapter around the existing WASI libc allocation ABI. No upstream allocator implementation is copied or changed. |
| `crates/bunwasm-runtime/src/js/{process.ts,runtime.d.ts}` | Original adapter | Nullable memory values and derived RSS values preserve unknowns. No Bun or Node implementation copied. |
| `web/src/memory-telemetry.ts`, executor and launchers | Host feature | Original readers and transport for core and engine snapshots. Uses Waffle's public linked-group API from the pinned package. |

The core retains its existing WASI libc allocator. Linker wrapping observes
`malloc`, `calloc`, `realloc`, `free`, `aligned_alloc`, `posix_memalign`,
and libc's internal malloc/calloc/free aliases.
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


## Shared browser transport

A fixed 8 KiB shared frame per process carries host snapshots to the page.
The page requests a generation and can read it while the worker remains in its
synchronous Wasm event loop. It never evaluates code in that worker.
Existing host imports copy cached counters on request. The two existing side
imports `bun_core_idle` and `bun_core_poll` are called only after the shared
engine driver has returned from JavaScript; only these boundaries can satisfy
a normal refresh request. Other imports never refresh the VM. Output and exit
boundaries preserve cached failures before engine destruction. Initializer
failure uses a core-only reader established before constructors run.

Each process carries its page-runtime job identity as a command identity.
Active memory aggregation excludes terminal children, while failure selection
and provenance keep every retained process from the selected command. A failed
child therefore remains visible while its parent lives. Failures from older
commands are excluded. Independent process limits are not summed into a
fictional shared headroom budget.
