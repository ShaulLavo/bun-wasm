## Rollup WebAssembly distribution

`crates/bunwasm-runtime/src/install/resolve.rs` selects the official
`@rollup/wasm-node` npm distribution for Rollup 4 at the same version. The
measured package is 4.64.7, including `dist/native.js`,
`dist/wasm-node/bindings_wasm.js`, and `dist/wasm-node/bindings_wasm_bg.wasm`.
These upstream files remain unchanged inside installed projects. No Rollup
implementation is retained in this repository.

`crates/bunwasm-runtime/src/wasm.rs` and `src/js/webassembly.js` are original
adapters over the public `wasmi` 0.46.0 API and the WebAssembly JavaScript API.
They do not adapt an upstream implementation. The Wasmi dependency has the
small port described below. Resumable host traps let JavaScript imports reenter
wasm without holding a Rust borrow across JavaScript execution. Memory synchronization keeps
JavaScript views and interpreter memory consistent across those calls.

The original adapters also support standalone, unshared 32-bit memories and
memory imports. All instances in one runtime use one Wasmi Store, so imported
memories retain their actual interpreter identity. Private numeric resource IDs
never serve as public import values. The JavaScript identity registry uses weak
references. Successful growth detaches the old buffer, including zero-page
growth. A failed grow keeps the current buffer and bytes.

Wasmi 0.46.0 cannot represent shared memories or atomic instructions. The
constructor explicitly refuses `shared: true`; it never substitutes an unshared
buffer. Wasmi retains native modules, instances, and memory allocations until
runtime teardown. Dropping the runtime drops the Store and all its buffers.
JavaScript garbage collection does not reclaim individual native allocations.
Per-memory reclamation needs a separate Store ownership or allocator design.
These capabilities do not establish Nuxt or emnapi application acceptance.
`tests/fixtures/webassembly` is original test code; `tests/rollup/run.mjs`
executes the real published parser and hashes through the recorded registry.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Rollup distribution and WebAssembly adapters](#rollup-webassembly-distribution) | Host feature | Select an unchanged official wasm distribution and execute it through original interpreter adapters, including standalone and imported unshared memory. |

[Ledger scope and pinned revisions](scope.md).
