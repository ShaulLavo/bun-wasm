## Node Socket read callback adapter

`crates/bunwasm-runtime/src/js/node_net_onread.ts`,
`node_net_socket_state.ts`, and their wiring in `node_net.js` and `net.js`
are original **Host feature** adapters. The comparison source is Bun
`src/js/node/net.ts`, `Socket` and its read callback delivery, at
`d71508d31edf06765c12adf0df137ef531539f68`, the patched checkout based on
Bun pin `9510e74152073d850a18758ca41114d8f214ffa6`. No upstream code is copied.

Socket snapshots `onread` and `signal` separately from Duplex options and rejects
truthy object-mode options, including inherited and non-enumerable values. Validation
reuses copied own-enumerable values and reads only uncopied mode fields from the
original options, so it never rereads an already observed caller getter.
Socket owns constructor and connect abort listeners.
The helper accepts genuine Uint8Array buffers across realms, rejects forged
prototypes, and retains the previous buffer when a factory returns an invalid
value. The callback and subsequent allocation share an exception boundary.
A callback exception skips allocation and reaches the existing uncaught handler.
The completed callback result lives outside that boundary, so a handled subsequent
allocation exception preserves a false result and the previous buffer.
Initial allocation exceptions remain synchronous. Empty buffers report ENOBUFS.

The existing connection adapter passes the current callback buffer capacity to
the already capacity-aware host read. A callback returning false stops handle
reads without emitting a stream pause event. `read` and `resume` restart reads.
Reconnect clears the callback stop flag while retaining the stream pause state,
and retires the old connection. The connection factory forwards constructor
options. Callback delivery keeps byte counters and bypasses stream data events.
Socket snapshots and validates its options before passing the remaining stream
options to the separate Socket watermark helper. That landed helper retains its
independent 65536-byte directional defaults, nullish restoration and generic-limit
precedence. The original caller's stream getters run once during the snapshot,
in source order and with the original receiver; defaulting reads only the copy.
`onread` and `signal` are read once before those stream getters and never reach
Duplex. The constructor-only composition test covers nullish and zero directions
with both Socket-owned getters present, without allocating a read buffer or
invoking transport or lifecycle operations.

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
