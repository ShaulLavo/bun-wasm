# JSC memory telemetry

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `jsc/webkit-wasi.patch`, `runtime/WASIMemoryTelemetry.h` | Port | Original WASI allocation recorder. No upstream implementation copied. |
| WebKit `runtime/JSArrayBufferView.cpp`, `runtime/ArrayBuffer.cpp`, and `heap/Heap.h` | Port | Minimal WASI-only allocation scopes and a read-only accessor for the existing completed-full-GC timestamp. |
| `crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}` and `crates/bunwasm-engine-jsc/src/vm.rs` | Port | Original adapters to existing JSC heap and option APIs, plus a cached readout. No upstream implementation copied. |

The upstream reference is Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The touched paths are
`Source/JavaScriptCore/runtime/{ArrayBuffer.cpp,JSArrayBufferView.cpp}` and
`Source/JavaScriptCore/heap/Heap.h`.
The adapters reference `heap/{Heap.h,Heap.cpp,MarkedSpace.cpp}` and
`runtime/Options{,List}.h` at that revision.

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

The producer must retain both exports in the JSC side. No shared core or
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

Category 1 is a typed-array vector and 2 is a fixed ArrayBuffer backing store. `allocationSequence`
counts outermost attempts. `failedAllocationSequence` identifies the most recent
failed attempt. A consumer reads all fields synchronously while guest execution
is stopped and maps unknown values before converting integers to JS numbers.

## Verification boundary

`bun test scripts/jsc-memory-telemetry.test.ts` compiles the
recorder header extracted from the actual WebKit patch. The CMake check manifest
runs it in CI after C++ tools are installed. Scratch uses the environment's
`TMPDIR` or `RUNNER_TEMP`, with `os.tmpdir()` as the fallback. Native scenarios cover
success, original failure retention, nested allocation attribution, and an
abandoned scope, requests wider than wasm32, repeated failures, and shared state
across translation units. Syntax checks compile the two patched upstream sources and the
adapter against retained WASI JSC headers. These checks establish recorder and
source behavior only. Actual counter movement, exported-symbol retention, safe
host reads after a real Wasm allocation failure, and acceptance without forced
GC require the producer's composed engine pair.
