# Node TLS client adapter

Classification: original adapter.

The Node API contract follows Bun `src/js/node/tls.ts` at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`. This implementation does not copy Bun's
native socket or context cache. The separate identity adapter owns certificate
name matching. The native guest TLS driver owns the TLS protocol and cryptography.

## Local files

- `node_tls.ts` validates client options, keeps private immutable context snapshots,
  and exposes `TLSSocket` over the existing Node stream implementation. It passes
  native chain results to the identity unit's `verifyIdentity` discriminated
  request. A failed-chain request contains no callback. The client preserves the
  returned authorized, unauthorized, or rejected decision and checks its lifetime
  before accepting it natively.
- `tls_transport.ts` reserves a raw socket synchronously, invalidates its old read
  generation, waits for callback unwind and the plaintext write fence, and moves
  unread binary input without more plaintext events.
- `tls_connection.ts` drives the six plain-data native operations. It bounds each
  pump, retains one active stream write, and completes writes and shutdown only
  after their cumulative ciphertext fences pass raw transport acknowledgements.
- `tls_types.d.ts` describes the adapter's native, stream, and ownership contracts.
- The existing `node_net.js`, `net.js`, and `builtins.js` contain factory and
  ownership glue. Their host-fetch dispatch remains unchanged.

The raw handle has an unreferenced cancellation participant for its whole
lifetime. Reservation changes that participant's delegate before any TLS
allocation. Destruction advances the ownership epoch, removes waiters, releases
the native session, and closes the raw handle once. A scheduled old-stream
`read(0)` becomes an inert readiness poll after transfer. Other old-shell I/O
fails with `ERR_TLS_SOCKET_OWNERSHIP`.

## Explicit limits

Only client TLS over a bun-wasm TCP socket is implemented. Server APIs, arbitrary
Duplex wrapping, Unix sockets, session APIs, cipher-list overrides, and other
unsupported options throw explicit TLS errors. An explicit private-key passphrase
uses the existing Node crypto key decoder before native context creation.

The current six-operation native contract has no root-list operation. Reading
`rootCertificates` throws `ERR_TLS_NOT_SUPPORTED` rather than returning an empty
or invented trust store. The getter is nonenumerable so the current ESM builtin
snapshot can expose the client without reading unavailable root data. A named
root-list export remains part of that handoff. Native registration, extra-CA startup capture, the lazy
root-list handoff, process-supervisor cleanup, and actual guest interoperability
remain integration requirements.

The source adapter tests run the checked-in stream, net, ownership, and TLS code
with controlled plain-data native responses and raw credit. They prove adapter
ordering, buffering, reentrancy, and cleanup. They do not prove a TLS handshake,
browser behavior, PostgreSQL STARTTLS, or certificate validation.
