# node:crypto ciphers, Diffie-Hellman, ECDH and primes

Class: Adapted implementation (argument checks and messages), Original adapter (native bindings).

Native Bun implements these APIs in C++ over BoringSSL. The adapters follow Bun at
revision `9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/js/node/crypto.ts` for the `Cipheriv` and `Decipheriv` classes (LazyTransform
  streams over a native handle, `getDecoder`'s "Cannot change encoding"), the
  `DiffieHellmanGroup`, `getDiffieHellman` and `createECDH` exports, and the DEP0031
  wrapper on `ECDH.prototype.setPublicKey`.
- `src/jsc/bindings/node/crypto/JSCipherConstructor.cpp` and `JSCipherPrototype.cpp` for
  the cipher checks: IV length rules (GCM up to 128 bytes), GCM tag lengths 4, 8 and
  12 to 16, the order of the key, IV and tag checks, and each "Invalid state for
  operation" error.
- `JSDiffieHellmanConstructor.cpp`, `JSDiffieHellmanGroupConstructor.cpp` and
  `DiffieHellmanFunctions.h` for `DiffieHellman`: argument shifting when the key
  encoding is not an encoding, generator checks, construction-time `DH_check`, and
  the public key check before `computeSecret`.
- `JSECDHConstructor.cpp`, `JSECDH.cpp` and `JSECDHPrototype.cpp` for `ECDH`, point
  formats and `ECDH.convertKey`. `getCurves()` lists Bun's four curves; secp256k1 is
  not among them, as in Bun.
- `CryptoDhJob.cpp` for `crypto.diffieHellman` and `CryptoPrimes.cpp` for
  `checkPrime` and `generatePrime`.
- `node_crypto_binding.cpp` and ncrypto (`src/jsc/bindings/ncrypto.cpp`) for
  `getCipherInfo`, `Cipher::FromName`'s `aes128`/`aes192`/`aes256` aliases,
  `DHPointer::FindGroup` (RFC 3526 groups; BoringSSL has no modp1 or modp2) and
  `CryptoUtil.cpp`'s `createCryptoError` (`ERR_OSSL_<LIB>_<REASON>` codes).

The JavaScript side is in `crates/bunwasm-runtime/src/js/node_cipher.ts`,
`node_dh.ts` and `node_crypto_args.ts`. `crypto.diffieHellman` reads the two keys
through `KeyObject.export({ format: "jwk" })`, so `crypto_keys.ts` (pinned by its
syntax guard) is unchanged. `crypto_hash_stream.ts` now takes the
`_transform` and `_flush` pair, so ciphers reuse the Hash LazyTransform.

The native side is original Rust over the BoringSSL already linked for WebCrypto and
TLS: `crates/bunwasm-crypto-sys/src/node.rs` declares BoringSSL's public EVP cipher,
DH, BIGNUM, EC and X25519 functions, `crates/bunwasm-runtime/src/node_cipher.rs` holds
cipher contexts by handle (freed by `final()` or a FinalizationRegistry), and
`node_dh.rs` rebuilds DH and EC keys from the bytes JavaScript holds on each call.
`getCiphers()` lists BoringSSL's cipher table as Bun prints it.

Differences from native Bun, all deliberate:

- Each native call clears BoringSSL's error queue first. Native Bun reads the oldest
  queued error, so a failure can report an error left by an earlier, unrelated call
  (for example `INVALID_KEY_LENGTH` from a `getCipherInfo` probe in a later `final()`).
- `generatePrime` with `add` and no `rem` follows BoringSSL. Native Bun 1.4.4 never
  returns for that case; the fixtures pass both.
- `crypto.diffieHellman` covers the key types the KeyObject layer holds: EC P-256,
  P-384 and X25519. DH and X448 KeyObjects do not exist here.
- `getDiffieHellman` does not run `DH_check` on the constant RFC 3526 primes. With
  generator 2, BoringSSL reports `DH_NOT_SUITABLE_GENERATOR` (8) for every group, the
  `verifyError` native Bun 1.4.4 prints for modp5 to modp18, and the check took up to
  14 seconds for modp16 in the guest.

The FinalizationRegistry that frees unfinished ciphers uses each cipher's state, not
the cipher, as its unregister token: QuickJS never collects an object that is its own
token. `bun:internal-for-testing` exposes `liveCipherCount()` for the
`node-crypto-cipher-finalization` fixture, which drops 1000 unfinished ciphers and
checks that their contexts are released. It runs on QuickJS, JSC and the browser
engine. The experimental SpiderMonkey embedding does not install SpiderMonkey's
FinalizationRegistry cleanup hook, so no registry callback runs there for any module.

The `node-crypto-ciphers`, `node-crypto-dh` and `node-crypto-primes` fixtures are
original test code. They check NIST SP 800-38A, the GCM specification's test cases 2, 4
and 6, RFC 5903 and RFC 7748 vectors, streaming and encodings, and every argument
error against native Bun's output.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/node_cipher.ts`, `node_dh.ts`, `node_crypto_args.ts`](#nodecrypto-ciphers-diffie-hellman-ecdh-and-primes) | Adapted implementation | Bun's node:crypto classes and C++ argument checks in TypeScript. |
| [`crates/bunwasm-runtime/src/node_cipher.rs`, `node_dh.rs`, `crates/bunwasm-crypto-sys/src/node.rs`](#nodecrypto-ciphers-diffie-hellman-ecdh-and-primes) | Original adapter | BoringSSL cipher, DH, ECDH, X25519 and prime bindings. |

[Ledger scope and pinned revisions](scope.md).
