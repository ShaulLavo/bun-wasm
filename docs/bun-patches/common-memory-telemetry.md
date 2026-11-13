# Common memory telemetry

The allocator growth hook records positive libc `sbrk` results within the outer
allocator request that freezes the first failure. These results do not identify
why growth failed. Shared-group growth remains owned by the existing libc broker.

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-cli/memory-telemetry.c` and `build.rs` | Port | Original adapter around the existing WASI libc allocation ABI. No upstream allocator implementation is copied or changed. |
| `crates/bunwasm-runtime/src/js/{process.ts,runtime.d.ts}` | Original adapter | Nullable memory values and derived RSS values preserve unknowns. No Bun or Node implementation copied. |
| `web/src/{memory-telemetry.ts,memory-channel.ts}`, executor and launchers | Host feature | Original readers and transport for core and engine snapshots. Uses Waffle's public linked-group API from the pinned package. |
| Bounded process registry, campaign reader and synchronous-child control | Original adapter | Use Waffle 0.0.123 process context, outcome and worker-memory APIs (`runtime.ts`, `proc/outcome.ts`, `browser/process-broker.ts`, source `8255a0cc806ef8fdc4d82557fbfe4b6d42c53dc7`). No upstream implementation is copied or changed. |
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

`bun_memory_failure_telemetry` returns thirteen little-endian u64 fields, 104 bytes.
They are ABI version 2, byte length, first failed request bytes, category,
previous allocation's usable bytes, allocator live bytes, allocator peak bytes,
Wasm capacity before the call, capacity after the failed call, positive `sbrk`
success count, positive `sbrk` failure count, last positive increment in bytes,
and first failed positive increment in bytes. It freezes
with the same first failure as the 80-byte record. Before failure, the category
is zero and all values after the header except category are unknown.
Previous usable bytes are zero for calls other than realloc and for realloc
with a null pointer. Capacity before the call is recorded only for realloc.
The getter only returns the frozen record, including after later frees or
allocations. It never walks a heap. Live and peak retain the outer-boundary
accounting above, so internal realloc temporary peaks remain unobserved.
Neither capacity nor live bytes identify a largest free block or a rejection reason.

The link wraps `sbrk` from the actual libc allocation path. Its observer calls the
real implementation once and records returned success or `(void *) -1` for positive
increments during the current outer allocator call, including nested calls.
Entry to each new outer call clears the working growth record. Zero and negative
increments do not overwrite it. A later successful positive call updates the last
increment and success count while preserving the first failed increment and failure
count. Unrelated calls outside an allocator wrapper are ignored. Recording uses
scalar stores and makes no calls of its own, so libc retains errno and return values.
The first frozen failure remains unchanged after subsequent calls.

This observes libc `sbrk`, not a browser failure reason. Ordinary unshared libc
performs memory growth itself; shared-group libc delegates to its existing broker
and may reserve group space differently. The hook changes neither path. A trap
before `sbrk` returns supplies no returned growth observation.

The browser host reads this cached export into the separate
`MemorySnapshot.frozenAllocatorFailure` field. It keeps the failed request's
`bytes` and `category`, `previousUsableBytes`, `allocatorLiveBytes`,
`allocatorPeakBytes`, `wasmCapacityBeforeBytes`, and `wasmCapacityAfterBytes`.
Its `growth` is `{ kind: "not-attempted" }` when both positive counts are zero.
Otherwise it is `{ kind: "attempted", successfulAttempts, failedAttempts,
lastIncrementBytes, firstFailedIncrementBytes }`. A nonzero failure count proves
a returned positive `sbrk` failure during this outer request, even if another
attempt succeeded. With only successes, it records growth followed by allocator
rejection. `firstFailedIncrementBytes` is null when there was no failed attempt.
Missing or invalid growth data never becomes `not-attempted`; inconsistent counts,
unsafe integers and missing required increments invalidate the record.

Its `reason` is always `"unknown"`. The field is null before a recorded failure
or when the export is unavailable. No current counters or terminal text fill
missing frozen values. UINT64_MAX and values above JavaScript's exact integer
range become null for the original fields. Version, exact byte length, wasm32
pointer range, alignment, and bounds are checked before decoding. Unknown
categories keep their raw code.
The reader never refreshes this record or enters an engine to read it.
Absent exports remain unsupported, unreadable or truncated records fail the read,
and invalid channel observations remain invalid. These states are not zero growth.
The record identifies the first failed outer request, which need not be the terminal
allocation or a source site inferred from a stack trace.

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
exactly 16, and [Hermes ABI 1](hermes-memory-telemetry.md) with exactly eight.
It preserves each engine's accounting semantics. JSC's GC-accounted
ArrayBuffer estimate is separate from the unavailable exact backing-store
aggregate. SWC remains null until independently attributed. These values overlap
allocator bytes and must not be added to them.

Only normal phase samples may invoke engine refresh. A detected failure or
terminal cleanup permanently disables refresh for that process. Terminal
snapshots use cached getters before linked-group disposal. The executor observes
side imports during `LinkedGroup.initialize()`, when pinned Waffle 0.0.107 creates
the side instances, and restores the WASI import resolver in `finally`. The
observer stays on each observed import through initialization and entry. A side
import the linker bound to a core export keeps that export itself, so the
engine's calls into the core, such as `malloc` and `free`, stay calls between
WebAssembly modules. Only the two waits below are observed among them; see
[Linked bindings stay direct](#linked-bindings-stay-direct). The
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
pinned `waffle-v0.0.107` release. It keeps Waffle's preparation, active checks,
initialization, and group disposal. Because Waffle creates side instances during
group initialization, the local WASI import resolver is wrapped for that
initialization call so each side wait import retains the refresh observer. The
local changes retain access to side instances for telemetry, establish an
allocator-only reader before constructor execution, and publish cached terminal
data before disposal. Linking and memory reservation remain Waffle's public
implementation. The shared cells, schema, allocator wrappers, and root
attribution are original adapters.

### Linked bindings stay direct

Waffle resolves a side module's imports through the same WASI import resolver
and passes it the bindings the linker made: core exports, relay functions and
the shared memory, table and globals. The first version of the observer wrapped
every function the resolver returned, including those bindings. Each engine call
into the core then left WebAssembly, ran a JavaScript closure and entered
WebAssembly again. The observer (`observeMemoryImports` in
`web/src/memory-channel.ts`) now receives those bindings and returns a bound
function unchanged unless it is `bun_core_idle` or `bun_core_poll`. Host
functions, in the core and in a side, are still observed on every call, so a
busy guest still answers a telemetry request at its next host call. The engine's
interrupt check reaches one through `core_checkpoint`, which calls the core's
observed `runtime_proc.signal` import.

Measured on November 11, 2026 with the Next.js starter's `bun run build` on the
JSC pair of CI run 42856642549, the same host source with and without this
change, each browser pinned to the same performance cores of a shared PC:

| Browser | Build before | Build after | Guest thread CPU, compile stage |
| --- | ---: | ---: | --- |
| Firefox 157 | 112.3 s | 101.3 s | 51.9 s to 36.0 s |
| Chrome 157 | 97.0 s | 75.5 s | 37.8 s to 24.9 s |

These are single non-quiet runs taken minutes apart, not a controlled benchmark.

## Shared channel framing

The original host transport keeps its 8192-byte shared channel and 32-byte header.
Namespaced engine counters are grouped by their first dot only in the wire frame,
then expanded to their original flat keys when read. This removes repeated JSC
allocation-boundary prefixes without omitting counters, changing their values, or
increasing the channel or guest memory limit. Snapshots without namespaced
counters keep their existing wire representation.

The JSC allocation-boundary check manifest also runs the channel regression. It
round-trips a complete wide diagnostic record through publication and teardown,
including null counters and the unchanged guest memory limit.

## Bounded host observations

The launcher registers runtime/PID identity before asynchronous setup. Original
host code retains typed outcomes, bounded terminal samples, and recent
adapter-cleanup worker censuses through weak runtime/service references. The
existing revocation callback captures selected outcomes before their process
records can be collected. Cleanup preserves that typed value and records its
observation boundary; unavailable reads are never synthesized as exit codes. The
read-only getter makes no guest calls. Both libc record reads must succeed
before an absent failure can be reported as measured. Missing records, channel
errors, unbound roots, stale samples, disposal and retention loss remain explicit.

The campaign reader projects documented numeric fields and bounded status enums.
Immediate launch-refusal details retain their existing separate collector and
bounded metadata helper. The common snapshot merger preserves those facts and
Browser trap counters across worker samples without adding them to the new
process-memory block. Its cached process samples keep their observed boundary;
legacy retained snapshots can accept a newer matching frame while remaining
terminal. Campaign budget fallbacks preserve already copied refusal facts.
The split/interpreter browser regression uses the unchanged ordinary pair and
synchronous `node` children, with post-entry and caught-error sentinels. Its exact
fixed ArrayBuffer request is 1,073,807,360 bytes. Nonce-bound captured child
streams and actual returned PIDs join one newly observed runtime/parent family;
broker directory, root and parent edges corroborate the launcher records.
Guest `process.pid` and `process.ppid` are not identity oracles. This qualifies
the existing libc recorder and host lifecycle path, not bootstrap failure or
browser growth refusal.
See [memory attribution](../guides/memory-attribution.md) for the boundaries.
