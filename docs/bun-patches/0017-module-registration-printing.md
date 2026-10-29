### 0017 module registration printing

File `0017-wasm-print-ES-module-bodies-for-registration-records.patch`. Class **Host feature**. Upstream source is Bun `src/js_printer/lib.rs` at `9510e74152073d850a18758ca41114d8f214ffa6`, after the existing WASI patches. The optional printer additions are retained from bun-wasm `74a1297868e397e820c390b8c49ae734fbdef2d6`.

`src/js_printer/lib.rs` adds `with_bunwasm_register`, off by default. Inside it the printer writes an ES module body for a registration record: top-level `await x` as `(yield x)`, a top-level `for await` as a `yield` loop that closes the iterator on early exit (a labeled loop stays a bare loop so `continue label` keeps its target), `import.meta` as `__bunwasm_m.meta`, `import(…)` as `__bunwasm_m.import(…)`, and a call of an imported function by name as `(0, ns.f)()`. A function-depth counter around function and arrow bodies decides what is top level.

bun-wasm's [module registration loader](module-registration-loader.md) needs it to run ES modules with top-level await on engines without native ES modules (Hermes). Normal Bun output and `bun build` never enable it.

The record-mode arm also handles Bun's specialized `EImportMetaMain` node. It
prints direct and inverted `import.meta.main` as `__bunwasm_m.meta.main` and its
negation, including nested functions. This node bypasses the general
`EImportMeta` arm. Its ordinary ESM and Node/CommonJS arms remain unchanged.
The focused registration test checks those ordinary outputs and the record
forms; `tests/hermes/metadata-main.mts` checks main and dependency metadata on
the actual pair.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0017](#0017-module-registration-printing) | Host feature | Add an optional printer mode for ES module bodies run by a script-only engine. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
