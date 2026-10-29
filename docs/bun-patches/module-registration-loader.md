## Module registration loader

Class **Host feature**. The registration pass and loader are original bun-wasm adapters, written against Bun's parser and ECMA-262 section 16.2.1.5. No engine implementation was copied. This ports the retained bun-wasm implementation from `74a1297868e397e820c390b8c49ae734fbdef2d6` to the paired core.

`crates/bunwasm-transpiler/src/register.rs` removes import and export statements from the parsed module. Imported names print as live namespace reads. Local exports become getters. Re-exports and star exports become record data. The optional [0017 printer mode](0017-module-registration-printing.md) prints the body as a generator, with top-level await expressed as yield.

`crates/bunwasm-runtime/src/js/esm_loader.ts` links and evaluates the records. It tracks cycle roots, pending async dependencies, and async parents in evaluation order. Its factory accepts `resolve`, `load`, and `initMeta` callbacks. A loaded module is either a record or a synthetic namespace. Synthetic named exports snapshot enumerable values, while the host supplies the default export separately. Virtual eval names bypass resolution. Dynamic imports from classic scripts use the non-enumerable `__bunwasm_import` hook.

The core owns lowering, source maps, resolution, and source preparation. `ModuleHost` exposes the factory source, record loading, and script lowering to the engine adapter. Native ES module engines continue to use `load` and wrapper handoffs. Record mappings compose before the existing prologue and transpiler mappings.

Known differences from native modules remain. Namespace properties are accessors. Lexical exports read before initialization depend on the script engine's generator environment. Anonymous default functions and classes take Bun's internal name. Assignment to a namespace import is not rejected as a module early error. The test262 runner records these limits rather than treating them as conformance passes.

`scripts/esm-loader-*.ts` and `tests/fixtures/esm-loader/` compare the loader with Node. At test262 revision `0b4e0812022b18236b5276d2804948fdd9f71603`, the module-code run on Node reported 390 passes, 20 failures, 7 transform errors, and 182 skipped tests. The transform errors include eager parsing of intentionally invalid dependency fixtures. The 15 focused fixture cases pass.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-transpiler/src/register.rs`, `crates/bunwasm-runtime/src/js/esm_loader.ts`, and the paired source-preparation hooks | Host feature | Original adapters for live module bindings, cycles, top-level await, dynamic imports, and source maps on script engines. |
| `scripts/esm-loader-*.ts`, `tests/fixtures/esm-loader/`, and the `transpile --register` example | Host feature | Original test harness and record regeneration tools restored from the coherent J1 handoff `2a12f721f58b7a4f461dd039c4ee50a5696ce9ad`; CI discovers the loader tests through `checks/quality-esm-loader.json`. |

[Ledger scope and pinned revisions](scope.md).
