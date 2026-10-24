### Node assertions

`crates/bunwasm-runtime/src/js/assert.ts`. Class **Port**. Upstream `src/js/node/assert.ts` and `src/js/internal/assert/assertion_error.ts` at the Bun pin, which carry Node assertion code. The direct Node import revision is not recorded.

Retain assertion dispatch, expected-exception matching, async rejection helpers, readable operator messages, and assertion-error formatting conventions. Replace internal imports, native diff helpers, and primordials with the local utility inspector, equality functions, and a JavaScript diff renderer. Source-expression recovery is omitted, so `ok(false)` reports `false == true`. This runs assertions without Bun's internal bindings. The adapted helpers are separate from the locally written diff implementation.

The strict TypeScript migration preserves the original JavaScript AST and strict directive. Type-only class fields retain constructor assignment order. Error property matching and async rejection inputs remain unknown until the existing runtime checks establish their shape.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/assert.ts`](#node-assertions) | Port | Adapt assertion helpers and messages to the local inspector and equality implementation. |
| [`assert_util_types.d.ts`](#node-assertions) | Host feature | Original strict-TS declarations for the local assertion and utility module boundaries. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
