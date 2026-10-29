# QuickJS memory telemetry

Class **Host feature**. The upstream baseline is QuickJS-ng bundled in rquickjs-sys 0.13.0, `quickjs/quickjs.c` and `quickjs/quickjs.h`. The local paths are under `third_party/rquickjs-sys/`.

The original Rust adapter in `crates/bunwasm-engine-quickjs/src/vm.rs` reports `JSMemoryUsage.malloc_size` as `heapTotal`. The configured limit is not allocated memory. Wasm linear-memory capacity has its own `wasmCapacity` field. Native capacity, resident memory, and unmeasured external allocations are null.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-engine-quickjs/src/vm.rs`, memory readout | Original adapter | Report actual QuickJS allocations and separate Wasm capacity from unknown resident and external memory. |

[Existing QuickJS patches](quickjs.md). [Ledger scope and pinned revisions](scope.md).
