## Node Server constructor adapter

`crates/bunwasm-runtime/src/js/node_net_server.ts` and the constructor wiring in
`src/js/node_net.js` are original **Host feature** adapters. The comparison source
is Bun `src/js/node/net.ts`, `Server`, at
`d71508d31edf06765c12adf0df137ef531539f68`, the patched checkout based on the Bun
pin `9510e74152073d850a18758ca41114d8f214ffa6`. No upstream implementation is copied.

The TypeScript helper snapshots options, rejects primitive options and nonnumeric
keepalive delays, preserves raw `allowHalfOpen`, and normalizes boolean and delay
fields. An absent high-water mark calls the existing stream default getter at
construction time. Only truthy `blockList` values require `BlockList.isBlockList`;
a valid list is exposed by identity. The proxy preserves callable construction,
arity, prototype identity, subclasses and initialization of inherited receivers.
The receiver uses the existing connection set, not fabricated private Bun fields.

`web/tests/node-net-server.test.ts` uses synthetic objects and event delivery.
Transport, timer and lifecycle dependencies fail if invoked. It never calls
listen, connect, accept, close or an I/O pump. Listener startup, bind addresses,
IPv6, native sockets, guest execution and filtering behavior are unchanged and
not validated by these constructor checks.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Node Server constructor adapter](#node-server-constructor-adapter) | Host feature | Original TypeScript option snapshots, stream defaults, BlockList validation and callable receiver initialization; no listener changes. |

[Ledger scope and pinned revisions](scope.md).
