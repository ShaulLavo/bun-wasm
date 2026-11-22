## Native crypto capabilities

Class **Host feature**. Original adapters, not copied upstream code.

`crates/bunwasm-runtime/src/js/crypto_host_compute.ts` runs the bulk computation of a
SubtleCrypto call on the browser engine's host Web Crypto, after the runtime's provider
(`crypto.js`) has validated it: SHA-1 and SHA-2 digests, AES-GCM, AES-CBC and AES-CTR
encryption and decryption, and HMAC, RSASSA-PKCS1-v1_5, RSA-PSS and ECDSA signing and
verification. It imports each guest key's material into the host once (raw bytes for secret
keys, JWK for RSA and EC keys) and caches the host key beside the guest key. A refused import
(AES-192 on Chromium) or a failed host operation falls back to the guest's own computation,
which also supplies every error. Only the result comes from the host.

`web/src/host-crypto.ts` captures the host's SubtleCrypto before bootstrap replaces `crypto`
and tracks each host promise so pending crypto keeps the program alive.

The former adapters `web/src/crypto-host.js` and `crypto-inputs.js`, which exposed the host's
SubtleCrypto itself as the browser engine's provider, are removed. The runtime's provider owns
AES-192, AES-KW JWK padding and the 2 GiB input bound on every engine.
No upstream source was copied or changed.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/crypto_host_compute.ts`, `web/src/host-crypto.ts`](#native-crypto-capabilities) | Host feature | Compute validated digests, AES and signatures on the host's Web Crypto, with guest fallback. |
| [`web/src/crypto-host.js`, `crypto-inputs.js` (removed)](#native-crypto-capabilities) | Host feature | Removed with the host provider. |

[Ledger scope and pinned revisions](scope.md).
