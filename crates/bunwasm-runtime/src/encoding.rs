//! Byte-level helpers: base64, message digests, checksums.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Standard base64 with padding, or base64url without padding.
pub fn base64_encode(bytes: &[u8], url: bool) -> String {
    let table = if url { URL } else { STD };
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let sextets = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        let keep = chunk.len() + 1;
        for (i, s) in sextets.iter().enumerate() {
            if i < keep {
                out.push(table[*s as usize] as char);
            } else if !url {
                out.push('=');
            }
        }
    }
    out
}

fn sextet(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Forgiving decoder (Node's `Buffer.from(s, "base64")`): accepts both
/// alphabets, skips whitespace and other junk, stops at the first `=`.
pub fn base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = sextet(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn normalize_alg(alg: &str) -> String {
    alg.to_ascii_lowercase().replace('-', "")
}

pub fn digest(alg: &str, data: &[u8]) -> Option<Vec<u8>> {
    let out = match normalize_alg(alg).as_str() {
        "md5" => md5::Md5::digest(data).to_vec(),
        "sha1" => Sha1::digest(data).to_vec(),
        "sha224" => Sha224::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha384" => Sha384::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        _ => return None,
    };
    Some(out)
}

fn mac<M: Mac + hmac::digest::KeyInit>(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <M as hmac::digest::KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

pub fn hmac(alg: &str, key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let out = match normalize_alg(alg).as_str() {
        "md5" => mac::<Hmac<md5::Md5>>(key, data),
        "sha1" => mac::<Hmac<Sha1>>(key, data),
        "sha224" => mac::<Hmac<Sha224>>(key, data),
        "sha256" => mac::<Hmac<Sha256>>(key, data),
        "sha384" => mac::<Hmac<Sha384>>(key, data),
        "sha512" => mac::<Hmac<Sha512>>(key, data),
        _ => return None,
    };
    Some(out)
}

/// Container around deflate data: raw, zlib (RFC 1950) or gzip (RFC 1952).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wrapper {
    Raw,
    Zlib,
    Gzip,
}

impl Wrapper {
    pub fn parse(name: &str) -> Option<Wrapper> {
        match name {
            "raw" | "deflateRaw" => Some(Wrapper::Raw),
            "zlib" | "deflate" => Some(Wrapper::Zlib),
            "gzip" => Some(Wrapper::Gzip),
            _ => None,
        }
    }
}

pub fn compress(data: &[u8], level: u8, wrapper: Wrapper) -> Vec<u8> {
    use miniz_oxide::deflate::{compress_to_vec, compress_to_vec_zlib};
    match wrapper {
        Wrapper::Raw => compress_to_vec(data, level),
        Wrapper::Zlib => compress_to_vec_zlib(data, level),
        Wrapper::Gzip => {
            // Fixed 10-byte header (no name, mtime 0, OS unknown), then the
            // raw stream, CRC-32 and input size, as gzip(1) writes them.
            let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
            out.extend(compress_to_vec(data, level));
            out.extend(crc32(data).to_le_bytes());
            out.extend((data.len() as u32).to_le_bytes());
            out
        }
    }
}

pub fn decompress(data: &[u8], wrapper: Wrapper) -> Result<Vec<u8>, String> {
    use miniz_oxide::inflate::{decompress_to_vec, decompress_to_vec_zlib};
    let result = match wrapper {
        Wrapper::Raw => decompress_to_vec(data),
        Wrapper::Zlib => decompress_to_vec_zlib(data),
        Wrapper::Gzip => return gunzip(data),
    };
    result.map_err(|e| format!("{:?}", e.status))
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 18 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 8 {
        return Err("incorrect header check".to_owned());
    }
    use std::io::Read;
    let mut output = Vec::new();
    flate2::read::MultiGzDecoder::new(data).read_to_end(&mut output).map_err(|e| e.to_string())?;
    Ok(output)
}

pub fn crc32(data: &[u8]) -> u32 {
    crc32_seed(data, 0)
}

pub fn crc32_seed(data: &[u8], seed: u32) -> u32 {
    let mut crc = !seed;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

pub fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let enc = base64_encode(s.as_bytes(), false);
            assert_eq!(base64_decode(&enc), s.as_bytes());
        }
        assert_eq!(base64_encode(b"foob", false), "Zm9vYg==");
        assert_eq!(base64_encode(b"foob", true), "Zm9vYg");
    }

    #[test]
    fn checksums() {
        assert_eq!(crc32(b"hello"), 907060870);
        assert_eq!(adler32(b"hello"), 103547413);
    }

    #[test]
    fn compression_roundtrip() {
        let input = b"hello hello hello hello compression".repeat(20);
        for w in [Wrapper::Raw, Wrapper::Zlib, Wrapper::Gzip] {
            let packed = compress(&input, 6, w);
            assert!(packed.len() < input.len());
            assert_eq!(decompress(&packed, w).unwrap(), input);
        }
    }

    #[test]
    fn wyhash_matches_bun() {
        assert_eq!(bun_wyhash::hash_with_seed(0, b"hello"), 1019145960556548909);
        assert_eq!(bun_wyhash::hash_with_seed(1, b"hello"), 15802777309726279454);
    }
}
