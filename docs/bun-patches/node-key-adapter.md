### Node key adapter

Class **Host feature**. The original `crypto_host_keys.js` adapter retains the browser's
native provider and connects its asynchronous keys to synchronous Node key records. It
imports wasm keys into that provider before native operations. Matching native KeyObject
roundtrips retain their native CryptoKey. Secret conversion uses raw material instead of
JWK; RSA signatures reject unsupported padding before dispatch. No upstream implementation
was copied or changed for these corrections.

[Parent context](bun-console-constructor.md).
