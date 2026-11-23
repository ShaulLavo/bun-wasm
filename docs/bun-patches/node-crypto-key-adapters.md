## Node crypto key adapters

`src/js/crypto_keys.ts` is an original adapter, not copied Bun or Node code. It shares the
WebCrypto backend while providing synchronous Node operations, Writable signing objects,
PEM encoding, encrypted PKCS#8/PKCS#1/SEC1 formats and WebCrypto key conversions. BoringSSL's original PEM and PKCS#8 APIs perform key encryption and decryption in `crates/bunwasm-crypto-sys/c/rsa.c`. `src/crypto.rs` adds Node's PKCS#1 format through
BoringSSL. EC keys, including SEC1, and the ECDSA signature encodings (DER and IEEE P1363)
are in `src/crypto_ec.rs` over BoringSSL ([its record](node-crypto-ec-raw-keys.md)). Bun's Node crypto builtin requires a native binding, so loading its generated
JavaScript alone cannot supply this behavior. The new fixture is original test code.

### Key pair generation arguments (adapted)

`generateKeyPair` and `generateKeyPairSync` adapt Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/jsc/bindings/node/crypto/CryptoGenKeyPair.cpp` `jsGenerateKeyPair` and
  `jsGenerateKeyPairSync`: the callback, the type string, both output encodings, the options
  object, then the key type's own options, all checked before any work; an unknown type is
  `ERR_INVALID_ARG_VALUE`. `generateKeyPair` throws these synchronously and passes only
  generation and export errors to its callback.
- `CryptoUtil.cpp` `parseKeyEncoding`, `parseKeyFormatAndType` and `parseKeyType` for the
  encodings: the format, a type that fits the key type and side (`pkcs1` only for RSA, `sec1`
  only for EC), and private key encryption (a string cipher BoringSSL knows, a string or
  buffer passphrase, none for raw formats or DER PKCS#1 and SEC1).
- `CryptoGenRsaKeyPair.cpp` `RsaKeyPairJobCtx::fromJS`: the options object, the required
  uint32 `modulusLength`, the optional uint32 `publicExponent` (odd and at least 3), then for
  "rsa-pss" every hash option read, then checked, with the DEP0154 warnings for `hash` and
  `mgf1Hash` sent through the runtime's own warning implementation (`process_warning.ts`), as
  Bun's `Process::emitWarning` bypasses a replaced `process.emitWarning`; an error thrown
  while warning propagates. Digest names resolve through ncrypto's `Digest::FromName`
  (`node_digest.ts` `hmacName`). Like Bun, a `hash` that differs from `hashAlgorithm` is not
  reported, and the key itself fails with `ERR_OSSL_EVP_UNSUPPORTED_ALGORITHM`, because Bun's
  BoringSSL generates no RSA-PSS keys either.
- `CryptoGenEcKeyPair.cpp` `EcKeyPairJobCtx::fromJS`: the options object and a string
  `namedCurve`. Bun generates P-224 keys and then fails a JWK export of them with
  `ERR_CRYPTO_JWK_UNSUPPORTED_CURVE`; the backend here has no P-224 keys, so that error is
  given in its place, and other curves BoringSSL here lacks report `ERR_OSSL_EC_UNKNOWN_GROUP`.

The `node-crypto-rsa-pss-keygen` fixture is original test code with native Bun 1.4.4's output.

`scripts/generate-node-key-vectors.mjs` generates six native Node encrypted-key and signature
vectors for the original Node key fixture. Its synthetic keys and passphrase are test data.

The pinned cipher-name registry references BoringSSL's CFB and Blowfish entry points. The
Node build selects these objects in `crates/bunwasm-crypto-sys/build.rs` and compiles the unchanged `decrepit/cfb/cfb.cc` and `decrepit/blowfish/blowfish.cc`
from the same pin into its own Cargo output directory. The shared prebuilt archive remains
read-only. These are dependency build selections, not copied or patched implementations.

One-shot `crypto.verify` reads the signature's bytes when it is called, before it parses
the key and runs its option getters (a `passphrase` getter, for example), as Node and
Bun 1.4.4 do: the bytes come from the view's own storage, so a shadowing `buffer`
property is not consulted and a detached view verifies as an empty signature. The callback
form takes the same snapshot. The `node-crypto-sign-digests` fixture covers these cases.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts`, Node key adapters](#node-crypto-key-adapters) | Host feature | Original Node key objects, encodings and signatures over the WebCrypto backend. |
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts` `prepareKeyPair`, `checkPairEncoding`, `rsaKeyPair`, `checkRsaPssOptions` and `ecKeyPair`](#key-pair-generation-arguments-adapted) | Adapted implementation | Bun's key pair argument and encoding checks, RSA-PSS options and DEP0154 warnings, in TypeScript. |

[Ledger scope and pinned revisions](scope.md).
