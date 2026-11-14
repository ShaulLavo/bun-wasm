# WebAssembly validation without compilation

Classification: Original adapter.

`crates/bunwasm-runtime/src/wasm.rs` implements the ordinary in-guest
`wasm.validate` native with `wasmi::Module::validate(&engine, bytes).is_ok()`.
This is original integration code. No upstream source is changed or copied.

The dependency is the local `third_party/wasmi` 0.46.0 crate, built with
`default-features = false` and `features = ["std"]`, with the root Cargo lockfile.
Its upstream source is `crates/wasmi` at Wasmi revision
`50ac76771d631f642e8c4c61bf44c99546024461`. The relevant API is
`third_party/wasmi/src/module/mod.rs`, `Module::validate`. It uses the supplied
engine's Wasm features and validates function bodies without registering them
in the engine's code map. The runtime keeps its existing default parser limits,
binary-only input and `CompilationMode::LazyTranslation` configuration.

Previously, validation used `Module::new` only to return a boolean. Lazy
translation registers owned function bodies in the engine. In
`third_party/wasmi/src/engine/code_map.rs`, `SmallByteSlice` stores bodies of up
to 22 bytes inline and larger bodies in a copied `Box<[u8]>`. Dropping the
temporary module leaves those bodies in the engine until translation or engine
destruction. Validation alone needs none of that ownership.

`scripts/wasm-validation.test.ts` builds the actual runtime source and native
registry with the vendored Wasmi dependency, preserving dependency identities
from the root lockfile. Its standalone test executable counts only allocation
requests of 13,441 bytes. Three old validation calls retain three such bodies;
three actual runtime validation calls allocate none of that size. This proves
a saving of 40,323 payload bytes for that synthetic control, not zero total
allocation or a measurement of any application.

The same test checks valid and malformed binaries, enabled multi-value and
disabled SIMD, native argument errors, and compilation followed by input
mutation and destruction before first execution. Actual `wasm.compile` still
uses `Module::new` and retains the required lazy-body copy. Shared-group
`nested::validate` is unchanged. The test allocator exists only in the test
executable, outside the product.

This change does not remove the required compilation allocations reported at
13,441 and 1,001 bytes. It identifies no failed application module, process,
allocator backing or Safari refusal reason, and makes no iPhone OOM fix claim.
`Module::validate` is a validation API, not a guarantee that later translation
will succeed. New enforced parser limits or engine configuration changes need
their own assessment; this change introduces neither.
