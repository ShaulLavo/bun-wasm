# Crypto APIs

The browser engine uses the host's native SubtleCrypto provider when it is available.
A valid-key capability probe identifies native AES-192 gaps. Only those operations use the
shared RustCrypto backend; native-supported algorithms and key operations stay native.
A separate probe fills native AES-KW JWK alignment gaps by passing aligned bytes to native
raw wrapping. It also works with non-extractable wrapping keys.
The host captures that provider and its CryptoKey constructors before installing runtime
globals. Keys created before bootstrap remain usable. The host tracks native crypto
promises so pending operations keep the runtime alive and unhandled rejections remain fatal.
It preserves the native DOMException constructor so native errors retain their global brand.
The existing 2 GiB input bound also applies before native copies. In an insecure context without
SubtleCrypto, the browser engine uses the wasm provider shared with QuickJS and wasm JSC.
The WASI host also captures its entropy function before globals change.

| Algorithms | Operations | Key formats |
| --- | --- | --- |
| HMAC | Generate, import, export, sign, verify | raw, JWK |
| ECDSA P-256 and P-384 | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8, raw public |
| Ed25519 | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8, raw public |
| RSASSA-PKCS1-v1_5 and RSA-PSS | Generate, import, export, sign, verify | JWK, SPKI, PKCS#8 |
| AES-GCM, AES-CBC and AES-CTR | Generate, import, export, encrypt, decrypt, wrap, unwrap | raw, JWK |
| RSA-OAEP | Generate, import, export, encrypt, decrypt, wrap, unwrap | JWK, SPKI, PKCS#8 |
| AES-KW | Generate, import, export, wrap, unwrap | raw, JWK |
| PBKDF2 and HKDF | Import, derive bits, derive keys | raw input, non-extractable |
| ECDH P-256 and P-384, X25519 | Generate, import, export, derive bits, derive keys | JWK, SPKI, PKCS#8, raw public |

Digest supports SHA-1, SHA-256, SHA-384 and SHA-512. Wrapping uses the selected key format
and encryption algorithm. AES-KW JWK wrapping pads the JSON with spaces to an eight-byte
boundary. GCM supports every WebCrypto tag size and arbitrary nonempty IV lengths. CTR
increments only the selected counter bits, including a wrap within that field. RSA-OAEP
labels are byte strings, including non-UTF-8 data.

CryptoKey records enforce algorithm, usage and extractability checks. Public metadata is
separate from the operation's internal algorithm record. Assigning `crypto.subtle` is ignored,
as in native Bun. SubtleCrypto returns promises. Operations on the wasm provider run
synchronously inside those promises; native provider scheduling stays with the host.

## Backend

RustCrypto implements AES, GHASH, HMAC, the SHA digests, PBKDF2, HKDF, P-256, P-384,
Ed25519 and X25519. RustCrypto's PKCS#8 and SPKI parsers decode the outer key envelopes.
The GCM adapter and its upstream license are recorded in [the source ledger](bun-patches.md#webcrypto-backend).

Bun's BoringSSL pin `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` owns RSA generation,
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

[webcrypto-keys](../tests/fixtures/webcrypto-keys/) exercises the algorithm families, key
formats, usage checks, tamper rejection and key wrapping.
[crypto-vectors](../tests/fixtures/crypto-vectors/) checks 45 native Node vectors, including
all GCM tag sizes, AES-192, non-96-bit GCM IVs, CTR field wrap and binary OAEP labels.
`scripts/generate-crypto-vectors.mjs` regenerates those vectors with native Node.
`scripts/check-crypto-review.sh <report-dir>` replays the SHA-1 JWK, P-384/SHA-1 and
required-HMAC-hash generation/derivation regressions in every engine and verifies the runtime outputs in both
native Node and Bun. The replay also disables host SubtleCrypto to exercise the browser
engine's wasm fallback. `web/tests/browser-crypto.mjs` saves the provider and a native key
before boot, then tests provider identity and native key operations in Chromium and WebKit.

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

Key-pair generation supports RSA, EC P-256/P-384, Ed25519 and X25519. Secret generation
supports HMAC and AES. HMAC lengths round down to complete bytes, as in native Node.
Asymmetric keys import and export JWK, PEM and DER. RSA also supports PKCS#1; EC supports
SEC1. Private-key encryption uses BoringSSL for PEM PKCS#8/PKCS#1/SEC1 and DER PKCS#8,
with byte-preserving passphrases. RSA-OAEP is also available through publicEncrypt and
privateDecrypt. Other classic RSA encryption padding and privateEncrypt/publicDecrypt
remain unsupported.

KeyObject.from and KeyObject.toCryptoKey share key material with WebCrypto. The Node key
family reflects the material: converting an RSA-PSS CryptoKey produces an RSA KeyObject,
and converting an ECDH CryptoKey produces an EC KeyObject. Secret equality compares bytes;
asymmetric equality compares canonical public encodings. Byte comparison runs in Rust
through `subtle::ConstantTimeEq`.

The Node key fixture includes six native Node encrypted-key vectors and signature checks.
`scripts/generate-node-key-vectors.mjs` regenerates them. The fixture is marked manual
because native Bun 1.4.2 reports the wrong private/public type for createPublicKey with
encrypted PKCS#8 DER. The adapter returns a public key, matching Node. The upstream
reproduction is recorded for the owner in `/work/reports/upstream-bugs/README.md`.

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

An offline Next 15.5.6 browser-engine/native-host replay with PR 13's import transform and
main's Next runtime fixes passes installation. Build advances beyond the missing crypto
operation and stops at `TypeError: _promises.default.opendir is not a function`. Dev has no
useful diagnostic; start is blocked by build. The replay is not a passing Next application.

### Host key interop

The browser engine keeps the original native SubtleCrypto object. Its key bridge retains
private key records at asynchronous creation boundaries for Node's synchronous KeyObject
operations. Generated non-extractable keys return as non-extractable native keys; the
private records support the same KeyObject conversion as the wasm provider. Converting a
native key back with the same algorithm, extractability and usages returns its native key.
Keys created synchronously by Node APIs enter the native provider when a SubtleCrypto
operation consumes them. This fills the native provider's inability to import a wasm key
synchronously. The provider performs the cryptographic operation.

Secret KeyObject conversion imports raw bytes, including HKDF and PBKDF2 material. RSA
signature padding accepts the default, PKCS#1 v1.5 and PSS modes. Other values throw before
the backend runs. Native Bun also throws on streamed verification; Node 26 returns false
there, while its one-shot verification throws. The runtime follows the requested throwing
behavior on both paths.
