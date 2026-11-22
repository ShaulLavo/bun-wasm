## Node crypto key adapters

`src/js/crypto_keys.ts` is an original adapter, not copied Bun or Node code. It shares the
WebCrypto backend while providing synchronous Node operations, Writable signing objects,
PEM encoding, encrypted PKCS#8/PKCS#1/SEC1 formats and WebCrypto key conversions. BoringSSL's original PEM and PKCS#8 APIs perform key encryption and decryption in `crates/bunwasm-crypto-sys/c/rsa.c`. `src/crypto.rs` adds Node's PKCS#1 format through
BoringSSL. EC keys, including SEC1, and the ECDSA signature encodings (DER and IEEE P1363)
are in `src/crypto_ec.rs` over BoringSSL ([its record](node-crypto-ec-raw-keys.md)). Bun's Node crypto builtin requires a native binding, so loading its generated
JavaScript alone cannot supply this behavior. The new fixture is original test code.

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
| [`crates/bunwasm-runtime/src/js/crypto_keys.ts` and `crypto_host_keys.js`, Node key adapters](#node-crypto-key-adapters) | Host feature | Original Node key objects, encodings and signatures over the WebCrypto backend. |

[Ledger scope and pinned revisions](scope.md).
