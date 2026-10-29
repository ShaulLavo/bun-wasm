# Hermes Promise async context

| Local source | Class | Upstream source and revision |
| --- | --- | --- |
| Promise hunks in `hermes/hermes-wasi.patch` | Host feature | facebook/hermes `lib/InternalJavaScript/01-Promise.js`, `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065` |
| Context capture and dispatch split | Adapted implementation | Approved prototype `/work/reports/wave-20261029/engines/hermes/prototype/hermes-async-context.patch` |
| Private `_T` hook | Original adapter | Same upstream Promise `handle` and `Handler` implementation |

Each Promise reaction captures the current embedder async context when registered. Queued reactions dispatch without recapturing the resolver's context. The reaction job temporarily installs the captured context and restores the prior context in `finally`. Async functions use the same internal registration path, so `await` follows the same rule.

Private hooks `_G` and `_S` get and set context. `_T(promise, onFulfilled, onRejected)` uses the internal `handle` operation and creates a core Promise without reading the input's public `then`, `constructor`, or species. The engine adapter captures and deletes these hooks before user code. No JS is called by GC or by interrupt polling.
