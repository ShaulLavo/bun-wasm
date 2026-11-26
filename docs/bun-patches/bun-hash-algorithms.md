# Bun.hash algorithms

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/bun_hash/cityhash.rs`, `murmur.rs`, `rapidhash.rs` | Copied upstream files | Bun `src/hash/cityhash.rs`, `src/hash/murmur.rs`, `src/hash/rapidhash.rs` at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/bun_hash/mod.rs` `verify` | Copied upstream code | Bun `src/hash/lib.rs` (`verify::smhasher_32`, `smhasher_64`) at the same revision |
| `crates/bunwasm-runtime/src/bun_hash/mod.rs` `hash` | Adapted upstream implementation | Bun `src/runtime/api/HashObject.rs` (`HashAlgorithm` impls: seed widths and output types) at the same revision |
| `xxhash-rust` dependency for `xxHash32`, `xxHash64` and `xxHash3` | Original adapter | Bun runs these through C++/Highway (`bun_highway`); `xxhash-rust` is a pure-Rust port with bit-identical output |
| `natives.rs` `bunHash`, `wyhash`, `bun.js` `hashData`, `hashSeed` and the `Bun.hash.*` functions | Original adapter | Input and seed handling follow `HashObject.rs` `hash_wrap` (see below) |

The copied files change only their intra-crate paths (`crate::murmur` becomes `super::murmur`, and the test helpers move to `super::super::verify`). Bun's `bun_hash` crate itself cannot be linked, because its xxHash wrapper needs the Highway C++ library. `cityHash32` ignores its seed, as in Bun; `xxHash3` truncates the seed to 32 bits before widening it back, as `HashObject.rs` does.

`cargo test -p bunwasm-runtime bun_hash` runs Bun's SMHasher and rapidhash vectors and compares each algorithm with native Bun 1.4.4 output. The `Bun.hash` check of `tests/fixtures/bun-probe-utils` compares all ten algorithms on every engine.

Every `Bun.hash` function reads its input as `hash_wrap` does: a string as UTF-8, an ArrayBuffer or view as its bytes, an in-memory Blob as its bytes, and any other value as its string form; a missing value (or `null`) and a file-backed Blob throw `ERR_INVALID_ARG_TYPE`. The seed follows JSC's `toUInt64NoTruncate`, measured against native Bun 1.4.4: a bigint wraps to 64 bits; a finite number truncates toward zero and wraps to 64 bits (so every negative number wraps, and -2^64 is 0), except that it saturates at 2^64 - 1 from 2^64 up and at `Infinity`; NaN, `-Infinity` and any other value are 0. The seed reaches the natives as two 32-bit words, so `wyhash` keeps all 64 bits; `crc32` continues from the low 32 bits, and `adler32` takes none.
