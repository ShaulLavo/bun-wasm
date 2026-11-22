# node:crypto RSA encryption

Class: Adapted implementation (argument order and errors), Original adapter (native binding).

`publicEncrypt`, `privateDecrypt`, `privateEncrypt` and `publicDecrypt` follow Bun at
revision `9510e74152073d850a18758ca41114d8f214ffa6`, measured against native Bun 1.4.4:

- `src/jsc/bindings/node/crypto/JSCipher.cpp` `rsaFunction`: the default padding (OAEP for
  publicEncrypt and privateDecrypt, PKCS#1 v1.5 for privateEncrypt and publicDecrypt), the
  order of the reads (`padding`, `oaepHash`, `encoding`, `oaepLabel`, then the key, then the
  data), the copied label, `ERR_OSSL_EVP_INVALID_DIGEST` for an unknown OAEP digest, and
  `ERR_INVALID_ARG_VALUE` for PKCS#1 v1.5 private decryption. The padding converts as
  `JSValue::toInt32` does (ToNumber, so a BigInt or Symbol throws), and `oaepHash` resolves
  through ncrypto's `Digest::FromName` (`node_digest.ts` `hmacName`), passed to BoringSSL's
  `EVP_get_digestbyname`.
- ncrypto's `Cipher::encrypt`, `decrypt`, `sign` and `recover`
  (`src/jsc/bindings/ncrypto.cpp`): one EVP_PKEY operation each, with the padding, then any
  OAEP digest and nonempty label set on the context whatever the padding, so BoringSSL
  refuses them under another padding. BoringSSL errors keep their `ERR_OSSL_<LIB>_<REASON>`
  codes.
- Key reading as `KeyObject::preparePrivateKey` and `preparePublicOrPrivateKey` do: a
  KeyObject of the wrong type is `ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE` naming the expected
  types; PEM blocks are chosen per operation (BoringSSL's `PEM_read_bio_PrivateKey` takes the
  first private key; ncrypto's `ParsePublicKeyPEM` takes SubjectPublicKeyInfo, then PKCS#1
  public, then a certificate, then falls back to a private key); input with no usable block is
  `ERR_OSSL_PEM_NO_START_LINE`; an encrypted key without a passphrase is a TypeError
  (`ERR_MISSING_PASSPHRASE`); a failed decryption reports BoringSSL's oldest error, returned
  by `bunwasm_key_encoding` (for example `BAD_DECRYPT` for a wrong passphrase).
- ncrypto's `IsRSAPrivateKey`: a PKCS#1 DER key passed where a public key is expected is
  read as a private key when its SEQUENCE opens with the one-byte version 0 or 1.
- ncrypto's `ParsePublicKeyPEM`: a `CERTIFICATE` PEM block gives its subject public key,
  read through the existing `x509` native. PEM key bytes may come in any view, including a
  `DataView`.
- `CryptoUtil.cpp` `getArrayBufferOrView2` for the label and data: a string in the given
  encoding, an ArrayBuffer or a view, otherwise `ERR_INVALID_ARG_TYPE`. A string key with
  `encoding` is decoded first, as in Node's `prepareAsymmetricKey`.

The JavaScript side is `rsaCipher` in `crates/bunwasm-runtime/src/js/crypto_keys.ts`. The
native side is original: `crates/bunwasm-runtime/src/node_rsa.rs` turns the key's JWK into
PKCS#1 DER and calls `bunwasm_rsa_cipher` in `crates/bunwasm-crypto-sys/c/rsa.c`, which
WebCrypto's RSA-OAEP now shares. The `node-crypto-rsa-cipher` fixture is original test code;
its expected output is native Bun 1.4.4's.

A non-RSA key never reaches the native side; JavaScript reports BoringSSL's
`OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE` error (`0600007d`) for it, as Bun does. PEM and
PKCS#8 key decryption moved from the WebCrypto JSON backend to the `nodeCrypto.keyEncoding`
native in `node_rsa.rs`, so it can throw BoringSSL's error.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts` `rsaCipher`, `pkcs1Private`, `readPem` and key object type errors](#nodecrypto-rsa-encryption) | Adapted implementation | Bun's RSA cipher argument order, defaults and errors, and its PEM block selection, in TypeScript. |
| [`crates/bunwasm-runtime/src/node_rsa.rs`, `bunwasm_rsa_cipher` and `bunwasm_key_encoding`'s error code in `crates/bunwasm-crypto-sys/c/rsa.c`](#nodecrypto-rsa-encryption) | Original adapter | BoringSSL EVP encrypt, decrypt, sign and verify-recover with a padding mode; key decryption with BoringSSL's error. |

[Ledger scope and pinned revisions](scope.md).
