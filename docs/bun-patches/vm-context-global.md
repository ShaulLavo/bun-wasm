## VM context global binding

Class **Host feature**, an **original adapter** in
`crates/bunwasm-runtime/src/js/builtins.js`. The behavioral comparison is Node
26.12.1's public `node:vm` contract; no upstream implementation is copied.

`vmModule.runWith` gives an extensible context a non-enumerable `globalThis`
binding to itself when neither the context nor its prototype chain supplies one.
This keeps context-global writes on the supplied object and preserves the binding
across reuse. Existing caller data and accessor descriptors remain authoritative.
A frozen or otherwise non-extensible context without a binding keeps the existing
fallback behavior rather than being mutated or causing setup to fail.

The adapter is still not a separate realm or security sandbox. Other unresolved
names and top-level `this` fall back to the host global, and non-extensible
contexts cannot gain the new own binding. `scripts/vm-context.test.ts` covers
these boundaries and the outer-global pollution regression.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/builtins.js`, VM context global binding](#vm-context-global-binding) | Host feature | Bind eligible contexts to their own global writes without replacing caller descriptors. Original adapter. |

[Ledger scope and pinned revisions](scope.md).
