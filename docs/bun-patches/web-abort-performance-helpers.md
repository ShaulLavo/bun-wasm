## Web `AbortSignal.any` error code and `performance` resource timing methods

Class **Host feature**, **original adapter** in `crates/bunwasm-runtime/src/js/web.js`. No upstream implementation is copied. Reference behavior: WHATWG DOM `AbortSignal.any` (Node/Bun `ERR_INVALID_ARG_TYPE` code) and Bun's `JSPerformance.cpp` / `Performance.cpp` at revision `9510e74152073d850a18758ca41114d8f214ffa6` (`test/js/web/abort/abort.test.ts` and `test/js/web/timers/performance.test.js`).

- `AbortSignal.any(signals)` attaches `code: "ERR_INVALID_ARG_TYPE"` to the `TypeError` thrown when an element is not an `AbortSignal`.
- `performance.clearResourceTimings()` validates its `Performance` receiver (`ERR_INVALID_THIS`) and removes recorded `"resource"` entries.
- `performance.setResourceTimingBufferSize(maxSize)` validates its `Performance` receiver (`ERR_INVALID_THIS`), requires at least one argument (`ERR_MISSING_ARGS`), converts `maxSize` via Web IDL `unsigned long` (`>>> 0`), and leaves the resize as a no-op matching Bun's `Performance::setResourceTimingBufferSize`.

## Classification

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/web.js` (`AbortSignal.any`, `performance`) | Host feature | Original `ERR_INVALID_ARG_TYPE` tagging and `Performance` resource timing receiver/argument validation. |

[Ledger scope and pinned revisions](scope.md).
