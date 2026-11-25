# Bun.hash algorithms

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/bun_hash/cityhash.rs`, `murmur.rs`, `rapidhash.rs` | Copied upstream files | Bun `src/hash/cityhash.rs`, `src/hash/murmur.rs`, `src/hash/rapidhash.rs` at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/bun_hash/mod.rs` `verify` | Copied upstream code | Bun `src/hash/lib.rs` (`verify::smhasher_32`, `smhasher_64`) at the same revision |
| `crates/bunwasm-runtime/src/bun_hash/mod.rs` `hash` | Adapted upstream implementation | Bun `src/runtime/api/HashObject.rs` (`HashAlgorithm` impls: seed widths and output types) at the same revision |
| `xxhash-rust` dependency for `xxHash32`, `xxHash64` and `xxHash3` | Original adapter | Bun runs these through C++/Highway (`bun_highway`); `xxhash-rust` is a pure-Rust port with bit-identical output |
| `natives.rs` `bunHash`, `bun.js` `hashSeed` and the `Bun.hash.*` functions | Original adapter | Seed handling follows `HashObject.rs` `hash_wrap`: a number or bigint seed is read as u64, anything else is 0 |

The copied files change only their intra-crate paths (`crate::murmur` becomes `super::murmur`, and the test helpers move to `super::super::verify`). Bun's `bun_hash` crate itself cannot be linked, because its xxHash wrapper needs the Highway C++ library. `cityHash32` ignores its seed, as in Bun; `xxHash3` truncates the seed to 32 bits before widening it back, as `HashObject.rs` does.

`cargo test -p bunwasm-runtime bun_hash` runs Bun's SMHasher and rapidhash vectors and compares each algorithm with native Bun 1.4.4 output. The `Bun.hash` check of `tests/fixtures/bun-probe-utils` compares all ten algorithms on every engine.
