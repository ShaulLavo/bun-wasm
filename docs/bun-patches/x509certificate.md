## X509Certificate

Class **Host feature**, **original adapters** in `crates/bunwasm-crypto-sys/src/x509.rs`,
`crates/bunwasm-runtime/src/x509.rs` except the adapted portions below,
`src/js/x509.ts`, the native table and the Node crypto registry.

BoringSSL remains pinned by `scripts/sync-crypto.sh` to
`41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`. The Rust declarations call its existing
certificate, name, extension, key and signature functions declared in `include/openssl/`
`{x509,asn1,evp,bio,obj,stack,mem,err}.h`. These declarations contain no
copied implementation. Certificates retain owned DER bytes. Checks parse those bytes and
release their native allocations on every return. Public keys use the existing Node
KeyObject implementation via a SPKI export. No new host slot is used.

Bun's `src/js/node/crypto.ts` exports its native X509Certificate binding. That binding lives
in `src/jsc/bindings/JSX509Certificate*.cpp`, so it cannot be loaded as an engine-independent
JavaScript wrapper. The new TypeScript wrapper implements the same public certificate
contract using the shared native table.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [X509Certificate adapters](#x509certificate) | Host feature | Original BoringSSL data bindings and Node certificate wrapper over existing KeyObjects. |
