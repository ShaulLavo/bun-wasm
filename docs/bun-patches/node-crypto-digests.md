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

`crypto.pbkdf2` and `pbkdf2Sync` come from the original adapter
`crates/bunwasm-runtime/src/js/node_pbkdf2.ts`, following the argument checks of
Node's `lib/internal/crypto/pbkdf2.js` with native Bun 1.4.4's messages: digest
first, then password and salt (string or buffer), then iterations (1 to 2^31 - 1)
and keylen (0 to 2^31 - 1), and for the callback form the callback last, all thrown
synchronously. The digest is any `Bun.CryptoHasher` algorithm that supports HMAC,
as in Bun, so `SHA256`, `sha3-256` and `blake2b512` work while `rsa-sha256`,
`md5-sha1`, SHAKE and BLAKE2s-256 report `Invalid digest`. A zero keylen fails
with `PBKDF2 derivation failed`, thrown by `pbkdf2Sync` and passed to the callback
by `pbkdf2`. The callback runs from the immediate queue in the caller's async
context with exactly `(null, key)`. `node_digest.rs` derives the key through the
`pbkdf2` crate for MD5, SHA-1 and SHA-2 and through an RFC 8018 loop over the
generic HMAC for the rest, and fails a key length the guest cannot allocate with
`RangeError: Out of memory`. `crypto_keys.ts` keeps its earlier WebCrypto-based
`pbkdf2Sync`, which `builtins.js` now shadows: that file is pinned by a syntax
guard in `scripts/crypto-keys.test.ts`. The `node-crypto-pbkdf2` fixture compares
vectors, every digest name and each argument error with native Bun.

`Hash` and `Hmac` objects are Transform streams through the original adapter
`crates/bunwasm-runtime/src/js/crypto_hash_stream.ts`, which follows Node's
`lib/internal/streams/lazy_transform.js`: the prototype chain gains
`stream.Transform.prototype`, and getters for `_readableState`, `_writableState` and
`_transformState` build the stream state from the `createHash`/`createHmac` options
the first time a stream member reads them, with `decodeStrings` off. Writing data
updates the hash, and ending the stream pushes the digest, so `write`/`end`/`read`,
`pipe`, `setEncoding` and the `data` and `readable` events work as in Node and Bun.
`node:stream` is already loaded when `node:crypto` loads, so this adds no startup
work. The `node-crypto-hash-stream` fixture compares these uses with native Bun.

The `node-crypto-digests` fixture compares about 150 names across the three
lookups, long HMAC keys, every hasher HMAC, output lengths, `copy()`, and the eight
classes with native Bun.
