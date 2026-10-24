## Assertion and utility TypeScript contracts

Class **Host feature**. `src/js/assert_util_types.d.ts`, the process declarations added to `src/js/runtime.d.ts`, `scripts/runtime-assert-util.test.ts`, `scripts/runtime-util-equivalence.ts`, `scripts/runtime-util-controls.ts`, `docs/runtime-util-raw-operations.json`, and `tests/fixtures/runtime-ts-assert-util/index.ts` are original adapters and tests. They model the existing assertion and utility contracts without copying upstream types or tests. The adapted implementations remain separately classified under [Node assertions](node-assertions.md) and [Node utility fragments](node-utility-fragments.md). Their Bun comparison pin is `9510e74152073d850a18758ca41114d8f214ffa6`. The Node comparison revision is v22.20.0, `caa20e28dc1f21a97f7b2a7134973fd6435b65f0`; the historical direct import revision remains unrecorded.

The tests pin the approved JavaScript AST with only the two explicit utility destination extractions, check every emitted token against its TypeScript line and column, and require consumers to narrow raw parser outputs. Node controls preserve raw nonstring values, getter counts, receivers, original errors and both extraction orders. The test-only error-capture helper keeps those controls within three block levels, with a mutation rejecting the former depth-four capture.

`runtime.d.ts` owns the single callable `ConsoleInspector.nodeInspect` property and the complete `InspectFunction` and `InspectOptions` contracts. The callable retains optional `defaultOptions`, `colors` and `styles` properties. Console keeps its existing options domain, formatting and Bun inspection signatures; utility declarations add Node formatting without redeclaring the callable. This avoids a method/property collision when all declarations compose. The mutable global process retains main's required writable stdout and stderr contracts alongside the utility fields. Optional warning overloads admit main's Error call and utility string/kind/code calls. `Error.captureStackTrace` remains required. These are type-only shared-contract reconciliations, not new runtime adapters.

`crypto_host_types.d.ts` owns `Internal.crypto` and its readonly `CryptoHostBridge` contract. Utility types consume that declaration instead of redeclaring a mutable object with only `isKey`. The utility predicate still calls the same bridge method. The combined strict runtime type project checks both adapters together; no executable code changes.

`scripts/runtime-inspector-contracts.test.ts` uses the real strict TypeScript compiler and ambient dependencies to check minimal and full declaration orders, both inspector option domains, callable property reads and assignments, and invalid-call diagnostics. It also reconstructs the former method/property union and requires both actual TS2300 sites. Its feature-owned runtime manifest registers it once.

The duplicate baseline keeps the assert/util 21-line migration separate from the events/util 12-line migration exposed when both converted modules compose. The latter replaces only `33ad45a23a9c5c95:1` with `f35a9b37be0e8d3c:1`. Both describeReceived bodies equal the original JavaScript bodies byte-for-byte; the signatures add erased parameter types. No runtime source changes for this fingerprint correction. The baseline still contains 21 entries with count 1 each, and both copy-rejection probes remain unchanged.

Historical native Bun and three-engine fixture results do not qualify corrected emitted bytes. Normal CI must build and test the integrated source. The retained corrected util emission is 66,311 bytes, 1,570 more than the historical emission; this is not a measured final Wasm delta. Erased parentheses and padding can change the source-expression excerpt in native Bun errors. Null changes from `TypeError: null is not an object (evaluating 'arg.length')` to `TypeError: null is not an object (evaluating '(arg                       ).length')`; undefined has the corresponding difference. No identical-error-text or corrected guest-result claim is made.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `assert_util_types.d.ts`, shared inspector and process declarations in `runtime.d.ts`, inspector reconciliation in `console_types.d.ts` | Host feature | Original strict TypeScript contracts, one canonical inspection callable and writable-process reconciliation. |
| `scripts/runtime-inspector-contracts.test.ts`, `checks/runtime-inspector-contracts.json` | Host feature | Original strict compiler/order regressions and exactly-once runtime test registration. |
| `scripts/runtime-assert-util.test.ts`, `runtime-util-equivalence.ts`, `runtime-util-controls.ts` | Host feature | Original AST, source-position, boundary and operation-order checks. |
| `docs/runtime-util-raw-operations.json` | Host feature | Original 47-operation assertion manifest, including the two retained boundaries. |
| `tests/fixtures/runtime-ts-assert-util/`, `checks/runtime-runtime-assert-util.json`, `checks/native-runtime-ts-assert-util.json` | Host feature | Original assertion/utility fixture and feature-owned blocking test registration. |
| `scripts/quality-probes.test.ts`, `.jscpd-baseline.json` | Host feature | Preserve the separate assert/util and events/util typed fingerprint migrations without increasing clone counts; reject another typed adapter copy. |

[Ledger scope and pinned revisions](scope.md).
