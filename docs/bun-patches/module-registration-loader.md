## Module registration loader

Class **Host feature**. The registration pass and loader are original bun-wasm adapters, written against Bun's parser and ECMA-262 section 16.2.1.5. No engine implementation was copied. This ports the retained bun-wasm implementation from `74a1297868e397e820c390b8c49ae734fbdef2d6` to the paired core.

`crates/bunwasm-transpiler/src/register.rs` removes import and export statements from the parsed module. Imported names print as live namespace reads. Local exports become getters. Re-exports and star exports become record data. The optional [0017 printer mode](0017-module-registration-printing.md) prints the body as a generator, with top-level await expressed as yield.

`crates/bunwasm-runtime/src/js/esm_loader.ts` links and evaluates the records. It tracks cycle roots, pending async dependencies, and async parents in evaluation order. Its factory accepts `resolve`, `load`, and `initMeta` callbacks. A loaded module is either a record or a synthetic namespace. Synthetic named exports snapshot enumerable values, while the host supplies the default export separately. Virtual eval names bypass resolution. Dynamic imports from classic scripts use the non-enumerable `__bunwasm_import` hook.

The core owns lowering, source maps, resolution, and source preparation. `ModuleHost` exposes the factory source, record loading, and script lowering to the engine adapter. Native ES module engines continue to use `load` and wrapper handoffs. Record mappings compose before the existing prologue and transpiler mappings.

The browser engine uses the same loader for every ES module of a process without a module store, which is every browser worker ([The browser engine](../engine-browser.md#es-modules-records-with-live-bindings)). `web/src/module-records.ts` prepares a graph level by level, evaluates each record as an `export default (…)` module from a `blob:` or `data:` URL so stack frames keep a script URL, and hands CommonJS, JSON, text and builtin keys to `require`. `crates/bunwasm-transpiler/src/record_fixup.rs` rewrites the printed global `arguments` to the loader's `ga()`/`gt()` reads and maps imported calls, which V8 reports at the argument list, back to the call.

The loader captures the built-ins it uses when it is created, after the promise-job wrapper and before user code. Its namespace object is a Proxy over a sealed target with one writable, non-configurable data property per export, so descriptors, `Object.keys`, `in`, identity and TDZ errors match a native namespace. Named imports read accessors on an internal bindings object with an ordinary prototype, which V8 keeps in fast mode. Patch [0020](0020-registration-record-parsing.md) keeps module `this`, literal comparisons and anonymous defaults as written.

Known differences from native modules remain. `Function.prototype.toString` returns the printed record, with names and structure but not the file's formatting, comments or literal spelling. Assignment to a namespace import is not rejected as a module early error. On Node's V8, a named import read costs about five times a native one and a namespace property read about 45 times, because they go through an accessor and a Proxy trap. Imported calls cost about the same as native calls.

`scripts/esm-loader-*.ts` and `tests/fixtures/esm-loader/` compare the loader with Node. At test262 revision `0b4e0812022b18236b5276d2804948fdd9f71603`, the module-code run on Node reports 410 passes, no failures, 7 transform errors, and 182 skipped tests. The transform errors are eager parsing of intentionally invalid dependency fixtures. The 25 focused fixture cases pass.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-transpiler/src/register.rs`, `crates/bunwasm-runtime/src/js/esm_loader.ts`, and the paired source-preparation hooks | Host feature | Original adapters for live module bindings, cycles, top-level await, dynamic imports, and source maps on script engines. |
| `web/src/module-records.ts`, `crates/bunwasm-transpiler/src/record_fixup.rs`, and the `hostUseModuleRecords`/`hostModuleRecord` natives | Host feature | Original adapters that run every browser-engine ES module through the loader without a module store or service worker. |
| `scripts/esm-loader-*.ts`, `tests/fixtures/esm-loader/`, and the `transpile --register` example | Host feature | Original test harness and record regeneration tools restored from the coherent J1 handoff `2a12f721f58b7a4f461dd039c4ee50a5696ce9ad`; CI discovers the loader tests through `checks/quality-esm-loader.json`. |

[Ledger scope and pinned revisions](scope.md).

## Re-exported default imports

Bun's parser at `9510e74152073d850a18758ca41114d8f214ffa6`, in
`src/js_parser/scan/scan_imports.rs`, omits default imports from `named_imports`
when it does not bundle. The original registration adapter records these bindings
from import statements before it removes them, just as it records namespace
imports. An export clause referring to a default import becomes an indirect
export of the dependency's `default`, not a getter for an undeclared local.
The prepass also covers export clauses that appear before their imports.

This fixes wrappers such as eventemitter3's `import EventEmitter` followed by
`export { EventEmitter }`. It does not change CommonJS export snapshots or add
globals. The compiler regressions cover both export aliases and import order.
The discovered native fixture `tests/fixtures/default-import-reexport` checks
CommonJS constructor identity and live ES module default re-exports. An
`export default value` expression must still retain its evaluated snapshot.

The fixture's `.mjs` and `.cjs` files are deliberate JavaScript module-format
inputs, classified in `scripts/typescript-source-runtime-inputs.txt`, not host
helpers or new legacy-source exceptions.
