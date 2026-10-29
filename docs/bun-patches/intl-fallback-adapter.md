### Intl fallback adapter

The retired `crates/bunwasm-runtime/src/js/intl.ts` was a **Host feature** and an **original adapter**, not a copied Bun or WebKit implementation. Its comparison sources were Bun's pinned WebKit `Source/JavaScriptCore/runtime/Intl*.cpp` at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. It supplied an en-US fallback and was converted to TypeScript without changing runtime behavior. The [FormatJS and ICU4X integration](intl.md) replaces it with real locale data and library implementations; no code from this fallback remains.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Retired `crates/bunwasm-runtime/src/js/intl.ts` | Host feature | Original en-US fallback, replaced by the generated library integration. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
