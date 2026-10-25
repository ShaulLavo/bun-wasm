### 0014 module registration printing

File `0014-wasm-print-ES-module-bodies-for-registration-records.patch`. Class **Host feature**.

`src/js_printer/lib.rs` adds `with_bunwasm_register`, off by default. Inside it the printer writes an ES module body for a registration record: top-level `await x` as `(yield x)`, a top-level `for await` as a `yield` loop that closes the iterator on early exit (a labeled loop stays a bare loop so `continue label` keeps its target), `import.meta` as `__bunwasm_m.meta`, `import(…)` as `__bunwasm_m.import(…)`, and a call of an imported function by name as `(0, ns.f)()`. A function-depth counter around function and arrow bodies decides what is top level.

bun-wasm's [module registration loader](module-registration-loader.md) needs it to run ES modules with top-level await on engines without native ES modules (Hermes). Normal Bun output and `bun build` never enable it.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0014](#0014-module-registration-printing) | Host feature | Add an optional printer mode for ES module bodies run by a script-only engine. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
