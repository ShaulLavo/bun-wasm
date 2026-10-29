# Hermes heap telemetry

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-hermes/cpp/{memory-telemetry.h,shim.cpp}`, `src/lib.rs` | Host feature | Original cache and C/Rust ABI adapter around Hermes `include/hermes/VM/GCBase.h` and `lib/VM/gcs/HadesGC.cpp` at `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065`. Calls the existing `getHeapInfo` API. No upstream implementation is copied or patched. |
| `crates/bunwasm-engine-hermes/src/{lib,vm}.rs`, `scripts/build-engine-hermes.sh` | Host feature | Original side exports, process memory readout and terminal refresh latch. Uses the existing QuickJS/JSC cached/refresh export convention. |
| `web/src/memory-telemetry.ts`, `scripts/hermes-memory-telemetry.test.ts`, `crates/bunwasm-hermes/tests/memory-telemetry.cpp` | Host feature | Original Hermes decoder and bounded ABI, lifecycle and export controls. The C++ cache control uses explicitly synthetic input, without a VM. |

## ABI 1

`hermes_memory_telemetry` returns cached bytes only. It neither calls the VM nor
allocates, evaluates JavaScript, walks objects or requests GC. The record is
exactly eight little-endian u64 fields, aligned to eight bytes. The host rejects
other versions, sizes and invalid pointers. It supports no older layout.

| Offset | Field | Meaning |
| --- | --- | --- |
| 0 | `abi_version` | 1 |
| 8 | `byte_size` | 64 |
| 16 | `refresh_sequence` | Successful readouts, initially zero |
| 24 | `heap_used` | `HeapInfo.allocatedBytes` |
| 32 | `heap_capacity` | `HeapInfo.heapSize` |
| 40 | `external` | `HeapInfo.externalBytes` |
| 48 | `counters_valid` | Zero until the first successful refresh, then one |
| 56 | `refresh_disabled` | One during refresh, after VM fatal handling or after the engine run returns |

Byte counts start at UINT64_MAX. The host converts that sentinel and integers
above Number.MAX_SAFE_INTEGER to null. Invalid counters remain null even if
their raw slots contain numbers. Sequence, validity and disabled state remain
visible in `engineCounters`.

`hermes_memory_telemetry_refresh` calls `getHeapInfo` only while the shim has a
runtime and refresh is enabled. The record is disabled before the call. An
interrupted call preserves the last complete counters and cannot reenter the
reader. Successful completion publishes the three counters and advances the
sequence. Fatal handling and the engine's returning path permanently disable
refresh without erasing the cached counters. No runtime destructor is added.

The existing host permits refresh only at normal `bun_core_idle` and
`bun_core_poll` boundaries. Other imports read the cache. A known allocation
failure, host refresh trap or terminal state latches off further host refresh.
Output and exit preserve the cached sample before disposal. Failed constructors
use the existing allocator-only reader, with no side access. The ordinary
`process.memoryUsage()` implementation reads this same cache after a normal VM
refresh during JavaScript execution.

## Counter semantics

`jsHeapBytes` is Hermes's currently allocated JS heap bytes. Unreachable objects
can remain included until collection. It is neither a reachable-object census
nor the linear-memory capacity. `heapCapacityBytes` is Hermes's heap capacity.
Hades accounts heap segments here; this is not process RSS or remaining memory.

`externalBytes` is GC-accounted external memory retained by heap objects. It is
not an exact live ArrayBuffer backing-store aggregate. `arrayBufferBytes` and
`swcBytes` remain null. VM heap and external counters overlap the common libc
allocator accounting and cannot be added to it as independent memory.

Hermes has no engine-specific failed-request readout in this adapter. A VM fatal
message or trap does not establish a requested size or allocation category.
`engineFailure` stays null. The common allocator preserves its actual first
failed request bytes and category, including null size on calloc overflow.
The raw process identity and root-attribution rules are unchanged. Independent
process limits do not become shared headroom.

## Qualification

`source env.sh && bun test scripts/hermes-memory-telemetry.test.ts` checks the
host decoder, cached/normal refresh separation, exact layout, nullable fields,
failure and terminal paths. It compiles a small C++ cache control and the Rust
layout test. These prove ABI and adapter behavior with synthetic data. They do
not establish live Hermes allocation movement or a produced Wasm export table.

Artifact qualification requires the canonical producer to compile this shim
into a current Hermes VM archive, retain both side exports and issue a matched
core/side/launcher closure from its selected source and profile. The producer
must check real heap movement and unchanged cached refresh sequences around
allocation, failure, initializer failure and teardown. No qualification can be
transferred from an older diagnostic pair by relabeling its receipts.
