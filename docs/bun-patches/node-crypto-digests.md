# node:crypto and Bun hasher digests

Class: Adapted implementation (name tables), Original adapter (digests and hasher classes).

Native Bun hashes with BoringSSL. Its `node:crypto` `createHash` looks a name up
in three steps, measured against native Bun 1.4.4 and read from Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`: ncrypto's `getDigestByName` rules in
`src/jsc/bindings/ncrypto.cpp` (`dss1`, and case-insensitive `md5`, `rsa-sha*`,
`sha-*` and a few backward-compatible spellings), then BoringSSL's case-sensitive
`EVP_get_digestbyname` table, then Bun's own case-insensitive hasher map in
`src/runtime/crypto/EVP.rs`. `createHmac` uses only the first two. `Bun.CryptoHasher`
uses only the hasher map.

`crates/bunwasm-runtime/src/js/node_digest.ts` holds the three tables and maps
every accepted name to one of twenty canonical algorithms. The BoringSSL table
was measured by probing native Bun with each candidate name in lower, upper and
original case, since its entries differ from OpenSSL's and AWS-LC's. The module
also validates `options.outputLength` like Node's `validateUint32`, and lists
`crypto.getHashes()` and `Bun.CryptoHasher.algorithms` in Bun's order.

`crates/bunwasm-runtime/src/node_digest.rs` computes the digests with the RustCrypto
crates (`md4`, `md-5`, `sha1`, `sha2`, `sha3`, `blake2`, `ripemd`), with OpenSSL's
MD5-SHA1 as the two digests side by side and SHAKE128 and SHAKE256 defaulting to
16 and 32 bytes. Its HMAC is RFC 2104 over each fixed-size digest's block size.
They are exposed as `native.nodeDigest` and `native.nodeHmac`. WebCrypto, x509 and
the installer keep using `encoding::digest`, so this adds no WebCrypto algorithm.

`node:crypto`'s `Hash` in `builtins.js` now takes canonical names, refuses
`copy()` after `digest()` with `ERR_CRYPTO_HASH_FINALIZED`, and rejects a fixed
digest asked for another output length with BoringSSL's
`NOT_XOF_OR_INVALID_LENGTH`. `copy({ outputLength })` takes its own SHAKE length,
and `copy()` without one goes back to the default, as in Bun. A SHAKE length the
guest's memory cannot hold throws `RangeError: Out of memory` instead of trapping.
An unsupported `createHash` name throws `Digest method not supported` without a
`code`, like Bun's BoringSSL error. `Bun.CryptoHasher` in `bun.js` reports the
canonical name and its `byteLength`, resets after each `digest()`, exposes
`algorithms` as a getter returning a fresh array, and refuses HMAC for SHAKE and
BLAKE2s-256 as Bun does. `Bun.MD4` to `Bun.SHA512_256` are getters that load their
module on first use.

`crates/bunwasm-runtime/src/js/bun_hash_classes.ts` adds `Bun.MD4`, `MD5`, `SHA1`,
`SHA224`, `SHA256`, `SHA384`, `SHA512` and `SHA512_256`: a static `byteLength` and
`hash()`, `update()` and `digest()` into an encoding or a caller's TypedArray,
one digest per instance, and Bun's errors for a second digest, a short target and
a call without `new`.

The `node-crypto-digests` fixture compares about 150 names across the three
lookups, long HMAC keys, every hasher HMAC, output lengths, `copy()`, and the eight
classes with native Bun.
