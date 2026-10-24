### Certificate check-option regression fixtures

`tests/fixtures/crypto-x509-options/{names,email-only}.pem` are original self-signed
P-256 certificates generated with OpenSSL. They contain a
fallback common name and either DNS/email SANs or an email-only SAN. No upstream
source or production certificate is copied. The generation key is disposable;
only the public certificates are retained. The fixture runs unchanged on Bun and
Node and covers the five hostname options and standalone issuer metadata.


[Parent context](certificate-regression-fixtures.md).

[Ledger scope and pinned revisions](scope.md).
