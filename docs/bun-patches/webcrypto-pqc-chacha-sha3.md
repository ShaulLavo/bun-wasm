# WebCrypto ChaCha20-Poly1305, ML-KEM, ML-DSA and SHA-3; Node randomFill bounds

Class: Adapted implementation (argument checks and messages), Original adapter (native bindings).

Native Bun implements these in C++ over BoringSSL. The adapters follow Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/jsc/bindings/webcrypto/SubtleCrypto.cpp` for the four KEM methods
  (`encapsulateBits` results sharedKey first, `encapsulateKey` results ciphertext first,
  "encapsulationKey does not have encapsulateBits usage"), `getPublicKey` for AKP keys,
  and the KEM usages in the KeyUsage order.
- The ChaCha20-Poly1305 algorithm: `raw-secret` and JWK (`C20P`) but not `raw`, a
  256-bit key ("Invalid key length"), a 12-byte IV ("algorithm.iv must contain exactly
  12 bytes"), a 128-bit tag, the `AeadParams.iv` required-member error, and usage
  messages.
- The ML-DSA and ML-KEM algorithms: SPKI and PKCS#8 with the parameter set's OID and no
  parameters, PKCS#8 holding only the seed (`[0]` IMPLICIT OCTET STRING), `raw-public`,
  `raw-seed`, AKP JWK (`kty`, `use`, `key_ops`, `ext`, `alg`, `pub`, `priv`, checked in
  Node's order), the optional ML-DSA `context` (at most 255 bytes, for sign and verify),
  a public key parsed by BoringSSL at import (so an ML-KEM key with unreduced
  coefficients is refused), and each import, export and usage message ("Unable to export
  ML-DSA-44 private key using raw-public format", "JWK \"alg\" Parameter and algorithm
  name mismatch", and so on). ML-KEM-512 is not supported, as in Bun.
- SHA3-256, SHA3-384 and SHA3-512 in digest, HMAC (whose default length is the hash's
  block size), RSA, ECDSA, PBKDF2, HKDF and node:crypto's `hkdf`, with no JWK `alg`
  because JOSE defines none.
- CryptoKey structured cloning: a clone is a key over the same material.
- Node's `lib/internal/crypto/random.js` (through Bun's `src/js/node/crypto.ts`) for
  `randomFill` and `randomFillSync`: offset and size in elements of the typed array,
  then the `ERR_OUT_OF_RANGE` bounds; `crypto.hkdf` with a keylen of 0 failing with a
  plain "HKDF derivation failed"; `checkPrime` copying the candidate before it reads the
  options; and `getRandomValues` refusing `Float16Array`.
- Bun's `src/js/node/crypto.ts` and ncrypto's `VerifySpkac`, `ExportPublicKey` and
  `ExportChallenge` for `crypto.Certificate`: the `spkac` argument check, trailing
  whitespace ignored, `false` or `""` for input that does not decode, the public key as
  a PEM string and the challenge as a Buffer. `crates/bunwasm-crypto-sys/c/spkac.c` is
  the original C adapter over BoringSSL's `NETSCAPE_SPKI` functions.
- Node's key and signing validators as Bun reports them: `KeyObject.export` requires an
  options object (a secret key may omit it) and a format; `crypto.verify` takes the
  signature only as a view, checked before the key; `padding` and `saltLength` must be
  int32 (`ERR_INVALID_ARG_VALUE`); `generateKeySync` takes AES lengths 128, 192 and 256
  and HMAC lengths 8 to 2^31 - 1 with Node's messages; BoringSSL's `DECODE_ERROR`s for an
  unreadable DER PKCS#1 or PKCS#8 private key; and `crypto.Hash` and `crypto.Hmac` as
  `util.deprecate` wrappers (DEP0179, DEP0181). The `node-crypto-keys` fixture's
  expectation that `hkdfSync` with a keylen of 0 returns an empty buffer is updated to
  Bun's error.

`crates/bunwasm-crypto-sys/c/pqc.c` is an original C adapter over BoringSSL's
`mlkem.h`, `mldsa.h` and `aead.h`. BoringSSL's ML-KEM and ML-DSA private key structures
are large and opaque, so the adapter heap-allocates them, keeps them for one call, and
clears them before freeing; keys cross into Rust as the seed and the encoded public key.
`crates/bunwasm-runtime/src/crypto_pqc.rs` builds the SPKI, PKCS#8 and AKP JWK encodings
with the RustCrypto `spki` and `pkcs8` parsers already in use. SHA-3 uses the `sha3`
crate already linked for node:crypto, and the RSA adapter maps SHA-3 to BoringSSL's
`EVP_sha3_*`. No new crates.

Differences from native Bun, all deliberate:

- PKCS#8 import of ML-DSA and ML-KEM takes the seed form Bun exports; the expanded-key
  and "both" forms report "Invalid keyData".
- Keys do not cross to a Worker through `postMessage`: each worker has its own key
  records. Same-thread `structuredClone` works.

The `webcrypto-chacha20-poly1305` (RFC 8439 section 2.8.2 vector), `webcrypto-ml-kem-ml-dsa`
(fixed seeds), `webcrypto-sha3` (FIPS 202 vectors), `node-crypto-random-fill` and `node-crypto-spkac`
fixtures are original test code with native Bun 1.4.4's output. The SPKACs come from
`openssl spkac` with a synthetic key.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto.js`, `structured_clone.ts`, `builtins.js`, `crypto_keys.ts`, `node_dh.ts`, `web.js`](#webcrypto-chacha20-poly1305-ml-kem-ml-dsa-and-sha-3-node-randomfill-bounds) | Adapted implementation | Bun's WebCrypto algorithm checks and messages, CryptoKey cloning and Node's randomFill bounds in the runtime adapters. |
| [`crates/bunwasm-crypto-sys/c/pqc.c`, `c/spkac.c`, `src/pqc.rs`, `crates/bunwasm-runtime/src/crypto_pqc.rs`](#webcrypto-chacha20-poly1305-ml-kem-ml-dsa-and-sha-3-node-randomfill-bounds) | Original adapter | BoringSSL ML-KEM, ML-DSA and ChaCha20-Poly1305 bindings and their key encodings. |

[Ledger scope and pinned revisions](scope.md).
