## Process-owned pipe adapters

`waffle/proc/pipes.ts` adapts the bounded ring wrap/copy and notification scheme from this
project's `web/src/subprocess.ts` (`SharedPipe`, bun-wasm revision `52576274`). That source is an
original bun-wasm host adapter, not a copied upstream implementation. The process-owned layer
adds independent producer rings, atomic committed-position/revocation cursors, a host-only
process publication registry, reference-counted endpoints, reader merging and supervisor relay.
These changes prevent a terminated worker's delayed publication from altering the live stream.
EOF also validates the pipe's atomic admission generation around its monotonic closed-ring scan:
a concurrent child reservation in an earlier slot cannot be missed while the parent closes a
later slot. An overlapping scan reports not-EOF and publishes a wake, keeping registry revocation
as the authority for freezing committed output rather than adding a second writer-lifetime count.

`waffle/proc/worker-pipes.ts` is a separate original adapter for cloneable endpoint capabilities,
filesystem-codec composition and supervisor relay ownership. Spawn retains a process endpoint
synchronously; worker and controller imports release that same lifetime idempotently. Stable pipe
identities survive structured cloning without using SharedArrayBuffer wrapper identity. No Bun,
Node, WebKit or third-party pipe implementation is copied or patched by these modules.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Process-owned pipe adapters](#process-owned-pipe-adapters) | Host feature | SharedPipe-derived ring copying with original per-process publication, admission-validated EOF, reader relay and descriptor-transfer adapters. |

[Ledger scope and pinned revisions](scope.md).
