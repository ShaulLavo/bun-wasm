# QuickJS memory telemetry

Class **Host feature**. The upstream baseline is QuickJS-ng bundled in rquickjs-sys 0.13.0, `quickjs/quickjs.c`, `quickjs/quickjs.h`, and its generated Linux and WASI bindings. The local paths are under `third_party/rquickjs-sys/`.

`JSMemoryUsage` gains `array_buffer_count` and `array_buffer_size`. The existing object walker counts attached ordinary and shared ArrayBuffer backing-store byte lengths. Typed views share the counted buffer. Detached buffers and borrowed WebAssembly.Memory aliases do not count. Sizes describe the visible payload, not allocator padding or reserved maximum sizes. Shared backing stores represented by multiple objects are not deduplicated across runtimes.

The malloc, calloc, and realloc paths latch the first failed request in the runtime before the context wrappers construct an error. The record contains requested bytes and the allocator category. ArrayBuffer backing requests have their own category, including default resizing and custom SharedArrayBuffer allocation. A calloc product overflow has unknown size. Zero-size allocator conventions and invalid JS lengths rejected before allocation do not set a failure.

`JS_bunwasm_GetAllocationFailure` reads the record without clearing or allocating. `JS_bunwasm_ClearAllocationFailure` explicitly resets it for focused controls. The record survives later failed allocations, including failures during error construction. Requests before runtime creation, failures in other allocators, custom external-buffer reallocators, host termination, and traps are outside this record. It describes the first observed failure, including a failure from which the caller recovers, rather than claiming that every failure terminates the program.

The original Rust adapter in `crates/bunwasm-engine-quickjs/src/vm.rs` reports `JSMemoryUsage.malloc_size` as `heapTotal`, the buffer fields as `arrayBuffers` and `arrayBufferCount`, and the failure record as `failedAllocation`. The configured limit is not allocated memory. `heapUsed` remains upstream's incomplete structural estimate and can include borrowed memory. Wasm linear-memory capacity has its own `wasmCapacity` field. Native capacity, resident memory, and unmeasured external allocations are null. ArrayBuffer bytes overlap `heapTotal` and must not be added to it.

The runtime embeds a 96-byte cache of twelve u64 fields. `JS_bunwasm_RefreshMemoryTelemetry` updates heap counters at a normal boundary. `JS_bunwasm_MemoryTelemetry` only returns cached bytes and remains usable after failure without JS execution, allocations, heap walking, or GC. The failed request updates the cache in-place before error construction. Initial counters use UINT64_MAX until an explicit refresh. A thread-local runtime pointer in the original Rust adapter selects the side's live runtime and clears before destruction.

Both `quickjs_memory_telemetry_refresh` and `quickjs_memory_telemetry` are named in `scripts/build-engine-quickjs.sh` so section collection retains their code. The fixed layout is twelve little-endian u64 fields at consecutive offsets 0 through 88: ABI version, byte size, refresh sequence, malloc size, structural memory-used size, ArrayBuffer payload size, ArrayBuffer count, Wasm capacity, failed size, failed category, failed size-known flag, and counters-valid flag. ABI version is 1; size is 96; UINT64_MAX means unknown. Category 0 means no failure, 1 malloc, 2 calloc, 3 realloc, and 4 ArrayBuffer. Only refresh may walk the heap. Cached reads after failure must not call refresh.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c`, allocator paths and ArrayBuffer walker | Host feature | Count buffer payloads and retain the first failed request before error construction. |
| `third_party/rquickjs-sys/quickjs/quickjs.h`, memory fields, cached readout and failure API | Host feature | Extend the C readout without allocating JS values. |
| `third_party/rquickjs-sys/src/bindings/{wasm32-wasip1,x86_64-unknown-linux-gnu}.rs` | Host feature | Append both buffer fields and update size and offset checks to match the C ABI. |
| `crates/bunwasm-engine-quickjs/src/vm.rs`, memory readout | Original adapter | Report measured allocations, nullable unknowns, capacity, and failure attribution through the existing engine record. |
| `scripts/build-engine-quickjs.sh`, retained telemetry exports | Original adapter | Keep separate normal-boundary refresh and allocation-free cached side accessors. |
| `scripts/check-quickjs-memory-telemetry.ts` and `scripts/fixtures/quickjs-memory-telemetry.c` | Original test adapter | Exercise real allocation, release, aliases, and bounded failures without forced GC. The isolated Rust mode imports production modules without requiring Bun's full vendored workspace. |

[Existing QuickJS patches](quickjs.md). [Ledger scope and pinned revisions](scope.md).
