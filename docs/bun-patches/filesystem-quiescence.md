## Filesystem quiescence

Class **Host feature**, **original adapters** in `waffle/fs/{protocol,client,shared,service,index}.ts`.
No Bun, Node, WebKit or other upstream implementation is copied; there is no upstream source
path or revision for this host-only protocol.

Each connection owns a shared count of synchronous host sections. Admission increments before
checking revocation and precedes any direct lock acquisition, capability-reference mutation or
page write. Nested operations keep the count nonzero until the outer operation releases its
locks. `waitForFilesystemQuiescence(identity)` revokes first, then observes or asynchronously
waits for zero, proving no future entrant can touch storage even if the worker remains alive.
The service uses this admission proof before releasing pins, rather than sampling lock owners,
which misses an operation between admission and acquisition. Controllers can then reap and stop
the worker without stranding a lock or allowing a write into reclaimed pages. An independently
proven-dead reap also settles pending waiters without resetting the count or losing a wakeup.

No section spans an await or guest Wasm call. Direct reads, writes and appends retain their
existing locks and zero-intermediate-copy paths, with one additional outer admission increment,
revocation check, decrement and final-exit notification. Regression tests cover revocation
between admission and its check, nested metadata operations, service pin retention, and a live
worker paused inside a locked write followed by a rejected late write.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`waffle/fs/`, filesystem quiescence](#filesystem-quiescence) | Host feature | Original shared admission and revocation fence lets controllers stop workers only after direct filesystem operations finish. |

[Ledger scope and pinned revisions](scope.md).
