# Crypto APIs

The browser engine uses the host's native SubtleCrypto provider when it is available.
The host captures that provider and its CryptoKey constructors before installing runtime
globals. Keys created before bootstrap remain usable. The host tracks native crypto
promises so pending operations keep the runtime alive and unhandled rejections remain fatal.
It preserves the native DOMException constructor so native errors retain their global brand. In an insecure context without
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

The C adapter owns BoringSSL objects only during a call. Rust owns the request dispatch,
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
