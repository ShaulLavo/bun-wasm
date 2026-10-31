# JSC memory telemetry

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `jsc/webkit-wasi.patch`, `runtime/WASIMemoryTelemetry.h` | Port | Original WASI allocation recorder. No upstream implementation copied. |
| WebKit `runtime/JSArrayBufferView.cpp`, `runtime/ArrayBuffer.cpp`, `runtime/JSGenericTypedArrayViewInlines.h`, and `heap/Heap.h` | Port | Minimal WASI-only allocation scopes, an observe-only direct typed-array request scope with an explicit nullable-failure latch before OOM exception construction, and a read-only accessor for the existing completed-full-GC timestamp. |
| `crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}` and `crates/bunwasm-engine-jsc/src/vm.rs` | Port | Original adapters to existing JSC heap and option APIs, plus a cached readout. No upstream implementation copied. |
| `crates/bunwasm-jsc/tests/typed-array-create.h` | Port test fixture | Unchanged prefix of WebKit `Source/JavaScriptCore/runtime/JSGenericTypedArrayViewInlines.h` through its first `create` overload at the revision below, including its license. Replays the maintained patch without a full JSC build. |
| `crates/bunwasm-jsc/tests/{memory-telemetry.cpp,typed-array-create.cpp}` and `scripts/jsc-memory-telemetry.test.ts` | Original test adapter | Compiles the patched recorder and actual patched `create` body against isolated callbacks. No VM, allocator, GC, or exception implementation is copied. |
| WebKit `runtime/WASIMemoryTelemetry.h` (allocation boundary), `runtime/JSArrayBufferView.cpp` and `heap/Heap.h` | Port | WASI-only allocation-boundary record and probe around the two oversize Gigacage calls, plus three read-only `Heap` accessors. Original code; no upstream implementation copied. |
| `crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}`, `crates/bunwasm-engine-jsc/src/vm.rs`, `scripts/build-engine-jsc.sh` | Port | Original side binding to the core's existing allocator exports, control and subject arming, and the cached `jsc_allocation_boundary` export. |
| `web/src/jsc-allocation-boundary.ts`, `web/src/{memory-telemetry.ts,bun-executor.ts}` | Host feature | Original typed reader, loaded lazily only for an armed JSC process. |
| `crates/bunwasm-jsc/tests/allocation-boundary.cpp`, `scripts/jsc-allocation-boundary-qualify.ts`, `scripts/jsc-allocation-boundary.test.ts` | Original test adapter | Executable controls against the actual patched header, and the qualification script for a later built side and run readout. |

The upstream reference is Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The touched paths are
`Source/JavaScriptCore/runtime/{ArrayBuffer.cpp,JSArrayBufferView.cpp,JSGenericTypedArrayViewInlines.h}` and
`Source/JavaScriptCore/heap/Heap.h`.
The adapters reference `heap/{Heap.h,Heap.cpp,MarkedSpace.cpp}`,
`runtime/Options{,List}.h` and, for the boundary control,
`runtime/{JSGenericTypedArrayView.h,JSGlobalObject.h}` at that revision.

## Heap accounting

`process.memoryUsage()` returns JSC `Heap::size()` as `heapUsed`,
`Heap::capacity()` as `heapTotal`, `Heap::extraMemorySize()` as `external`,
and `Heap::arrayBufferSize()` as `arrayBuffers`. `rss` is null. These values
never use Wasm memory capacity. The adapter does not collect garbage.

These are JSC's GC-accounted estimates. `size()` counts marked cells and extra
memory. It does not count every newly allocated, unmarked cell.
`capacity()` includes object-space capacity and extra memory. `extraMemorySize()`
includes the ArrayBuffer set, so the counters overlap. Small typed-array vectors
can live in GC object space, while oversized vectors contribute to extra memory.
ArrayBuffer accounting is refreshed by GC and can include detached or dead
backing stores until the appropriate sweep. The adapter does not claim an exact
live backing-store inventory. Consumers must leave that unavailable aggregate
null rather than substitute the ArrayBuffer estimate or a zero.

The readout also records heap size after the last collection, before and after
the last full collection, cumulative GC-accounted allocation, and effective
`useGC`, `useGenerationalGC`, `useConcurrentGC`, `gcMaxHeapSize`, `smallHeapSize`,
and `largeHeapSize`. A zero `gcMaxHeapSize` means no explicitly configured cap.
The configured small and large heap sizes are policy inputs, not available
memory. `allocationBudgetThisCycle()` exposes the heap's current effective
Eden allocation budget. Collection-size counters stay unknown until the
corresponding collection has occurred. A WASI-only accessor checks the existing
completed-full-GC timestamp. The initial full-GC duration is a policy heuristic
and does not prove that a full collection occurred.

## Allocation failure capture

A WASI-only scope records the original byte request before typed-array vector
allocation and fixed ArrayBuffer allocation. Failed scopes latch the original
request before their caller constructs an OOM exception. Ordinary exception allocations do not enter these scopes and cannot replace it.
A subsequent independent typed-array or fixed ArrayBuffer failure replaces the
record, so an earlier caught failure cannot mask the current request. The byte multiplication widens WASI's 32-bit
length to 64 bits before multiplication. Limit rejection therefore retains the
original request too. The category identifies the path, not the reason for
failure. An oversize rejection does not itself prove allocator exhaustion.

The scope stores no JS values, allocates no memory, formats no strings, and
performs no GC. Nested scopes retain the outer request. A Wasm trap does not
unwind C++ scopes. In that case the active request remains available and the
failed request remains unknown unless a scope had already reported failure.
The producer's allocator failure record can distinguish that case.

The direct `JSGenericTypedArrayView<Adaptor>::create(JSGlobalObject*, Structure*,
size_t length)` overload has an observe-only outer scope. Its original logical
request is `uint64_t(length) * sizeof(Adaptor::Type)`. The scope stays active
while the inner vector scope completes and the result cell is allocated and
finished. `FailurePolicy::ObserveOnly` never reports a failed allocation from
scope exit or abandonment. When `ConstructionContext` returns failure, the
existing `if (!context)` branch explicitly calls `request.fail()` before
`throwOutOfMemoryError`. This writes the cached failure immediately, without
ending the active scope or relying on exception construction to return or unwind.
It leaves allocation, GC, returns, and exception behavior unchanged. An inner
vector scope can also report a returned failure. Repeated reports for the same
outer sequence retain the original request. A result-cell assertion after a
successful context instead leaves an active request
with no fabricated engine failure. The logical request is not the cell size,
marked-block size, allocator padding, or proof that the vector allocation failed.
Other overloads are unchanged.

This hook cannot recover the historical request length from terminal text or
an allocator slab failure. Those quantities remain unavailable. If a recorder
caller has no exact logical request, `UINT64_MAX` remains the unknown-byte value
and consumers leave bytes null. The core libc failure, the JSC cached latch, and
raw terminal observations remain separate records. The 65,536-byte aligned
allocation in the retained Next diagnostic is a libc request, not a typed-array
length or proof of a particular memory-cap cause.

The recorder is single-agent state, matching this WASI JSC port. The most recent scoped failure remains latched across samples and successful
allocations. A later failed outermost scope replaces it. This change does not instrument every
allocation in JSC, externally supplied ArrayBuffer bytes, buffer growth, or
all native failures.

## Cached binary readout

`jsc_memory_telemetry_refresh()` samples the live VM at a normal execution
boundary and returns a pointer. `process.memoryUsage()` also refreshes it.
`jsc_memory_telemetry()` returns the cached pointer without entering JSC or
allocating. The latter can be read after allocation failure or a Wasm trap.
A host must never refresh a faulted guest. After failure, heap and configuration
values remain the cached last-good sample, not failure-time measurements.
Allocation fields update independently at the allocation site.

The producer must retain both exports in the JSC side, plus `jsc_allocation_boundary` (below). No shared core or
allocator API changes are part of this patch. The snapshot is 192 bytes, aligned
to eight bytes, with 24 little-endian unsigned 64-bit fields. Unknown counters
use `UINT64_MAX` and map to JSON null. Categories use zero for no record.

| Index | Field |
| --- | --- |
| 0 | `abiVersion`, currently 1 |
| 1 | `byteLength`, currently 192 |
| 2 | `snapshotSequence`, zero before the first refresh |
| 3 | `heapUsed` |
| 4 | `heapTotal` |
| 5 | `extraMemory` |
| 6 | `arrayBufferBytes` |
| 7 | `heapAfterLastCollection` |
| 8 | `heapBeforeLastFullCollection` |
| 9 | `heapAfterLastFullCollection` |
| 10 | `totalBytesAllocated` |
| 11 | `gcMaxHeapSize` |
| 12 | `smallHeapSize` |
| 13 | `largeHeapSize` |
| 14 | `gcEnabled` |
| 15 | `generationalGcEnabled` |
| 16 | `concurrentGcEnabled` |
| 17 | `allocationSequence` |
| 18 | `activeAllocationBytes` |
| 19 | `activeAllocationCategory` |
| 20 | `failedAllocationBytes` |
| 21 | `failedAllocationCategory` |
| 22 | `failedAllocationSequence` |
| 23 | `allocationBudgetThisCycle` |

Category 1 is a typed-array logical request and 2 is a fixed ArrayBuffer backing store. `allocationSequence`
counts outermost attempts. `failedAllocationSequence` identifies the most recent
failed attempt. A consumer reads all fields synchronously while guest execution
is stopped and maps unknown values before converting integers to JS numbers.

## Allocation-boundary diagnostic

This diagnostic records what the heap and the core allocator looked like immediately before and
after the two real oversize typed-array allocation calls (`Gigacage::tryZeroedMalloc` and
`Gigacage::tryMalloc` in `JSArrayBufferView::ConstructionContext`). It exists to tie a JSC
typed-array failure to the system allocator call that returned null. It is off by default.

**Arming.** `BUN_WASM_JSC_ALLOCATION_BOUNDARY=1` in a guest process's environment arms it. Each JSC
process arms its own VM before any program code runs.

**Generation.** For every armed JSC instance the browser executor picks a fresh random generation
in 1 to 2^53 - 1 and passes it as `BUN_WASM_JSC_ALLOCATION_BOUNDARY_GENERATION`, replacing any
value inherited from a parent process. The limit keeps the value exact as a JavaScript number in
snapshots. The VM acknowledges the generation by writing it into the record header when it arms the
control, and into every slot it writes. A missing, zero or out-of-range generation rejects the
record (`generationAbsent`) before the control runs, so the process stops. Neither a guest pid
nor a counter is used: both repeat across workers. The reader carries the host's value as
`allocationBoundary.expectedGeneration` beside the record's `allocationBoundary.generation`.
`boundaryGenerationFindings` in the reader treats a record as evidence only for the instance
whose generation it acknowledges, in the header and in each recorded control or subject slot. It
reports a missing challenge, a missing acknowledgement, a mismatch, and a generation that appears
in two records, which means one record was copied or reused across instances.

Arming then happens in two steps:

1. The control step arms the record for the process's VM, global object and generation. It then creates one
   1001-element `Uint8Array` through the instrumented construction path. That size is above
   `fastSizeLimit` (1000), so it takes the oversize `ZeroFill` branch while staying far below the
   cap. The control is acknowledged only when the record shows exactly one observed attempt, in
   the armed VM and context, written under the record's generation, with the exact request, a
   non-null result, a successful creation, no oversize call in another VM, and core counters
   showing one allocation and no new failure.
2. Only then does the record move to `subjectArmed`. Any other outcome moves it to `rejected` with
   a reason, and the subject is never armed. The process then stops before running program code
   (a Rust panic naming the state and reason), so a run cannot proceed without coverage.

The control never forces an allocation failure, so it does not consume the core's first-failure
latch or JSC's cached failure fields.

**What the probe does.** A disarmed record costs one state load. When armed, the probe reads
`errno` first, then the request (bytes, element count and width, fill mode), the cached
allocation sequence, the VM and global object addresses, the JSC heap pacing values, and the
core's allocator counters and first-failure tuple. After the call it reads `errno` first again,
then the null-result flag and the core values. It never writes `errno`, so callers see whatever
the allocator left. Both `errno` values are raw: zero does not prove the allocator did not write
it. The probe allocates nothing, takes no lock, never collects or retries, and changes no
allocation, cache or cap policy. The core reads are synchronous calls to the existing
`bun_memory_telemetry` and `bun_memory_failure_telemetry` exports, which the side imports by name.
They load plain fields and store the current page capacity; they never touch `errno`. The old
lock-taking `bunjsc_refresh_memory_telemetry` and its 192-byte snapshot are not used.

The heap values come from public getters (`capacity`, `extraMemorySize`, `arrayBufferSize`,
`totalBytesAllocated`, `allocationBudgetThisCycle`, `sizeAfterLastCollection`) and three new
WASI-only const accessors on `Heap`: `maxHeapSize`, `bytesAllocatedThisCycle` and `ramSize`. All
are O(1) field reads. `sizeAfterLastCollection` stays unobserved until a collection has happened.

**Slots.** `last` holds the most recent armed attempt and is written before the call, so a trap
inside the allocator leaves the request and before-values readable with the after-call words
unobserved. `control` holds the control attempt. `subject` latches the first null result after
the subject was armed; later failures only increment `subjectFailures`. Oversize calls in another
VM increment `coverageMisses` and are never recorded.

**Reading it.** `jsc_allocation_boundary()` returns a pointer to the cached record without entering
JSC. It is safe after an allocation failure or a trap. The browser executor imports
`web/src/jsc-allocation-boundary.ts` only for a JSC process with the variable set; normal bundles
keep it in a separate lazy chunk. The reader adds `allocationBoundary.*` keys to that process's
`engineCounters`. A word whose availability bit is clear, or an unknown value, becomes null; no
field is filled with zero. A process without the export gets no keys.

**What it can and cannot show.** A latched subject alone proves only that the Gigacage call returned
null. A core failure delta of exactly 1 with an unchanged allocation count shows that the core's
wrapped libc entry ran and returned null. Nothing else runs between the two samples. A delta of 0
means the null never reached the wrapper. No field proves fragmentation, refused memory growth, or
which step inside wasi-libc's allocator failed, and the record computes no aggregate or headroom.
The memory authority stays 1 GiB. The host snapshot's `id`, `commandId` and `commandSequence`
are bookkeeping beside the record. The acknowledged generation, not that bookkeeping, ties a
record to its instance.

**Record layout.** 1032 bytes, 129 little-endian u64 words, ABI version 1. Unknown is `UINT64_MAX`.

| Words | Field |
| --- | --- |
| 0-1 | `abiVersion` (1), `byteLength` (1032) |
| 2 | `state`: 0 disarmed, 1 control armed, 2 subject armed, 3 rejected |
| 3 | `rejection`: 0 none, 1 control not observed, 2 control attempts, 3 coverage miss, 4 control failed, 5 control request, 6 control identity, 7 core unavailable, 8 core failure count, 9 core allocation count, 10 generation absent, 11 control generation |
| 4 | `coreSamplerBound` |
| 5-6 | `expectedVmAddress`, `expectedGlobalObjectAddress` |
| 7 | `controlLength` (1001) |
| 8-10 | `armedAttempts`, `subjectFailures`, `coverageMisses` |
| 11 | `generation`, set once when the control is armed |
| 12-50, 51-89, 90-128 | slots `last`, `control`, `subject` |

Each slot has 39 words: `recorded`, `availability` (bit *i* set means word *i* was observed),
`attempt`, `requestSequence`, `requestBytes`, `elementCount`, `elementSize`, `zeroFill`,
`vmAddress`, `globalObjectAddress`, `errnoBefore`, `errnoAfterCall`, `resultNull`; nine heap
values (`capacity`, `extraMemory`, `arrayBufferBytes`, `totalBytesAllocated`,
`bytesAllocatedThisCycle`, `allocationBudgetThisCycle`, `maxHeapSize`, `sizeAfterLastCollection`,
`ramSize`); and eight core values before and eight after (`live`, `peak`, `capacity`, `failures`,
`allocations`, `frees`, `firstFailureSize`, `firstFailureCategory`); and the `generation` it was
written under. The C++ static asserts, the
Rust `const` asserts in `sys.rs` and the TypeScript reader's field count pin the same layout.

**Qualifying a built side.** These source controls do not qualify any binary. For the later
exact-source build:

```sh
bun scripts/jsc-allocation-boundary-qualify.ts binary <bun-core.wasm> <engine.wasm>
bun scripts/jsc-allocation-boundary-qualify.ts readout <snapshots.json> [--require-subject]
```

`binary` checks that the side exports `jsc_allocation_boundary` and the two existing telemetry
getters as `() -> i32`, imports `env.bun_memory_telemetry` and `env.bun_memory_failure_telemetry`
with that type, and imports the core's `errno` cell as `GOT.mem.errno` i32. It also checks that the
core exports both functions with the same type and `errno` as an immutable i32 address. On the
F6 packet it reports exactly the three missing diagnostic entries.
`readout` takes the memory snapshots of a run with the variable set, for example an app-matrix
`rawProcesses` list. Every JSC process must carry an acknowledged control in its armed VM. Any JSC
typed-array failure must match the latched subject's sequence and bytes. The verdict reports
whether the core delta shows a wrapped libc null.

## Verification boundary

`bun test scripts/jsc-memory-telemetry.test.ts` compiles the
recorder header extracted from the actual WebKit patch. The CMake check manifest
runs it in CI after C++ tools are installed. Scratch uses the environment's
`TMPDIR` or `RUNNER_TEMP`, with `os.tmpdir()` as the fallback. Native scenarios cover
success, original failure retention, nested allocation attribution, and an
abandoned scope, requests wider than wasm32, repeated failures, and shared state
across translation units. The observe-only construction case keeps the request
active after vector success, does not turn observation into engine failure,
and preserves a real nested vector failure. Syntax checks compile the two patched upstream sources and the
adapter against retained WASI JSC headers. These checks establish recorder and
source behavior only. Actual counter movement, exported-symbol retention, safe
host reads after a real Wasm allocation failure, and acceptance without forced
GC require the producer's composed engine pair.

The source replay applies the actual typed-array patch hunks to the pinned
upstream fixture, then compiles the resulting `create` body with both WASI and
non-WASI callbacks. It checks success, nullable failure with an OOM callback
that returns, nullable failure with an OOM callback that exits without scope
unwinding, and a fatal result-cell callback after context success. Context,
cell, finish, and throw-scope counts check the original control flow. The header
controls also check explicit failure before scope exit and unknown bytes.
ABI version 1, all 24 field offsets, the 192-byte record, and the cached-only
export contract are unchanged.

`scripts/jsc-memory-telemetry.test.ts` also compiles
`crates/bunwasm-jsc/tests/allocation-boundary.cpp` against the patched header. It covers the
layout, a disarmed probe (no getter or core read, `errno` and result unchanged), an acknowledged
control, every rejection reason, an unbound or unreadable core, another VM, the subject latch with
raw `errno`, refused re-arming, a heap before its first collection, a trap before the call
returns, a zero, unknown or above-limit generation, and a control slot written under another
generation. A dump of the C++ record is decoded by the TypeScript reader. The test also checks that
the patch hunk wraps exactly the two Gigacage calls. `scripts/jsc-allocation-boundary.test.ts`
covers the reader, post-failure reads, unchanged counters without the diagnostic, lazy loading,
generation findings (missing, mismatched, unacknowledged in a slot, repeated across instances),
and both qualification modes. `web/tests/bun-executor.test.ts` checks that every armed JSC
instance gets a distinct safe-integer generation that replaces an inherited one. A future single canonical JSC build and composed
delivery must include the new patch; these source controls do not qualify an
old side binary or replace the actual Next gate.
