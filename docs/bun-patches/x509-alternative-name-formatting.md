## X.509 alternative name formatting

Class **Port**, **adapted implementation** in `crates/bunwasm-runtime/src/x509.rs`,
`alternative_name`, `general_name`, `ip_name`, and extension-list formatting.
The upstream source is Bun `src/jsc/bindings/ncrypto.cpp`, `IsSafeAltName`, `PrintAltName`,
`PrintGeneralName`, `SafeX509SubjectAltNamePrint`, and `SafeX509InfoAccessPrint` at
`cd95fa7a13b3f13be73e512b38ec111c1c228084`, inherited from Node's ncrypto.

The Rust translation uses BoringSSL accessors and owned strings instead of C++ BIO
writers and JSC strings. It retains JSON-compatible quoting for names containing commas,
quotes, controls or non-ASCII IA5 bytes. Distinguished names keep UTF-8. This prevents one
certificate name from looking like multiple alternative names. BoringSSL's unsupported
otherName, X400 and EDI names retain the upstream unsupported descriptions.

`third_party/licenses/node-X509-LICENSE` retains the Node and Joyent MIT notices.
The two license sections are copied unchanged from Node v26.7.0 `LICENSE`; no Node
implementation is taken from that version.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [X.509 alternative name formatting and Node license](#x509-alternative-name-formatting) | Port | Translate Bun and Node certificate-name quoting to Rust without JSC and retain the Node MIT notices. |
