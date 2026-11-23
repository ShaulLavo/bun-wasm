### Node key adapter

Class **Host feature**, removed. The original `crypto_host_keys.ts` adapter connected the
browser's native SubtleCrypto keys to synchronous Node key records. The browser engine now
uses the runtime's own WebCrypto provider, so KeyObject conversion works on the provider's
own key records on every engine and the adapter is gone. Secret conversion uses raw material
instead of JWK; RSA signatures reject unsupported padding before dispatch
(`crypto_keys.ts`). No upstream implementation was copied or changed.

[Parent context](bun-console-constructor.md).

[Ledger scope and pinned revisions](scope.md).
