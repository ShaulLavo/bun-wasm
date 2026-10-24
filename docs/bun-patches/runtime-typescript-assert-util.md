## Assertion and utility TypeScript contracts

Class **Host feature**. `src/js/assert_util_types.d.ts`, the process declarations added to `src/js/runtime.d.ts`, `scripts/runtime-assert-util.test.ts`, `scripts/runtime-util-equivalence.ts`, `scripts/runtime-util-controls.ts`, `docs/runtime-util-raw-operations.json`, and `tests/fixtures/runtime-ts-assert-util/index.ts` are original adapters and tests. They model the existing assertion and utility contracts without copying upstream types or tests. The adapted implementations remain separately classified under [Node assertions](node-assertions.md) and [Node utility fragments](node-utility-fragments.md). Their Bun comparison pin is `9510e74152073d850a18758ca41114d8f214ffa6`. The Node comparison revision is v22.20.0, `caa20e28dc1f21a97f7b2a7134973fd6435b65f0`; the historical direct import revision remains unrecorded.

The tests pin the approved JavaScript AST with only the two explicit utility destination extractions, check every emitted token against its TypeScript line and column, and require consumers to narrow raw parser outputs. Node controls preserve raw nonstring values, getter counts, receivers, original errors and both extraction orders. The test-only error-capture helper keeps those controls within three block levels, with a mutation rejecting the former depth-four capture.

The integrated declarations merge Node inspection methods into the existing `ConsoleInspector`, so console, stack and Node methods are available in either declaration order. The mutable global process retains main's required writable stdout and stderr contracts alongside the utility fields. `Error.captureStackTrace` remains required. These are type-only shared-contract reconciliations, not new runtime adapters.

Historical native Bun and three-engine fixture results do not qualify corrected emitted bytes. Normal CI must build and test the integrated source. The retained corrected util emission is 66,311 bytes, 1,570 more than the historical emission; this is not a measured final Wasm delta. Erased parentheses and padding can change the source-expression excerpt in native Bun errors. Null changes from `TypeError: null is not an object (evaluating 'arg.length')` to `TypeError: null is not an object (evaluating '(arg                       ).length')`; undefined has the corresponding difference. No identical-error-text or corrected guest-result claim is made.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `assert_util_types.d.ts`, process declarations in `runtime.d.ts` | Host feature | Original strict TypeScript contracts, with shared inspector and writable-process reconciliation. |
| `scripts/runtime-assert-util.test.ts`, `runtime-util-equivalence.ts`, `runtime-util-controls.ts` | Host feature | Original AST, source-position, boundary and operation-order checks. |
| `docs/runtime-util-raw-operations.json` | Host feature | Original 47-operation assertion manifest, including the two retained boundaries. |
| `tests/fixtures/runtime-ts-assert-util/`, `checks/runtime-runtime-assert-util.json`, `checks/native-runtime-ts-assert-util.json` | Host feature | Original assertion/utility fixture and feature-owned blocking test registration. |
| `scripts/quality-probes.test.ts`, `.jscpd-baseline.json` | Host feature | Preserve the existing clone's typed fingerprint migration and reject another typed adapter copy. |

[Ledger scope and pinned revisions](scope.md).
