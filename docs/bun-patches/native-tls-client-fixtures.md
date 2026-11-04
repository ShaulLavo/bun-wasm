# Native TLS client fixture source

Classification: local test fixture and source contract. This record does not adapt an upstream implementation and does not add runtime behavior.

## Scope

- `tests/servers/tls-fixtures.ts` owns lazy native TLS 1.2, TLS 1.3, ALPN, mTLS, observer, and STARTTLS servers.
- `tests/fixtures/tls-client/index.ts` is the executable guest fixture. It uses `node:tls` and `node:net`, obtains all ports and ephemeral test material through `TEST_SERVER`, and prints fixed output.
- `scripts/tls-fixtures-source.test.ts` checks route ownership, lazy creation, cleanup wiring, deterministic output, and guest source wiring without starting a native server.

## Ownership and limits

The HTTP fixture server registers this module at `/tls-fixtures`. The module creates its certificate scratch directory only when that route is used, uses the inherited `TMPDIR` when provided, keeps private keys in task-owned scratch, returns ephemeral material only over the loopback control route, and closes sockets, listeners, scratch files, and signal handlers through the explicit close route or process signals. The observer is armed by a real native TLS control connection before zero-byte negative results are considered meaningful.

This source record does not claim a three-engine run, native registration, guest artifact admission, TLS interoperability, browser execution, or PostgreSQL STARTTLS qualification. Those gates remain separate from the source-only checks.
