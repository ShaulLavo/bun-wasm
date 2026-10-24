### Node assertions

`crates/bunwasm-runtime/src/js/assert.js`. Class **Port**. Upstream `src/js/node/assert.ts` and `src/js/internal/assert/assertion_error.ts` at the Bun pin, which carry Node assertion code.

Retain assertion dispatch, expected-exception matching, async rejection helpers, readable operator messages, and assertion-error formatting conventions. Replace internal imports, native diff helpers, and primordials with the local utility inspector, equality functions, and a JavaScript diff renderer. Source-expression recovery is omitted, so `ok(false)` reports `false == true`. This runs assertions without Bun's internal bindings. The adapted helpers are separate from the locally written diff implementation.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/assert.js`](#node-assertions) | Port | Adapt assertion helpers and messages to the local inspector and equality implementation. |

[Parent context](bun-patch-series.md).
