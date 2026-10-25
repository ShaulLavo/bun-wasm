## Connect hostname validation

Class **Host feature**, **original adapter** in the connect validation hunks of
`crates/bunwasm-runtime/src/js/node_net.js` and `bun_tcp.js`.
No upstream implementation is copied. Public-contract references are Bun
`test/js/bun/net/socket-dns-error.test.ts`, `src/js/node/net.ts`,
`src/runtime/socket/socket_body.rs` and `src/uws_sys/socket.rs` at pinned base
`9510e74152073d850a18758ca41114d8f214ffa6`, patched tree
`d71508d31edf06765c12adf0df137ef531539f68`.

This carries the reviewed connect-only source from PR120 at
`daef0a1cd28d8ce055abb3cb1188014b666afda1`. The existing JavaScript adapters
must call the already-landed TypeScript hostname helper; these exact historical
integration lines remain JavaScript rather than converting unrelated adapters.
Truthy non-string node:net hosts throw synchronously. Falsy host values keep
the existing localhost default. Malformed names schedule socket destruction
through nextTick. Only Bun.connect opts into removing valid IPv6 brackets.
The landed listen/serve data work, Server constructors and host ABI are unchanged.

`scripts/net-connect-validation.test.ts` loads the checked-in connect adapters
and stream core with recorded host calls and manually drained callback queues.
It checks validation, normalization and deferred errors without opening a socket,
resolving a name or using a host timer. These are source integration controls,
not proof of native resolver, transport, lifecycle or guest behavior.

The unchanged `tests/fixtures/net-dns-errors` belongs to the native discovery
owner. Its manual marker preserves the pinned Bun 1.4.4 expectation rather than
claiming that reference Bun 1.4.2 generates it. Only the ordinary CI guest producer
can provide new native/guest acceptance. Historical receipts remain historical.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Connect hostname validation](#connect-hostname-validation) | Host feature | Original connect guards, hostname normalization and deferred validation errors. |

[Ledger scope and pinned revisions](scope.md).
