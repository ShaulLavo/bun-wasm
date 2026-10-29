# Nested WebAssembly regionizer

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-nested/src/` | Host feature | Original region confinement compiler, derived from the project's J11 measurement pilot; closed operator admission, checked memory rewriting, imported futex dispatch, active data initialization and index remapping. |
| wasm-tools `crates/wasm-encoder/src/reencode.rs`, release 0.228.0 | Adapter dependency | Calls the published `Reencode` trait and `utils` helpers at the core parser's version. No upstream function bodies are copied. Overrides index maps, sections and function bodies. |
| wasm-tools `crates/wasmparser/src/lib.rs`, release 0.228.0 | Interface reference | The closed operator names and the test fixture mnemonic table follow the published operator definitions. Uses `for_each_operator!` directly to check coverage of every memarg variant. No parser implementation is copied. |
| `crates/bunwasm-nested/tests/` and `examples/regionize.rs` | Host feature | Original native-versus-rewritten Wasmtime harness, deterministic wasm-smith generator, bounds and futex controls, and focused compiler example. |

The project-owned pilot is
`/work/reports/wave-20261029/engines/shared-memory/j11/pilot/regionize/src/main.rs`,
written for the approved J11 design on 2026-10-29. The production compiler ports
its memory stack shapes and widened checks from wasm-tools 0.262 to the core's
resolved wasmparser 0.228.0. It adds input/output validation, structured errors,
closed instruction admission, futex imports with explicit alignment checks,
minimal typed scratch locals, missing-section synthesis, canonical group memory
imports, and preflight of every active data destination before any initialization
writes. The pilot's measurement-only atomic lowering is not included.

The upstream dependency sources are Bytecode Alliance wasm-tools releases
`wasmparser-0.228.0` and `wasm-encoder-0.228.0` on crates.io, pinned by Cargo.lock.
Production uses the parser already linked by wasmi; Wasmtime's parser 0.240 is
only a host test dependency of this crate. No second production parser is added.
The tests use wasm-smith 0.228.0 and the existing host Wasmtime 39.0.2.

[The host contract](../nested-regionizer.md) records the original adapter ABI.
The `crates/*` workspace membership and Rust check package discovery give this
crate the existing single blocking Rust CI owner. No guest or launcher depends
on the new crate yet, and the current unshared executor is unchanged.

The test-only corpus adapter exports wasm-smith's termination-fuel global and
resets it before each call. It normalizes the generated memory to one initial
page with a two-page maximum and adds bounded atomic RMW and bulk fill/copy
probes to each generated function. This compensates for wasm-smith 0.228's lack
of atomic instruction generation and the sparse bulk sites in its unconstrained
corpus. Both native and rewritten runs receive identical adapted input bytes.
This is test generation, not a new host executor or integration path.
