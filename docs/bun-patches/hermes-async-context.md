# Hermes Promise async context

| Local source | Class | Upstream source and revision |
| --- | --- | --- |
| Promise hunks in `hermes/hermes-wasi.patch` | Host feature | facebook/hermes `lib/InternalJavaScript/01-Promise.js`, `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065` |
| Context capture and dispatch split | Adapted implementation | Approved prototype `/work/reports/wave-20261029/engines/hermes/prototype/hermes-async-context.patch` |
| Private `_T` hook | Original adapter | Same upstream Promise `handle` and `Handler` implementation |
| Private `_I`, `_O`, `_F`, `_R` and `_V` hooks | Original adapter | Tracker installation and branded owned promises using the same Promise implementation |
| `OWNED` reaction and private tracker variables | Adapted implementation | Same upstream Promise reaction, adoption and rejection paths |
| `scripts/fixtures/hermes-promise/01-Promise.js.txt` | Upstream test input | Unchanged `lib/InternalJavaScript/01-Promise.js` at the same pin, SHA-256 `f93d6779a98ee2fa7845dfcd1f9037254e7fa2711cbfcc2bb0e120eeab2b84f2`. Its MIT license is retained beside it. |
| `scripts/hermes-promise-ownership.test.ts` | Original test adapter | Applies the Promise patch to that input and runs source controls with an explicit job queue and simulated tracker-entry refusal. No live Hermes stack-limit sweep is claimed. |

Each Promise reaction captures the current embedder async context when registered. Queued reactions dispatch without recapturing the resolver's context. The reaction job temporarily installs the captured context and restores the prior context in `finally`. Async functions use the same internal registration path, so `await` follows the same rule.

Private hooks `_G` and `_S` get and set context. `_T(promise, onFulfilled, onRejected)` uses the internal `handle` operation and creates a core Promise without reading the input's public `then`, `constructor`, or species. The engine adapter captures and deletes these hooks before user code. No JS is called by GC or by interrupt polling.

`_I` installs closure-private rejection and handler trackers. Owned promises begin with the closure-private `OWNED` reaction, which never schedules a job and transfers through ordinary Promise adoption. `_O` creates and brands one, `_F` attaches a reaction whose result is an owned promise, and `_R`/`_V` settle one through the guarded core operations. The record loader uses these for internal capabilities and its require bridge. Owned rejections never enter the tracker, while adopting an already rejected user promise removes its existing report. No promise-identity set survives in Rust.

Dispatch calls the handler tracker only for rejected targets with no registered handlers, which may have an existing rejection report. An owned sentinel or forwarding reaction therefore needs no tracker entry, so refusal of that native hook cannot interrupt owned settlement. Adoption still follows the settled target and removes a previously reported user rejection.
