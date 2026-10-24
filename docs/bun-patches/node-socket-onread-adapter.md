## Node Socket read callback adapter

`crates/bunwasm-runtime/src/js/node_net_onread.ts`,
`node_net_socket_state.ts`, and their wiring in `node_net.js` and `net.js`
are original **Host feature** adapters. The comparison source is Bun
`src/js/node/net.ts`, `Socket` and its read callback delivery, at
`d71508d31edf06765c12adf0df137ef531539f68`, the patched checkout based on
Bun pin `9510e74152073d850a18758ca41114d8f214ffa6`. No upstream code is copied.

Socket snapshots `onread` and `signal` separately from Duplex options and rejects
truthy object-mode options. Socket owns constructor and connect abort listeners.
The helper accepts genuine Uint8Array buffers across realms, rejects forged
prototypes, and retains the previous buffer when a factory returns an invalid
value. The callback and subsequent allocation share an exception boundary.
A callback exception skips allocation and reaches the existing uncaught handler.
Initial allocation exceptions remain synchronous. Empty buffers report ENOBUFS.

The existing connection adapter passes the current callback buffer capacity to
the already capacity-aware host read. A callback returning false stops handle
reads without emitting a stream pause event. `read` and `resume` restart reads.
Reconnect clears the callback stop flag while retaining the stream pause state,
and retires the old connection. The connection factory forwards constructor
options. Callback delivery keeps byte counters and bypasses stream data events.
The generic watermark default is unchanged here; directional defaults belong to
the separate Socket watermark change.

New option/helper tests run the checked-in Socket and stream implementation with
transport and lifecycle operations forbidden. The retained synthetic-pipe web
suite and `net-onread` guest fixture cover the original integration behavior.
Pure tests do not establish host, guest, EOF, reconnect, or abort/close acceptance.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Node Socket read callback adapter](#node-socket-read-callback-adapter) | Host feature | Original TypeScript option and callback helpers plus capacity, stop/restart, reconnect and signal wiring in existing JS factories. |

The JS changes are minimal wiring into the existing JS Socket and Connection
classes. A conversion of those classes is outside this change. New validation,
allocation and exception logic is TypeScript.

[Ledger scope and pinned revisions](scope.md).
