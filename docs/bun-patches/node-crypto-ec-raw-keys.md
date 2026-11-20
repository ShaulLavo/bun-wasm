# NIST-curve keys over BoringSSL, raw KeyObject formats and signing names

Class: Adapted implementation (argument checks and messages), Original adapter (native bindings).

Native Bun handles P-256, P-384 and P-521 keys in C++ over BoringSSL. The adapters follow
Bun at revision `9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/jsc/bindings/webcrypto/CryptoKeyECOpenSSL.cpp` for importing and exporting EC keys:
  JWK coordinates and scalars as big integers (so a JWK `d` shorter than the field
  imports, and exports padded), `EC_KEY_check_key` on every import, raw points through
  `EC_POINT_oct2point`, PKCS#8 through `d2i_PKCS8_PRIV_KEY_INFO`, SPKI through
  `d2i_PUBKEY`, trailing bytes rejected, and padded JWK exports.
- `CryptoAlgorithmECDSAOpenSSL.cpp` for ECDSA over a precomputed digest with
  `ECDSA_do_sign` and `ECDSA_do_verify`, including the false result for an r || s
  signature of the wrong size.
- `src/jsc/bindings/node/crypto/KeyObject.cpp` (`exportRaw`,
  `getKeyObjectHandleFromRaw`, the raw branch of `prepareAsymmetricKey`) and
  `CryptoUtil.cpp` (`parseKeyFormatAndType`) for the `raw-public`, `raw-private` and
  `raw-seed` formats: compressed points, the scalar length check, the order of the
  format, buffer, key type and curve checks, and each error code and message.
- `src/jsc/bindings/node/crypto/JSHash.cpp` and `JSHmac.cpp` for the Hash and Hmac
  states: a stream's `_flush` caches a Hash digest without finalizing it, a later
  non-empty `update()` fails with `ERR_CRYPTO_HASH_UPDATE_FAILED`, and an Hmac answers
  an empty digest once finalized.
- Node's `lib/internal/crypto/random.js` (through Bun's `src/js/node/crypto.ts`) for
  `randomInt`'s checks and its rejection sampling over 48-bit draws.

`crates/bunwasm-runtime/src/crypto_ec.rs` is the original Rust adapter over those
BoringSSL calls, declared in `crates/bunwasm-crypto-sys/src/ec.rs`. It replaces the
RustCrypto `p256` and `p384` crates, which are no longer dependencies, so the three
curves share one implementation and one set of behaviors with Bun. Keys still travel
between JavaScript and Rust as JWK. `crates/bunwasm-crypto-sys/c/rsa.c` adds MD5 to the
RSA signature digests, for Node's `RSA-MD5` and `md5WithRSAEncryption`.

On the JavaScript side, `crypto_keys.ts` accepts OpenSSL's signature aliases
(`RSA-SHA256`, `sha256WithRSAEncryption`) and MD5 for signing, the P-521 curve names,
and the raw formats; `crypto.js` adds P-521's `ES512` JWK algorithm and its 528-bit
ECDH length, and `SubtleCrypto.getPublicKey`; `node_dh.ts` adds P-521 to
`crypto.diffieHellman`. `crypto.sign` and `crypto.verify` reject the `context` option
with Bun's message, since only Ed448 takes one and BoringSSL has no Ed448.

Differences from native Bun, all deliberate:

- Ed448 and X448 raw imports report "Invalid key data": BoringSSL has no Ed448 or X448
  KeyObjects here, while native Bun's ncrypto reaches its own failure later.
- ML-DSA and ML-KEM KeyObjects do not exist here, so their raw formats report
  "Unsupported key type".

The `node-crypto-p521`, `node-crypto-raw-keys` and `node-crypto-sign-digests` fixtures are
original test code with native Bun 1.4.4's output. Their keys are synthetic test keys
generated for the fixtures.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts`, `crypto.js`, `builtins.js`, `node_dh.ts`, `x509.ts`](#nist-curve-keys-over-boringssl-raw-keyobject-formats-and-signing-names) | Adapted implementation | Bun's raw-format, curve, digest-name, Hash state and randomInt checks in the runtime adapters. |
| [`crates/bunwasm-runtime/src/crypto_ec.rs`, `crates/bunwasm-crypto-sys/src/ec.rs`, `c/rsa.c`](#nist-curve-keys-over-boringssl-raw-keyobject-formats-and-signing-names) | Original adapter | BoringSSL EC key, ECDSA and ECDH bindings; MD5 RSA signatures. |

[Ledger scope and pinned revisions](scope.md).
