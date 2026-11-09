# Exact wasi-threads instance-proxy fixture

Classification: copied upstream test input, with an original extraction adapter.
No package or production implementation is replaced.

The input is @emnapi/wasi-threads 2.2.0, the exact version in the maintained Vite
starter's binding graph. The package archive SHA-256 is
f4c934b40a8a60763115a1da4e570fc8f2a549f9c0fac468c6a91169a154e110.
Its package/dist/wasi-threads.js proxy.ts region is copied byte-for-byte into
tests/fixtures/shared-wasm-memory/instance-proxy.js, with only an attribution
header and ESM export appended. The upstream MIT notice is retained beside it.
The file is classified as a deliberate JavaScript runtime input, not legacy
handwritten source. This preserves the exact dependency's Proxy behavior rather
than imitating it with a mock.

scripts/wasi-instance-proxy-fixture.ts is an original host extraction adapter.
It validates the exact archive, complete source and generated output hashes,
then extracts only that region and license. Run it with the exact package tarball
as its argument; it performs no download, install or compiler build. Its offline
quality check pins the output and rejects a changed upstream input.

Source-owned and real group-guest tests exercise native Instance.exports
descriptors, canonical frozen exports, the exact proxy and child WASI reactor
initialization. They do not execute the actual binding, NAPI registration,
wasi.thread-spawn or pool behavior.
