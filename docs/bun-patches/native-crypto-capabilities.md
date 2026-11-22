## Native crypto capabilities

Class **Host feature**, removed. `web/src/crypto-host.js` and `crypto-inputs.js` were original
host adapters that kept the host browser's SubtleCrypto for the browser engine, probed its
AES-192 and AES-KW JWK gaps, and bounded its inputs at 2 GiB. The browser engine now uses the
runtime's own WebCrypto provider, the one QuickJS and wasm JSC use, so the adapters are gone.
That provider owns AES-192, AES-KW JWK padding and the 2 GiB input bound on every engine.
No upstream source was copied or changed.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/crypto-host.js`, `crypto-inputs.js` (removed)](#native-crypto-capabilities) | Host feature | Removed with the browser engine's native provider. |

[Ledger scope and pinned revisions](scope.md).
