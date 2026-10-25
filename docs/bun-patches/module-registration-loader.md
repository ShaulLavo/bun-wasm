## Module registration loader

Class **Host feature**. Original adapters, no copied code. `crates/bunwasm-transpiler/src/register.rs` rewrites a module parsed by Bun's parser (pinned in [scope](scope.md)): import statements leave the code and their bindings print as live `namespace.name` reads through each symbol's existing `namespace_alias`, `export` keywords are stripped and exported names become getters, re-exports and `export *` become data. With [0014](0014-module-registration-printing.md) the body prints as a generator, and the result is a script expression any engine can evaluate.

`crates/bunwasm-runtime/src/js/esm_loader.ts` links those records and evaluates them by the ECMAScript module algorithm (ECMA-262 16.2.1.5: ResolveExport, GetExportedNames, InnerModuleEvaluation, ExecuteAsyncModule, AsyncModuleExecutionFulfilled/Rejected with GatherAvailableAncestors). It is written from the specification, not from an engine's implementation. Known differences from native modules: namespace properties are accessors rather than data properties, `let`/`const` exports read before initialization only throw where the engine enforces TDZ, and default-exported anonymous functions and classes take an internal name. `scripts/esm-loader-*.ts` and `tests/fixtures/esm-loader/` check it against Node.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`bunwasm-transpiler/src/register.rs`, `bunwasm-runtime/src/js/esm_loader.ts`](#module-registration-loader) | Host feature | Run ES modules with top-level await on engines without a native module loader. |

[Ledger scope and pinned revisions](scope.md).
