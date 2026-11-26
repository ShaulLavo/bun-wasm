//! The `Bun.hash` algorithms beyond wyhash, crc32 and adler32, following Bun's
//! `src/runtime/api/HashObject.rs` (docs/bun-patches/bun-hash-algorithms.md).
//! `cityhash.rs`, `murmur.rs` and `rapidhash.rs` are copied from Bun's `src/hash`; Bun runs
//! xxHash through C++/Highway, so this port uses the pure-Rust `xxhash-rust` crate, which
//! gives bit-identical output.

#![allow(clippy::many_single_char_names)]
mod cityhash;
mod murmur;
mod rapidhash;

use cityhash::{CityHash32, CityHash64};
use murmur::{Murmur2_32, Murmur2_64, Murmur3_32};
use rapidhash::RapidHash;

pub(crate) enum Output {
    U32(u32),
    U64(u64),
}

/// `seed` arrives as Bun's u64; each algorithm truncates it to its own width, as in Bun.
pub(crate) fn hash(name: &str, input: &[u8], seed: u64) -> Option<Output> {
    Some(match name {
        "cityHash32" => Output::U32(CityHash32::hash(input)),
        "cityHash64" => Output::U64(CityHash64::hash_with_seed(input, seed)),
        "xxHash32" => Output::U32(xxhash_rust::xxh32::xxh32(input, seed as u32)),
        "xxHash64" => Output::U64(xxhash_rust::xxh64::xxh64(input, seed)),
        "xxHash3" => Output::U64(xxhash_rust::xxh3::xxh3_64_with_seed(
            input,
            u64::from(seed as u32),
        )),
        "murmur32v2" => Output::U32(Murmur2_32::hash_with_seed(input, seed as u32)),
        "murmur32v3" => Output::U32(Murmur3_32::hash_with_seed(input, seed as u32)),
        "murmur64v2" => Output::U64(Murmur2_64::hash_with_seed(input, seed)),
        "rapidhash" => Output::U64(RapidHash::hash(seed, input)),
        _ => return None,
    })
}

#[cfg(test)]
pub(crate) mod verify {
    //! Bun's SMHasher verification routine (src/hash/lib.rs).

    pub(crate) fn smhasher_32(hash: impl Fn(&[u8], u32) -> u32) -> u32 {
        let mut buf = [0u8; 256];
        let mut buf_all = [0u8; 256 * 4];
        for i in 0..256u32 {
            buf[i as usize] = i as u8;
            let h = hash(&buf[..i as usize], 256 - i);
            buf_all[i as usize * 4..i as usize * 4 + 4].copy_from_slice(&h.to_le_bytes());
        }
        hash(&buf_all, 0)
    }

    pub(crate) fn smhasher_64(hash: impl Fn(&[u8], u64) -> u64) -> u32 {
        let mut buf = [0u8; 256];
        let mut buf_all = [0u8; 256 * 8];
        for i in 0..256u64 {
            buf[i as usize] = i as u8;
            let h = hash(&buf[..i as usize], 256 - i);
            buf_all[i as usize * 8..i as usize * 8 + 8].copy_from_slice(&h.to_le_bytes());
        }
        hash(&buf_all, 0) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::{Output, hash};

    fn value(name: &str, seed: u64) -> u64 {
        match hash(name, b"bun", seed).unwrap() {
            Output::U32(n) => u64::from(n),
            Output::U64(n) => n,
        }
    }

    /// Native Bun 1.4.4 output for "bun" with seed 0.
    #[test]
    fn matches_native_bun() {
        assert_eq!(value("cityHash64", 0), 6906495099114325215);
        assert_eq!(value("xxHash32", 0), 1235554422);
        assert_eq!(value("xxHash64", 0), 15609765314684665588);
        assert_eq!(value("xxHash3", 0), 17829677933038192631);
        assert_eq!(value("murmur32v3", 0), 2628747375);
        assert_eq!(value("murmur64v2", 0), 18075925927743871885);
    }
}
