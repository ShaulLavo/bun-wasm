## WebCrypto backend

`crates/bunwasm-runtime/src/crypto.rs` links RustCrypto primitives and its maintained JWK,
PKCS#8 and SPKI parsers. Cargo.lock pins the dependency revisions. Bun's BoringSSL pin `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` handles RSA signing,
verification and OAEP encryption and decryption through the original `crates/bunwasm-crypto-sys/c/rsa.c` adapter.
BoringSSL also owns RSA key generation, component validation and PKCS#1 parsing. The
RustCrypto RSA dependency is excluded because it documents RUSTSEC-2023-0071. The maintained
RustCrypto PKCS#8 and SPKI parsers handle the outer key-format envelopes.
`scripts/sync-crypto.sh` downloads the unmodified source. `third_party/licenses/boringssl-LICENSE`
is the unmodified LICENSE from that pin. The crypto placeholders in `crates/bunwasm-glue/src/extra.rs` are removed so Bun and this
adapter use BoringSSL's real allocator, stack and X.509 interfaces with their correct ABI.
The later TLS driver removes the three SSL session placeholders too, so libssl
owns those symbols. The build disables assembly,
threads and socket BIOs on WASI, as in the earlier successful runtime spike.

The original request adapter
and `src/js/crypto.js` connect them to every Engine through the existing data-native bridge.
Bun's WebCrypto implementation calls JSC and native C++ bindings, so it cannot run as an
engine-independent builtin yet.

The `gcm` helper adapts `aes-gcm` 0.10.3 `src/lib.rs`, `init_ctr`, `compute_tag`, and its
`AeadInPlace` implementation from RustCrypto/AEADs. WebCrypto accepts runtime nonce lengths
and 32-bit and 64-bit tags, while that crate requires a type-level nonce length and tags of at
least 96 bits. The adapter uses the same RustCrypto AES, CTR32 and GHASH implementations,
authenticates before decryption, and compares tags with `subtle::ConstantTimeEq`. Its MIT
license is retained in `third_party/licenses/aes-gcm-MIT`. This is a port, not an upstream bug.

`scripts/generate-crypto-vectors.mjs` and both crypto fixture directories are original test
adapters. Native Node generates signatures, key formats, ciphertext and derived bytes for
comparison with wasm. No upstream test implementation is copied.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/licenses/boringssl-LICENSE`](#webcrypto-backend) | Port | Retain BoringSSL license notices with the wasm backend. |
| [`crates/bunwasm-runtime/src/crypto.rs`, GCM adapter and `third_party/licenses/aes-gcm-MIT`](#webcrypto-backend) | Port | Adapt RustCrypto GCM to WebCrypto nonce and tag lengths. |
| [`crates/bunwasm-runtime/src/js/crypto.js`, shared key adapters and `web/src/engine-host.js` provider capture`](#webcrypto-backend) | Host feature | Original WebCrypto validation and opaque keys over RustCrypto. |

[Ledger scope and pinned revisions](scope.md).
