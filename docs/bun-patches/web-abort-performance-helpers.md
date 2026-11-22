## Web `AbortSignal.any` error code and `performance` resource timing stubs

Class **Host feature**, **original adapter** in `crates/bunwasm-runtime/src/js/web.js`. No upstream implementation is copied. Reference behavior: WHATWG DOM `AbortSignal.any` (Node/Bun `ERR_INVALID_ARG_TYPE` code) and Resource Timing Level 2 (`performance.clearResourceTimings` and `performance.setResourceTimingBufferSize`, checked against Bun `test/js/web/abort/abort.test.ts` and `test/js/web/timers/performance.test.js` at Bun `9510e74152073d850a18758ca41114d8f214ffa6`).

- `AbortSignal.any(signals)` attaches `code: "ERR_INVALID_ARG_TYPE"` to the `TypeError` thrown when an element is not an `AbortSignal`.
- `performance` exposes `clearResourceTimings()` and `setResourceTimingBufferSize()` as no-op methods matching Bun's Performance API surface when no browser resource timing entries are recorded.

## Classification

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/web.js` (`AbortSignal.any`, `performance`) | Host feature | Original `ERR_INVALID_ARG_TYPE` tagging and resource timing method stubs. |

[Ledger scope and pinned revisions](scope.md).
