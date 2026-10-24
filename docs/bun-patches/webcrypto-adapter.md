### WebCrypto adapter

The original host adapter captures SubtleCrypto and its key constructors before bootstrap
replaces globals. The browser engine exposes that same provider; QuickJS and wasm JSC use
the shared RustCrypto/BoringSSL adapter. Supported native cryptographic operations stay with the native provider.
SHA-1 JWK identifiers are HS1, RS1 and PS1. HMAC generation validates the required hash
before allocating key material. The ECDSA adapter left-pads short P-384 prehashes with zeros,
preserving the integer defined by ECDSA while meeting ecdsa 0.16.9's prehash input bound.
No upstream source was copied or changed for these corrections.


[Parent context](bun-console-constructor.md).

[Ledger scope and pinned revisions](scope.md).
