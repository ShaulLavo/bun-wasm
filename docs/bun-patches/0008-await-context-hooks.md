### 0008 await context hooks

File `0008-wasm-optional-await-hooks-in-the-printer-for-a-host-.patch`. Class **Host feature**. Upstream path `src/js_printer/lib.rs` at Bun `9510e74152073d850a18758ca41114d8f214ffa6`.

`src/js_printer/lib.rs` adds `BUNWASM_AWAIT_HOOKS`, off by default, and `BUNWASM_HOOKS_VERSION` (3). When on, the printer emits the async-context hooks described in [docs/engine-browser.md](../engine-browser.md#promise-state-and-asynclocalstorage):

- Every `await x` in an async body without its own `try` or `for await` prints as `__bunwasm_resume(__bunwasm_capture(), await x)`.
- An async body whose own statements (nested functions excluded) hold a `try` or a `for await` is an S body; so is a module top level that awaits and has one. It declares `let __bunwasm_s = 0;` after its directive prologue. Its awaits print as `__bunwasm_resumed(await __bunwasm_id(x, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0)`, and every `catch` and `finally` block starts with `__bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);`.
- An async generator's `yield x` in an S body prints as `__bunwasm_id(yield __bunwasm_id(x, __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0)`. A bare `yield` is unchanged.
- `for await` prints as `{ let __bunwasm_c; try { for await (… of __bunwasm_c = __bunwasm_iterate(y)) { try { __bunwasm_entered(__bunwasm_c); body } finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } } } finally { __bunwasm_exited(__bunwasm_c); } }`. The runtime's iterator record notes the frame only once `next()`/`return()` returned (for a sync iterable, also when they throw and when closing finds no `return`, since the engine's adapter awaits then too), and the outer `finally` runs after the iterator closed on every exit. Only the outermost label of a labeled loop opens the block, so labeled `continue` still targets the loop.
- Every function body, class static block and arrow enters its own state, so a nested function never reads an outer `__bunwasm_s`.

Revision 3 (2026-10-29, PR 359 review) replaced the revision-2 `for await` shape, which marked a suspension pending before iterator acquisition, `next()` and `return()` (so a synchronous throw restored an old frame) and reset it only after the loop (so a labeled exit left a stale frame). Revision 2 (2026-10-29, CTX-02a) replaced the first version, which printed only the `resume(capture(), await x)` form and `{ const __bunwasm_ctx = capture(); for await (…) { resume(ctx); … } resume(ctx); }`. With that shape a rejected `await` threw before `resume` ran, so `catch` and `finally` blocks ran in whatever frame the rejection job found, often another request's. The design and its probes are in the wave report `bun/ctx-design/DESIGN.md` §4.5.

Without it browser-engine `AsyncLocalStorage` loses its frame across suspension because that host lacks Bun's engine integration. This adds a host contract, not a repair to Bun's normal printer output.

The hook globals (`__bunwasm_capture`, `__bunwasm_resume`, `__bunwasm_resumed`, `__bunwasm_caught`, `__bunwasm_id`, `__bunwasm_iterate`, `__bunwasm_entered`, `__bunwasm_exited`), the `for await` iterator record (`forAwaitRecord`, an original implementation of `GetIterator`'s reads and calls) and the `%AsyncGeneratorPrototype%.throw` wrapper live in `web/src/engine-host.js`. They are original bun-wasm adapters, inert when the host supplies a native continuation (`EngineHostOptions.asyncContext`).

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0008](#0008-await-context-hooks) | Host feature | Add optional printer hooks to preserve browser async context across awaits, rejected awaits, async generators and `for await`. |
| `web/src/engine-host.js` `installContextHooks`, `forAwaitRecord` | Host feature | Original adapter: the hook globals, the `for await` iterator record and the async generator `throw` wrapper. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
