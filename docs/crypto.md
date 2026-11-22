# Crypto APIs

All three engines use the same WebCrypto provider: the runtime's JS adapter over the wasm
RustCrypto/BoringSSL backend. It owns every argument check, key object and message, so a
program behaves the same on every engine and in every browser, including algorithms the host
browser lacks (Chromium has no ChaCha20-Poly1305, ML-KEM, ML-DSA or AES-192).

On the browser engine, the bulk computation of a validated call runs on the host's own Web
Crypto when it supports the algorithm and key: SHA-1 and SHA-2 digests, AES-GCM, AES-CBC and
AES-CTR encryption, and HMAC, RSASSA-PKCS1-v1_5, RSA-PSS and ECDSA signatures. The runtime
passes the key's material to the host once, keeps the host key with its own, and takes only
the result from the host. When the host refuses a key or an operation fails there, the guest
computes it instead and answers with its own result or error. Pending host work keeps the
program alive. The host's DOMException constructor stays the global one, so errors keep
their brand. The WASI host captures its entropy function before globals change.

SubtleCrypto methods reject a receiver that is not the `crypto.subtle` object, as Bun does.
Digests, encryption, signatures and derivation settle in a later task, after microtasks
already queued; key generation, import, export and wrapping resolve at once, as in Bun.

| Algorithms | Operations | Key formats |
| --- | --- | --- |
| HMAC | Generate, import, export, sign, verify | raw, JWK |
| ECDSA P-256, P-384 and P-521 | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8, raw public |
| Ed25519 | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8, raw public |
| RSASSA-PKCS1-v1_5 and RSA-PSS | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8 |
| AES-GCM, AES-CBC and AES-CTR | Generate, import, export, encrypt, decrypt, wrap, unwrap | raw, JWK |
| RSA-OAEP | Generate, import, export, encrypt, decrypt, wrap, unwrap | JWK, SPKI, PKCS#8 |
| AES-KW | Generate, import, export, wrap, unwrap | raw, JWK |
| PBKDF2 and HKDF | Import, derive bits, derive keys | raw input, non-extractable |
| ECDH P-256, P-384 and P-521, X25519 | Generate, import, export, derive bits, derive keys | JWK, SPKI, PKCS#8, raw public |
| ChaCha20-Poly1305 | Generate, import, export, encrypt, decrypt, wrap, unwrap | raw-secret, JWK |
| ML-DSA-44, ML-DSA-65 and ML-DSA-87 | Generate, import, export, sign, verify | JWK (AKP), SPKI, PKCS#8, raw-public, raw-seed |
| ML-KEM-768 and ML-KEM-1024 | Generate, import, export, encapsulate, decapsulate | JWK (AKP), SPKI, PKCS#8, raw-public, raw-seed |

Digest supports SHA-1, SHA-256, SHA-384, SHA-512 and SHA3-256, SHA3-384 and SHA3-512,
which HMAC, RSA, ECDSA, PBKDF2 and HKDF also take ([the source
ledger](bun-patches/webcrypto-pqc-chacha-sha3.md)). Keys clone with `structuredClone`. Wrapping uses the selected key format
and encryption algorithm. AES-KW JWK wrapping pads the JSON with spaces to an eight-byte
boundary. GCM supports every WebCrypto tag size and arbitrary nonempty IV lengths. CTR
increments only the selected counter bits, including a wrap within that field. RSA-OAEP
labels are byte strings, including non-UTF-8 data.

CryptoKey records enforce algorithm, usage and extractability checks. Public metadata is
separate from the operation's internal algorithm record. Assigning `crypto.subtle` is ignored,
as in native Bun. SubtleCrypto returns promises. The guest computes synchronously before
settling; host work runs asynchronously on the host.

## Backend

RustCrypto implements AES, GHASH, HMAC, the SHA digests, PBKDF2, HKDF, Ed25519 and X25519.
RustCrypto's PKCS#8 and SPKI parsers decode the outer key envelopes.
The GCM adapter and its upstream license are recorded in [the source ledger](bun-patches/webcrypto-backend.md#webcrypto-backend).

Bun's BoringSSL pin `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` owns the P-256, P-384 and
P-521 keys, ECDSA and ECDH, through the same calls as Bun's WebCrypto ([the source
ledger](bun-patches/node-crypto-ec-raw-keys.md)). It also owns RSA generation,
component validation, PKCS#1 parsing, signing, verification and OAEP operations. Its native
EVP operations provide Bun's RSA behavior without the documented RUSTSEC-2023-0071 issue in
the RustCrypto RSA crate. That crate is not a dependency.

The shared `bunwasm-crypto-sys` crate owns BoringSSL linkage for the runtime and the
standalone parser/glue targets. Its C adapter owns BoringSSL objects only during a call. Rust owns the request dispatch,
key-format conversion and results. The JS adapter supplies WebCrypto's argument and policy
checks. Bun's corresponding generated builtins require JSC-native bindings, so they cannot
provide this engine-independent implementation yet.

`scripts/sync-crypto.sh` supplies the unmodified pinned source. Each target builds its own
archive in Cargo's build directory. WASI disables assembly, threads and socket BIOs. All
engines link wasi-sdk's libc and libc++ so Rust and BoringSSL share one C runtime.
`BUNWASM_BORINGSSL_SOURCE` selects a source directory; `BUNWASM_BORINGSSL_BUILD` selects an
already built archive for that target.

## Verification

[webcrypto-keys](../tests/fixtures/webcrypto-keys) exercises the algorithm families, key
formats, usage checks, tamper rejection and key wrapping.
[crypto-vectors](../tests/fixtures/crypto-vectors) checks 45 native Node vectors, including
all GCM tag sizes, AES-192, non-96-bit GCM IVs, CTR field wrap and binary OAEP labels.
`scripts/generate-crypto-vectors.mjs` regenerates those vectors with native Node.
`scripts/check-crypto-review.sh <report-dir>` replays the SHA-1 JWK, P-384/SHA-1 and
required-HMAC-hash generation/derivation regressions in every engine and verifies the runtime outputs in both
native Node and Bun. `scripts/webcrypto-browser.test.ts` (a `browser-guest` check) runs
those fixtures, AES-192, ChaCha20-Poly1305, ML-KEM, ML-DSA, Bun's error messages, keys sent
to a page Worker and settlement order on the browser engine in Chromium and WebKit.
[webcrypto-settlement](../tests/fixtures/webcrypto-settlement) checks the receiver and
settlement order on every engine.

Measured against main `6f1e576` on 2026-10-16, all 24 selected upstream crypto files run
without timeouts. Observed passing tests rise from 165 to 185 on QuickJS and browser, and
164 to 184 on JSC. The comparison includes failures and collection errors; no file is fully
passing yet. The separate regression fixtures pass on all three engines.

| Engine artifact | Size in bytes | Increase | Gzip-9 increase |
| --- | ---: | ---: | ---: |
| bun.wasm | 12,835,399 | 750,829 | 277,645 |
| bun-jsc.wasm | 48,810,447 | 951,362 | 312,268 |
| bun-browser.wasm | 12,126,319 | 764,535 | 284,310 |

These builds use the existing BoringSSL Release archive with assembly disabled. The default
fresh build uses MinSizeRel. JSC uses the shared prebuilt C-loop engine. The measurements
include the required workspace patch bump from 0.0.13 to 0.0.14.

## Node key APIs

`node:crypto` provides KeyObject, createSecretKey, createPrivateKey, createPublicKey,
generateKeyPair and generateKeyPairSync, generateKey and generateKeySync, createSign,
createVerify, sign and verify. Signing objects are Writable streams. Callback variants
schedule work on the runtime event loop. PBKDF2 and HKDF expose sync and callback forms.

Key-pair generation supports RSA, EC P-256/P-384/P-521, Ed25519 and X25519. Secret generation
supports HMAC and AES. HMAC lengths round down to complete bytes, as in native Node.
Asymmetric keys import and export JWK, PEM and DER. RSA also supports PKCS#1; EC supports
SEC1. EC, Ed25519 and X25519 keys also take Node's `raw-public` (EC points compressed or
not) and `raw-private` formats. Signing accepts OpenSSL's digest names and their
signature aliases, such as `RSA-SHA256`, `sha256WithRSAEncryption` and `RSA-MD5`. Private-key encryption uses BoringSSL for PEM PKCS#8/PKCS#1/SEC1 and DER PKCS#8,
with byte-preserving passphrases. publicEncrypt, privateDecrypt, privateEncrypt and
publicDecrypt take OAEP, PKCS#1 v1.5 and raw (`RSA_NO_PADDING`) padding through BoringSSL,
with Bun's defaults and errors; like Bun, privateDecrypt refuses PKCS#1 v1.5
([the source ledger](bun-patches/node-crypto-rsa-cipher.md)).

KeyObject.from and KeyObject.toCryptoKey share key material with WebCrypto. The Node key
family reflects the material: converting an RSA-PSS CryptoKey produces an RSA KeyObject,
and converting an ECDH CryptoKey produces an EC KeyObject. Secret equality compares bytes;
asymmetric equality compares canonical public encodings. Byte comparison runs in Rust
through `subtle::ConstantTimeEq`.

The Node key fixture includes six native Node encrypted-key vectors and signature checks.
`scripts/generate-node-key-vectors.mjs` regenerates them. The fixture is marked manual
because native Bun 1.4.2 reports the wrong private/public type for createPublicKey with
encrypted PKCS#8 DER. The adapter returns a public key, matching Node.

With the Node key adapters, the same 24-file census records 270 observed passes on QuickJS
and browser and 269 on JSC, with two fully passing signing files and no timeouts. The
KeyObject file now collects: 75 passing, 12 failing, 31 skipped and one todo. Its former
collection failure did not register those cases, so the overall observed totals increase.
The complete fixture gate passes 108 fixtures on each engine, plus web checks and six HMR runs.

| Node artifact | Size in bytes | Increase over WebCrypto | Gzip-9 increase |
| --- | ---: | ---: | ---: |
| bun.wasm | 13,295,126 | 459,727 | 161,864 |
| bun-jsc.wasm | 49,465,549 | 655,102 | 184,277 |
| bun-browser.wasm | 12,589,890 | 463,571 | 164,916 |

An offline Next 15.5.6 browser-engine/native-host replay passes installation. Build advances beyond the missing crypto
operation and stops at `TypeError: _promises.default.opendir is not a function`. Dev has no
useful diagnostic; start is blocked by build. The replay is not a passing Next application.

### KeyObject conversion

KeyObject and CryptoKey share the provider's key records on every engine. Secret KeyObject conversion imports raw bytes, including HKDF and PBKDF2 material. RSA
signature padding accepts the default, PKCS#1 v1.5 and PSS modes. Other values throw before
the backend runs. Native Bun also throws on streamed verification; Node 26 returns false
there, while its one-shot verification throws. The runtime follows the requested throwing
behavior on both paths.

## Node ciphers, Diffie-Hellman, ECDH and primes

`node:crypto` provides createCipheriv and createDecipheriv (Cipheriv and Decipheriv
streams), getCiphers, getCipherInfo, createDiffieHellman, getDiffieHellman and
createDiffieHellmanGroup, createECDH and `ECDH.convertKey`, `crypto.diffieHellman`,
generatePrime, generatePrimeSync, checkPrime and checkPrimeSync. They run on the
BoringSSL already linked for WebCrypto and TLS, on every engine, so the cipher list,
curves and failures are Bun's: AES in CBC, CTR, ECB, CFB, OFB and GCM, DES, 3DES,
Blowfish, RC2 and RC4; no ChaCha20-Poly1305 and no secp256k1, as in Bun 1.4.4. The
browser engine uses the same wasm implementation; SubtleCrypto has no streaming
ciphers or classic Diffie-Hellman to delegate to. `crypto.diffieHellman` takes EC
P-256, P-384, P-521 and X25519 KeyObjects. [The source ledger](bun-patches/node-crypto-ciphers-dh-primes.md)
lists the Bun sources the argument checks follow and the deliberate differences.

The `node-crypto-ciphers`, `node-crypto-dh` and `node-crypto-primes` fixtures compare
NIST SP 800-38A, GCM, RFC 5903 and RFC 7748 vectors and each argument error with
native Bun. A DiffieHellman built from a caller's prime checks it as Bun does, which
takes about a second for a 1536-bit prime in the guest; the built-in RFC 3526 groups
report Bun's `verifyError` of 8 without the check. `node-crypto-cipher-finalization`
checks that ciphers dropped before `final()` release their contexts when collected.
