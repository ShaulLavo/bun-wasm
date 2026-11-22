# node:crypto RSA encryption

Class: Adapted implementation (argument order and errors), Original adapter (native binding).

`publicEncrypt`, `privateDecrypt`, `privateEncrypt` and `publicDecrypt` follow Bun at
revision `9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/jsc/bindings/node/crypto/JSCipher.cpp` `rsaFunction`: the default padding (OAEP for
  publicEncrypt and privateDecrypt, PKCS#1 v1.5 for privateEncrypt and publicDecrypt), the
  order of the reads (`padding`, `oaepHash`, `encoding`, `oaepLabel`, then the key, then the
  data), the copied label, `ERR_OSSL_EVP_INVALID_DIGEST` for an unknown OAEP digest, and
  `ERR_INVALID_ARG_VALUE` for PKCS#1 v1.5 private decryption.
- ncrypto's `Cipher::encrypt`, `decrypt`, `sign` and `recover`
  (`src/jsc/bindings/ncrypto.cpp`): one EVP_PKEY operation each, with the padding and,
  for OAEP, the digest and label set on the context. BoringSSL errors keep their
  `ERR_OSSL_<LIB>_<REASON>` codes.
- ncrypto's `IsRSAPrivateKey`: a PKCS#1 DER key passed where a public key is expected is
  read as a private key when its SEQUENCE opens with the one-byte version 0 or 1.
- `CryptoUtil.cpp` `getArrayBufferOrView2` for the label and data: a string in the given
  encoding, an ArrayBuffer or a view, otherwise `ERR_INVALID_ARG_TYPE`. A string key with
  `encoding` is decoded first, as in Node's `prepareAsymmetricKey`.

The JavaScript side is `rsaCipher` in `crates/bunwasm-runtime/src/js/crypto_keys.ts`. The
native side is original: `crates/bunwasm-runtime/src/node_rsa.rs` turns the key's JWK into
PKCS#1 DER and calls `bunwasm_rsa_cipher` in `crates/bunwasm-crypto-sys/c/rsa.c`, which
WebCrypto's RSA-OAEP now shares. The `node-crypto-rsa-cipher` fixture is original test code;
its expected output is native Bun 1.4.4's.

Differences from native Bun: a non-RSA key reports
`ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE` from JavaScript rather than from
BoringSSL, so its message is BoringSSL's reason text without the packed error prefix.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts` `rsaCipher` and `pkcs1Private`](#nodecrypto-rsa-encryption) | Adapted implementation | Bun's RSA cipher argument order, defaults and errors in TypeScript. |
| [`crates/bunwasm-runtime/src/node_rsa.rs`, `bunwasm_rsa_cipher` in `crates/bunwasm-crypto-sys/c/rsa.c`](#nodecrypto-rsa-encryption) | Original adapter | BoringSSL EVP encrypt, decrypt, sign and verify-recover with a padding mode. |

[Ledger scope and pinned revisions](scope.md).
