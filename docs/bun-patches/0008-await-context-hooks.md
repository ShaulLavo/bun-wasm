### 0008 await context hooks

File `0008-wasm-optional-await-hooks-in-the-printer-for-a-host-.patch`. Class **Host feature**.

`src/js_printer/lib.rs` adds `BUNWASM_AWAIT_HOOKS`, off by default. It prints `await x` through `__bunwasm_capture` and `__bunwasm_resume`, and adds matching hooks around `for await` bodies and after loops. Labeled loops keep valid `continue` targets. The browser runtime enables this during its own transpiles, never for ordinary `bun build` output.

Without it browser-engine `AsyncLocalStorage` loses its frame across suspension because that host lacks Bun's engine integration. This adds a host contract, not a repair to Bun's normal printer output.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0008](#0008-await-context-hooks) | Host feature | Add optional printer hooks to preserve browser async context. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
