# Guest TLS record driver

Classification: original adapter.

`crates/bunwasm-runtime/src/tls.rs` and `src/tls/` implement client TLS with
`oven-sh/boringssl` commit `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`.
No TLS protocol implementation is copied. The driver calls the pinned
`include/openssl/ssl.h`, `bio.h`, `x509.h`, `pem.h`, `evp.h`, `pool.h`, and
`mem.h` APIs. Existing X.509 certificate, key, stack, and BIO types remain
canonical in `bunwasm-crypto-sys`.

## Ownership and limits

Each installed native table captures one `Rc<RefCell<TlsRegistry>>`. The
registry holds no socket, JavaScript object, engine value, or process-global
connection map. It cannot call JavaScript or read files. Integration supplies
`StartupExtras` from a once-per-process guest snapshot before application code
runs. This source module is not registered by `lib.rs` or `natives.rs` yet.

Contexts are immutable. A connection retains its context after the caller
releases the context ID. Slot IDs contain a type tag, slot index, and checked
32-bit generation inside a JavaScript safe integer. There are at most 1,024
context slots and 4,096 connection slots. Exhausted generations never wrap.
Releasing a retired generation cannot release a reused slot. Retirement uses
only the bounded slot array.

The network BIO and SSL object have separate Rust owners. SSL takes the inside
BIO exactly once. Contexts retain their store and client identity. Partial
construction and explicit release use the same deterministic destructors.
Registry destruction releases abandoned sessions without a JavaScript finalizer.
The reported counters count owned native handles and their releases, including
the inside BIO transferred to SSL. BoringSSL's internal allocations are not a
heap measurement.

Each BIO direction holds 64 KiB. A step accepts at most 64 KiB ciphertext and
one 16 KiB plaintext write. The caller retains any unaccepted ciphertext tail.
There is no extra ingress queue. Ciphertext and plaintext output allowances are
independently capped at 64 KiB. A turn has at most 32 native operations and a
256 KiB processed-byte budget. Peer certificate lists are limited to 256 KiB,
verification depth is 16, and local certificate or key input is limited to 1 MiB.

## Driver contract

The six plain-data native operations are defined in `tls/bindings.rs`.

- `tlsCreateContext(options)` returns `{ id, warning }`. `warning` is a bounded
  message or `false`. Options are `minVersion`, `maxVersion`, `ca`, `cert`, and
  `key`. Versions are `TLSv1.2` or `TLSv1.3`. Certificate and key inputs are byte
  arrays. CA input is a byte array or an array of byte arrays. Omitted `ca`
  selects bundled roots plus the guest extra snapshot. An empty array trusts
  nothing. Client certificate and key must be supplied together and must match.
- `tlsCreateConnection(contextId, options)` returns a connection ID. Options
  are `servername`, wire-format `alpn` bytes, and `rejectUnauthorized`.
  Verification is required unless explicitly disabled for this connection.
  Empty or omitted server names suppress SNI. IP literals never become SNI.
  DNS SNI must already be ASCII after the JavaScript identity layer's IDNA step.
- `tlsStep(id, event, { plaintext, ciphertext })` drives `poll`, `ciphertext`,
  `plaintext`, `transport-eof`, or `shutdown-write`. Byte events include `data`.
  Results distinguish `progress`, `wait`, `verification-required`, `failed`, and
  `closed`. The wait reason is `ciphertext`, `output`, `read-allowance`,
  `identity`, or `poll`.
- `tlsAcceptIdentity(id, { accepted, code? })` resolves the one pending identity
  decision outside the native call. It cannot replace chain verification.
- `tlsInspect(id, "peer")` copies negotiated protocol, cipher, ALPN, verifier
  result, and peer DER bytes. `authorized` becomes true only after an accepted
  identity and a successful chain verification. Report-only mode retains the
  actual chain error and cannot affect another connection.
- `tlsRelease("context" | "connection", id)` releases one typed generation and
  returns release status, registry counts, and owned/freed native-handle counts.

`acceptedCiphertext` counts copies into the BIO. `consumedCiphertext` counts
bytes removed from that BIO by SSL, not application delivery. `acceptedPlaintext`
transfers one write into the driver's owned retry buffer. `committedPlaintext`
counts positive `SSL_write` results. `pendingPlaintext` reports the remaining
native write. A new write submitted while another operation is suspended may
accept zero bytes. The caller still owns that unaccepted write.

A suspended `SSL_write` keeps the same pointer and length. Only a positive
partial result advances to a new suffix. Reads and shutdown never replace that
pending operation. Error queues are cleared immediately before fallible calls,
and `SSL_get_error` runs before any other BoringSSL call after an SSL operation.
Failure diagnostics contain at most four numeric library codes and fixed
messages. They never contain keys, certificate dumps, or library error strings.

`ciphertextStart` and `ciphertextEnd` are cumulative output offsets. A
`writeCiphertextEnd` marks the raw-output fence for committed plaintext. The
JavaScript transport must wait for all raw write callbacks through that fence
before completing the corresponding stream write. It must not create an
unbounded raw write queue.

`shutdownCiphertextEnd` marks the close-notify fence. `writeClosed` means the
native alert has drained, not that the raw transport has acknowledged it.
The transport waits for that fence before its directional FIN. Inbound reads
remain available. Peer close-notify and raw EOF are distinct. EOF without
close-notify becomes a TLS truncation failure, or a handshake reset before the
handshake completes. Paused reads do not create a hidden plaintext queue.

A successful handshake stops at the identity barrier. No application read or
write runs there. The identity layer uses the copied certificate report and
returns one decision. The raw socket's original target, hostname policy,
callback execution, cancellation participants, transport closure, and raw
callback fences remain JavaScript integration responsibilities.

## Source checks and native tests

The test-only module declaration makes the existing workspace Cargo owner
compile and execute the native driver tests without exposing TLS to programs.
The normal host Clippy and WASI checks retain their existing owners and flags.
The earlier standalone metadata helper is removed now that Cargo discovers the
real module. Metadata alone was not native execution.

To run the focused native tests:

```sh
source env.sh
cargo test -p bunwasm-runtime --no-default-features --features engine-host --lib tls::
```

Tests own short-lived generated test keys in private scratch directories. They cover
trust replacement, guest extra snapshots, verifier dates, identity barriers,
client credentials, both WANT retry directions, bounded output, half-close,
truncation, typed retirement, and destruction counts. Native execution and
external-peer interoperability remain separate checks from metadata.
