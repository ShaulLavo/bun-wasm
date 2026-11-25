# Bun.CSRF

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bun_csrf.ts` `generate`, `verify` | Adapted upstream implementation | Bun `src/csrf/lib.rs` and `src/runtime/api/csrf_jsc.rs` at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |

The token layout, defaults and checks are Bun's: an 8-byte big-endian millisecond timestamp, a 16-byte random nonce and an 8-byte `expiresIn`, followed by the HMAC of those 32 bytes (plus the session id when one is given). Tokens default to base64url, SHA-256 and a 24-hour lifetime; `verify` rejects a token past its own `expiresIn` or the caller's `maxAge`, and compares signatures in constant time. Allowed algorithms are Bun's: `blake2b256`, `blake2b512`, `sha256`, `sha384`, `sha512` and `sha512-256`. Without a secret both functions use one random 16-byte secret per process, as Bun's `default_csrf_secret` does.

The port is TypeScript over the runtime's existing HMAC native (`nodeHmac`) instead of BoringSSL calls, because the token handling is a few byte copies. `tests/fixtures/bun-probe-utils` round-trips tokens with sessions, encodings and wrong secrets on every engine.
