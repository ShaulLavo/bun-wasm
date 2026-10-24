## Certificate regression fixtures

Class **Port**, **copied upstream fixture data** in `tests/fixtures/crypto-x509/`.
The sources are Bun `test/js/node/test/fixtures/keys/{agent1-cert.pem,agent1-key.pem,
ca1-cert.pem,ca2-cert.pem}` and `test/js/node/test/fixtures/x509-escaping/{alt-0-cert.pem,info-2-cert.pem}`
at `cd95fa7a13b3f13be73e512b38ec111c1c228084`.

The PEM bytes are unchanged. `alt-0-cert.pem` is named `escaped-san.pem`, and
`info-2-cert.pem` is named `unknown-access.pem` locally.
They are public test data, including a test private key. The standalone TypeScript fixture
is original and checks the real wasm parser, certificate names, fingerprints, signatures,
KeyObjects, issuer checks and legacy fields on every engine.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Certificate regression fixtures](#certificate-regression-fixtures) | Port | Retain unchanged upstream certificate and test-key data for metadata, signature and escaping checks. |

[Ledger scope and pinned revisions](scope.md).
