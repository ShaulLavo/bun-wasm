## Native crypto capabilities

Class **Host feature**. Original host adapters. `web/src/crypto-host.js` probes each native
AES algorithm with a valid 192-bit key. Only a confirmed unsupported 192-bit operation uses
the existing RustCrypto backend. Supported native operations retain their provider and keys.
Mixed wrapping uses an exportable native HMAC key as a raw byte container when a native
wrapping key must wrap a wasm AES-192 key. A separate native probe detects AES-KW JWK
alignment gaps; only those calls serialize and pad the JWK before native raw wrapping. The HMAC operation is never used. This preserves
native wrapping with non-extractable, wrap-only keys. `crypto-inputs.js` preserves the runtime's
2 GiB input boundary before native copies, including algorithm-dictionary buffer members.
No upstream cryptographic implementation is copied or changed.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/crypto-host.js`, `crypto-inputs.js`](#native-crypto-capabilities) | Host feature | Preserve native crypto, fill the verified AES-192 gap and enforce the runtime input bound. |

[Ledger scope and pinned revisions](scope.md).
