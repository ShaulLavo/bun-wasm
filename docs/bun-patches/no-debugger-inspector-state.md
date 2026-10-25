## No-debugger inspector state

Class **Host feature**. `crates/bunwasm-runtime/src/js/builtins.js` keeps the existing
`node:inspector` unsupported boundary while matching the public no-debugger state query
used by Next 16. No upstream implementation is copied; the behavior is compared with the
installed Node 26.12.1 and Bun 1.4.4 local APIs on October 25, 2026.

With no debugger attached, `inspector.url()` returns `undefined` and `inspector.close()`
returns `undefined` without creating a server. `inspector.open()`,
`inspector.waitForDebugger()`, and `new inspector.Session()` remain
`ERR_NOT_SUPPORTED_IN_WASM`. The adapter does not invent a debugger URL, active session,
transport, server, or OS capability. Any future debugger boundary belongs to Waffle.
The feature-specific blocker record is
[`docs/app-matrix/next-16-inspector-url.md`](../app-matrix/next-16-inspector-url.md),
and the focused fixture is `tests/fixtures/node-inspector-state/`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/builtins.js`, `node:inspector`](#no-debugger-inspector-state) | Host feature | Return truthful inactive inspector state without adding debugger transport; keep open, wait, and session operations unsupported. |

[Ledger scope and pinned revisions](scope.md).
