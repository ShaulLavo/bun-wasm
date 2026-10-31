# Common memory telemetry

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-cli/memory-telemetry.c` and `build.rs` | Port | Original adapter around the existing WASI libc allocation ABI. No upstream allocator implementation is copied or changed. |
| `crates/bunwasm-runtime/src/js/{process.ts,runtime.d.ts}` | Original adapter | Nullable memory values and derived RSS values preserve unknowns. No Bun or Node implementation copied. |
| `web/src/{memory-telemetry.ts,memory-channel.ts}`, executor and launchers | Host feature | Original readers and transport for core and engine snapshots. Uses Waffle's public linked-group API from the pinned package. |
| `scripts/engine-producer.ts`, `producer-closure.ts` and guest receipt/profile helpers | Original adapter | Compose one core with the selected original engine receipts, record a source-matched launcher, and require the complete split or shared-group closure before qualification. No upstream implementation copied. |

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

`bun_memory_failure_telemetry` returns nine little-endian u64 fields, 72 bytes.
They are ABI version 1, byte length, first failed request bytes, category,
previous allocation's usable bytes, allocator live bytes, allocator peak bytes,
Wasm capacity before the call, and capacity after the failed call. It freezes
with the same first failure as the 80-byte record. Before failure, the category
is zero and all values after the header except category are unknown.
Previous usable bytes are zero for calls other than realloc and for realloc
with a null pointer. Capacity before the call is recorded only for realloc.
The getter only returns the frozen record, including after later frees or
allocations. It never walks a heap. Live and peak retain the outer-boundary
accounting above, so internal realloc temporary peaks remain unobserved.
Neither capacity nor live bytes identify a largest free block, the allocator's
growth request or result, or its rejection reason.

The browser host reads this cached export into the separate
`MemorySnapshot.frozenAllocatorFailure` field. It keeps the failed request's
`bytes` and `category`, `previousUsableBytes`, `allocatorLiveBytes`,
`allocatorPeakBytes`, `wasmCapacityBeforeBytes`, and `wasmCapacityAfterBytes`.
Its `reason` is always `"unknown"`. The field is null before a recorded failure
or when the export is unavailable. No current counters or terminal text fill
missing frozen values. UINT64_MAX and values above JavaScript's exact integer
range become null. Version, exact byte length, wasm32 pointer range, alignment,
and bounds are checked before decoding. Unknown categories keep their raw code.
The reader never refreshes this record or enters an engine to read it.

`memoryLimitBytes` comes from the linked core's declared maximum, whose build
input is the single authority in `crates/bunwasm-cli/max-memory.txt`. It stays
separate from current capacity and frozen failure-time capacity. If the core
has no declared maximum, the reader keeps the limit unknown. See the
[memory ceiling contract](../memory-ceiling.md).

The shared channel retains the first frozen record across engine failure and
teardown, independently of allocator and engine failure fields. The page
validates all frozen fields before retaining a frame. Raw process snapshots
keep these details. Canonical aggregates still need authoritative root inventory
and do not infer headroom or allocation cause from the frozen values.
Maintained controls compile the real core wrappers and pass the frozen record
through the browser reader and shared channel. Existing frozen guests and hosts
are not changed. A future canonical build must include the new core and host
together with the JSC hook and matching build receipts. Native archive reuse
must pass the producer's original compiler-input provenance checks. For Hermes,
those checks recheck the original dependency metadata and bytes, then compare
current repository inputs by content and resolved path. Unrelated checkout
changes do not require a new archive, while changed compiler inputs do. This
source integration supplies no new archive, stamp, composed guest, or receipt.

The host reads JSC ABI 1 with exactly 24 u64 fields, QuickJS ABI 1 with
exactly 12, and [Hermes ABI 1](hermes-memory-telemetry.md) with exactly eight.
It preserves each engine's accounting semantics. JSC's GC-accounted
ArrayBuffer estimate is separate from the unavailable exact backing-store
aggregate. SWC remains null until independently attributed. These values overlap
allocator bytes and must not be added to them.

Only normal phase samples may invoke engine refresh. A detected failure or
terminal cleanup permanently disables refresh for that process. Terminal
snapshots use cached getters before linked-group disposal. The executor observes
side imports during `instantiateLinkPlan()`, when pinned Waffle 0.0.105 creates
the side instances, and restores the WASI import resolver in `finally`. The
observer stays on each resolved import through initialization and entry. The
Next hook reads host diagnostics, never process.memoryUsage or other JS on a faulted guest,
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
Command order, timestamps and active/terminal state do not establish process
ancestry. The hook preserves the complete raw actor list and observed failures.
Without a caller root and complete authoritative runtime inventory, aggregate
capacity, allocator/heap counters and headroom remain null. Failed children and
unrelated commands stay visible as separate raw facts. See the
[attribution contract](../guides/memory-attribution.md) for root validation.


## Linked-group lifecycle reference

The executor's link lifecycle is adapted from Waffle `link/worker.ts` at the
pinned `waffle-v0.0.105` release. It keeps Waffle's preparation, active checks,
initialization, and group disposal. The local changes retain access to side
instances for telemetry, establish an allocator-only reader before constructor
execution, and publish cached terminal data before disposal. Linking and memory
reservation remain Waffle's public implementation. The shared cells, schema,
allocator wrappers, and root attribution are original adapters.
