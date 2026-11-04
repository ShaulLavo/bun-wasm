# Bundled guest TLS roots

Classification: copied upstream data and adapted bundle-format reader.

The binary `crates/bunwasm-runtime/data/tls-roots.der` is copied unchanged from
`oven-sh/bun` commit `9510e74152073d850a18758ca41114d8f214ffa6`, path
`packages/bun-usockets/root_certs.der`. It contains 121 roots in 129,635 bytes.
Its SHA-256 is
`9c211f519356eff61365ff890856135b1b8ee298775b144ce6089782ae603f90`.
The import reads the exact Git object, not the mutable vendor working tree.

`tls-roots.source.json` records the pin, digest, source-file digests, import
date, and license notice. Bun's `root_certs.txt` identifies Mozilla NSS
`certdata.txt`, filtered to certificates trusted for TLS server authentication.
The pinned `certdata.txt` carries the Mozilla Public License 2.0 notice retained
in the provenance file. The generator's curl-derived Perl source has its own
curl notice. No generator code is copied here. The inspected snapshot does not
establish a precise NSS release, and the provenance makes no such claim.

## Format and validation

The reader in `src/tls/trust.rs` adapts the format documented by Bun's
`src/runtime/socket/bundled_root_certs.rs`. It reads a little-endian count,
`count + 1` little-endian offsets, and concatenated DER certificates. All offsets
must increase within the payload and consume it exactly.

The original verifier `scripts/tls-roots.ts` checks bounds, complete DER
structure and certificate decoding, the CA marker, root count, exact digest,
and provenance. `--upstream EXISTING_BUN_ODB` additionally checks the binary and
all recorded source files against the exact pinned Git objects. It neither
fetches sources nor refreshes certificates.

The roots stay in immutable static memory. The first default TLS context
constructs one process-local `X509_LAZY_CERT_SET_new_static` set. Stores take
references through the pinned `X509_STORE_add_lazy_cert_set` API. Certificates
are parsed on issuer lookup, not all at process startup. No PEM root list is
serialized through JavaScript.

Default trust is the bundled set plus a valid startup-snapshotted guest
`NODE_EXTRA_CA_CERTS` byte array. Invalid or unavailable extras contribute no
trust and produce one bounded warning. The native API accepts no extra-CA path
and performs no host filesystem read. Explicit `ca` replaces all defaults,
including when it is an empty array.

## Update ownership

TLS maintainers check Bun and NSS trust changes at each release and at least
monthly during active development. Distrust and removal changes need a prompt,
reviewed source update with added and removed fingerprints and renewed
provenance. The release owner schedules that source update for publication.
A timestamp-only edit is not a trust refresh. Builds never run Bun's
latest-NSS generator automatically.

This snapshot is not the browser's live trust store. A private generated CA
only tests explicit or extra trust. It does not qualify bundled public roots.
