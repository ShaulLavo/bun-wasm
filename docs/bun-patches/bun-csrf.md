# Bun.CSRF

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/csrf.rs` `generate`, `verify`, `decode`, `trim`, default secret | Adapted upstream implementation | Bun `src/csrf/lib.rs` and `RareData::default_csrf_secret` (`src/jsc/rare_data.rs`) at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/js/bun_csrf.ts` option parsing and error messages | Adapted upstream implementation | Bun `src/runtime/api/csrf_jsc.rs` at the same revision |
| `natives.rs` `csrfGenerate`, `csrfVerify` | Original adapter | None |

The token layout, defaults and checks are Bun's: an 8-byte big-endian millisecond timestamp, a 16-byte random nonce and an 8-byte `expiresIn`, followed by the HMAC of those 32 bytes and the session id. Tokens default to base64url, SHA-256 and a 24-hour lifetime. As in Bun, the nonce comes from the native entropy source (`getrandom`), the timestamp from the native wall clock, and the signature comparison is constant-time (`subtle`), so code that replaces `crypto.getRandomValues` or `Date.now` cannot steer them. Without a secret both functions use one random 16-byte secret per process; if the entropy source fails while making it, both throw and nothing is cached, so no predictable secret is ever used.

Verification follows `lib.rs`: drop one trailing NUL; for hex, reject an odd length, more than 96 decoded bytes or anything but hex digits (no `+` sign); for base64 and base64url, trim `\r\n\t \x0b`, bound the decoded size with Bun's `decode_len` before decoding, and decode forgivingly (both alphabets, other characters skipped, stop at `=`, as Bun's fallback decoder does). A token shorter than 64 bytes, past its own `expiresIn` or the caller's `maxAge`, or with a signature of another length fails. The HMAC is the runtime's `node_digest::hmac`, not BoringSSL.

The JavaScript side reads options as `csrf_jsc.rs` does, from any object including a function with properties: encodings `base64`, `base64url` and `hex` in any case, algorithms `blake2b256`, `blake2b512`, `sha256`, `sha384`, `sha512` and `sha512-256` with BoringSSL's `sha-*` spellings, durations as integers from 0 to 2^53 - 1, and string secrets and session ids, with Bun's messages for each rejection.

`cargo test -p bunwasm-runtime csrf` covers the formats, tampering, NUL and whitespace handling and the default secret. `tests/fixtures/bun-probe-utils` compares replaced globals, every option rejection and the decoding cases with native Bun on every engine.
