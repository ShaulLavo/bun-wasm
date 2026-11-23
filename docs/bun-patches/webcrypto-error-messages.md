# WebCrypto argument checks and error messages

## Classification

Class: Adapted behavior in original adapters. The checks in
`crates/bunwasm-runtime/src/js/crypto.js` and the key-type errors in
`crates/bunwasm-runtime/src/crypto.rs` follow Bun's `src/jsc/bindings/webcrypto`
(`SubtleCrypto.cpp`, `CryptoAlgorithm*.cpp`, `CryptoKey*.cpp`) and its generated
bindings at revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native
Bun 1.4.4. No upstream source is copied. The `webcrypto-backend.md` record still owns
the adapter itself.

## Behavior

Arguments convert in WebIDL order before any algorithm runs. A `KeyFormat` is
stringified once; an unknown one is a `TypeError` with `ERR_INVALID_ARG_VALUE`. Key
data that is not a BufferSource for a buffer format is a `TypeError` with
`ERR_INVALID_ARG_TYPE`. A JWK is read as the `JsonWebKey` dictionary, each member once in
sorted order, so a throwing getter surfaces as is and an unknown `key_ops` entry is
`TypeError: value must be enumeration (string)`. Usages are a `KeyUsage` sequence that
includes the four KEM spellings, which no algorithm here accepts.

Usage problems are plain `SyntaxError`s, worded as Bun words them for generateKey
("creating") and importKey, including empty usages on a secret or private key. An
unknown algorithm is `NotSupportedError: Unrecognized algorithm name`, and
RSAES-PKCS1-v1_5 reports its deprecation. `raw-public` and `raw-secret` import and
export as `raw`. HMAC JWKs report Node's member messages in Node's order (decoding `k`
leniently, as Node's Buffer does); AES and the KDFs report WebCore's generic
`DataError`, and EC, OKP and RSA keys name `use`, `crv` and `alg` problems and call the
rest `Invalid keyData`. A DOMException without a specific reason takes WebCore's default
message for its name.

The native backend answers either an error name or `Name: message`. A SPKI or PKCS#8
key of another key type is `DataError: Invalid key type`, an EC key of another curve is
`Named curve mismatch`, and a 64-byte Ed25519 JWK `d` must end with the public key of
its seed. A private OKP JWK takes its public key from `d`, ignoring `x`, as Bun does.
ECDH and X25519 `deriveBits` keep the leading bits of a length that is not a multiple
of 8 and zero the rest; `deriveBits.length` is 2.

The `webcrypto-error-messages` fixture compares these paths with native Bun on all three
engines. The Browser engine runs the same checks and messages; only the bulk computation of
a supported operation goes to the browser's own Web Crypto, and a host failure is answered
by the guest's computation and its error.

[Ledger scope and pinned revisions](scope.md).
