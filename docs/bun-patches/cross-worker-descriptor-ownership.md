## Cross-worker descriptor ownership

`waffle/proc/{worker-client,worker-broker,filesystem-codec}.ts` and
`waffle/core/open-file.ts` are original bun-wasm adapters, not copied Bun, Node or WASI host
implementations. They extend the descriptor and filesystem services present at bun-wasm
`52576274` with cloneable process bindings and shared file-description state. The browser
worker installs those bindings into the same table used by preview1 calls.

A spawn reserves independent filesystem capabilities before returning; closing or killing the
parent cannot invalidate an admitted child's open file. Duplicate child bindings share one
open description, including a shared file cursor. Cursor operations participate in filesystem
host sections so revocation and reaping cannot strand a lock. Stream descriptions may create
a fresh process-owned endpoint during inheritance, and termination freezes all capabilities
before making the child waitable. No upstream patch is added by these adapters.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Cross-worker descriptor ownership](#cross-worker-descriptor-ownership) | Host feature | Original process and filesystem adapters transfer open descriptions, preserve shared file offsets and revoke process-owned endpoints before publishing exit. |

[Ledger scope and pinned revisions](scope.md).
