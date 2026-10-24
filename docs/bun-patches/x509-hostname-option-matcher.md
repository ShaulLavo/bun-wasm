## X.509 hostname option matcher

Class **Port**, **adapted implementation** in
`crates/bunwasm-runtime/src/x509_hostname.rs` and `x509.rs::check_host`.
The upstream is Bun `src/boringssl/lib.rs`, `match_hostname`,
`openssl_valid_pattern`, `match_dot_subdomain`, and `Bun__X509__checkHost`, at
`cd95fa7a13b3f13be73e512b38ec111c1c228084`.

BoringSSL's pinned headers define ALWAYS_CHECK_SUBJECT, NO_PARTIAL_WILDCARDS,
MULTI_LABEL_WILDCARDS and SINGLE_LABEL_SUBDOMAINS as zero compatibility macros.
Passing OpenSSL's bits to X509_check_host cannot implement these options. Bun
uses a Rust matcher for the same reason. The adaptation retains its OpenSSL
matching path and numeric flags, removes the TLS-only mode and BunString output,
and uses our existing BoringSSL accessors and owned UTF-8 names. SAN parsing
errors suppress subject fallback; an email-only SAN does not suppress a CN
hostname match. The BoringSSL source remains unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [X.509 hostname option matcher](#x509-hostname-option-matcher) | Port | Adapt Bun's OpenSSL-compatible Rust matcher because BoringSSL removed four option behaviors. |

[Ledger scope and pinned revisions](scope.md).
