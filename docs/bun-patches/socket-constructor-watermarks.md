## Socket constructor watermarks

`crates/bunwasm-runtime/src/js/node_net_socket_options.ts` is an original
**Host feature** adapter. It extracts PR118's separate readable and writable
constructor defaults without its onread, connect, signal or transport changes.
The comparison source is Bun `src/js/node/net.ts`, Socket construction, at
`d71508d31edf06765c12adf0df137ef531539f68`, based on pinned upstream
`9510e74152073d850a18758ca41114d8f214ffa6`. No upstream code is copied.

The old generic default masked explicit `readableHighWaterMark` and
`writableHighWaterMark`. The helper supplies separate 65536-byte defaults so
Duplex can honor each direction. An explicit generic `highWaterMark` still wins
according to the existing stream implementation. Options are copied rather than
mutated. Existing stream validation remains responsible for invalid limits.

The only forced existing-JavaScript glue is the constructor's `super` argument
in `node_net.js`. All new option logic is TypeScript; the socket module is not
migrated. Server constructor and hostname adapters are unchanged.

`web/tests/node-net-socket-options.test.ts` evaluates the production Socket and
checked-in stream core with throwing transport, timer and lifecycle dependencies.
It only constructs inert objects. No listen, connect, read, write, callback
sequence, resolver, guest, browser or native socket acceptance is claimed.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Socket constructor watermarks](#socket-constructor-watermarks) | Host feature | Original TypeScript constructor option defaults and one JavaScript call-site replacement. |

[Ledger scope and pinned revisions](scope.md).
