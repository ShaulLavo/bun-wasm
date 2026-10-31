### Inspection host hooks

`crates/bunwasm-runtime/src/js/inspect.js`, host integration around both formatters. Class **Host feature**. These are original bun-wasm additions around the Bun sources cited above, not another copied upstream file.

Read promise state/results, proxy targets, namespace brands, ordered keys, and remaining iterator entries through `internal` hooks. Use source-line lookup for error display. These hooks let an engine host expose information ordinary JavaScript cannot inspect reliably or without consuming an iterator. The QuickJS implementations are classified separately in the vendored-engine section.


The original stack parser adapter reads the engine and prepared-source lookup from `internal.native`, supplied by the bootstrap factory. Bind that object locally rather than reading an ambient `native` variable. Prepared browser frames still map through their generated filename without callee-column adjustment; ordinary JSC frames retain display-name mapping and callee columns. The source-only regression uses the retained 3cd/c276 Next dev failure stack and checks that error formatting preserves the original exception message.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/inspect.js`, host hooks](#inspection-host-hooks) | Host feature | Expose inspection state and bind stack source-mapping hooks from the factory input. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
