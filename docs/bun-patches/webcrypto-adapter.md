### WebCrypto adapter

Every engine, the browser engine included, uses the shared RustCrypto/BoringSSL adapter.
The browser engine used to keep the host browser's SubtleCrypto; it no longer does, because
the host's algorithms, validation and messages differ from Bun's (Chromium has no
ChaCha20-Poly1305, ML-KEM, ML-DSA or AES-192). It still computes supported digests, AES
and signatures on the host's Web Crypto after the adapter's checks
([the record](native-crypto-capabilities.md)).
SHA-1 JWK identifiers are HS1, RS1 and PS1. HMAC generation validates the required hash
before allocating key material. The ECDSA adapter left-pads short P-384 prehashes with zeros,
preserving the integer defined by ECDSA while meeting ecdsa 0.16.9's prehash input bound.
No upstream source was copied or changed for these corrections.


[Parent context](bun-console-constructor.md).

[Ledger scope and pinned revisions](scope.md).
