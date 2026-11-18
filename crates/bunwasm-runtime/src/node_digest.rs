//! Message digests for node:crypto `createHash`/`createHmac` and `Bun.CryptoHasher`,
//! by canonical algorithm name. The runtime's `node_digest.ts` maps the names
//! Node and Bun accept onto these. WebCrypto keeps using `encoding::digest`.

use sha2::digest::{Digest, ExtendableOutput, Update, XofReader};

pub enum DigestError {
    Unsupported,
    /// A fixed-size digest asked for a different output length.
    NotXof,
    /// A SHAKE output length the linear memory cannot hold.
    OutOfMemory,
}

fn fixed<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
    let mut hasher = D::new();
    for part in parts {
        Digest::update(&mut hasher, part);
    }
    hasher.finalize().to_vec()
}

fn xof<D: Default + Update + ExtendableOutput>(
    parts: &[&[u8]],
    len: usize,
) -> Result<Vec<u8>, DigestError> {
    let mut hasher = D::default();
    for part in parts {
        hasher.update(part);
    }
    // A caller may ask for up to 2^32 - 1 bytes; fail instead of trapping on allocation.
    let mut out = Vec::new();
    out.try_reserve_exact(len)
        .map_err(|_| DigestError::OutOfMemory)?;
    out.resize(len, 0);
    hasher.finalize_xof().read(&mut out);
    Ok(out)
}

fn fixed_digest(alg: &str, parts: &[&[u8]]) -> Option<Vec<u8>> {
    let out = match alg {
        "md4" => fixed::<md4::Md4>(parts),
        "md5" => fixed::<md5::Md5>(parts),
        // OpenSSL's MD5-SHA1: the two digests side by side (TLS 1.0 and 1.1 signatures).
        "md5-sha1" => {
            let mut out = fixed::<md5::Md5>(parts);
            out.extend(fixed::<sha1::Sha1>(parts));
            out
        }
        "sha1" => fixed::<sha1::Sha1>(parts),
        "sha224" => fixed::<sha2::Sha224>(parts),
        "sha256" => fixed::<sha2::Sha256>(parts),
        "sha384" => fixed::<sha2::Sha384>(parts),
        "sha512" => fixed::<sha2::Sha512>(parts),
        "sha512-224" => fixed::<sha2::Sha512_224>(parts),
        "sha512-256" => fixed::<sha2::Sha512_256>(parts),
        "sha3-224" => fixed::<sha3::Sha3_224>(parts),
        "sha3-256" => fixed::<sha3::Sha3_256>(parts),
        "sha3-384" => fixed::<sha3::Sha3_384>(parts),
        "sha3-512" => fixed::<sha3::Sha3_512>(parts),
        "blake2b256" => fixed::<blake2::Blake2b<blake2::digest::consts::U32>>(parts),
        "blake2b512" => fixed::<blake2::Blake2b512>(parts),
        "blake2s256" => fixed::<blake2::Blake2s256>(parts),
        "ripemd160" => fixed::<ripemd::Ripemd160>(parts),
        _ => return None,
    };
    Some(out)
}

/// The digest of `parts` joined. `output_len` sets a SHAKE output length (default
/// 16 bytes for SHAKE128 and 32 for SHAKE256, as in OpenSSL); for a fixed-size
/// digest it must equal the digest size.
pub fn digest(
    alg: &str,
    parts: &[&[u8]],
    output_len: Option<usize>,
) -> Result<Vec<u8>, DigestError> {
    match alg {
        "shake128" => return xof::<sha3::Shake128>(parts, output_len.unwrap_or(16)),
        "shake256" => return xof::<sha3::Shake256>(parts, output_len.unwrap_or(32)),
        _ => {}
    }
    let out = fixed_digest(alg, parts).ok_or(DigestError::Unsupported)?;
    match output_len {
        Some(len) if len != out.len() => Err(DigestError::NotXof),
        _ => Ok(out),
    }
}

fn block_size(alg: &str) -> Option<usize> {
    Some(match alg {
        "md4" | "md5" | "md5-sha1" | "sha1" | "sha224" | "sha256" | "ripemd160" | "blake2s256" => {
            64
        }
        "sha384" | "sha512" | "sha512-224" | "sha512-256" | "blake2b256" | "blake2b512" => 128,
        "sha3-224" => 144,
        "sha3-256" => 136,
        "sha3-384" => 104,
        "sha3-512" => 72,
        _ => return None,
    })
}

/// An RFC 2104 HMAC key: the inner and outer padded keys for one digest.
struct HmacKey<'a> {
    alg: &'a str,
    ipad: Vec<u8>,
    opad: Vec<u8>,
}

impl<'a> HmacKey<'a> {
    fn new(alg: &'a str, key: &[u8]) -> Option<Self> {
        let block = block_size(alg)?;
        let hashed;
        let key = if key.len() > block {
            hashed = fixed_digest(alg, &[key])?;
            hashed.as_slice()
        } else {
            key
        };
        let mut ipad = vec![0x36u8; block];
        let mut opad = vec![0x5cu8; block];
        for (i, byte) in key.iter().enumerate() {
            ipad[i] ^= byte;
            opad[i] ^= byte;
        }
        Some(HmacKey { alg, ipad, opad })
    }

    fn mac(&self, parts: &[&[u8]]) -> Option<Vec<u8>> {
        let mut inner_parts = Vec::with_capacity(parts.len() + 1);
        inner_parts.push(self.ipad.as_slice());
        inner_parts.extend_from_slice(parts);
        let inner = fixed_digest(self.alg, &inner_parts)?;
        fixed_digest(self.alg, &[&self.opad, &inner])
    }
}

/// RFC 2104 HMAC over any fixed-size digest above; `None` for SHAKE and unknown names.
pub fn hmac(alg: &str, key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    HmacKey::new(alg, key)?.mac(&[data])
}

/// RFC 8018 PBKDF2 with HMAC over `alg`. The common digests use the `pbkdf2` crate;
/// the others iterate the generic HMAC above.
pub fn pbkdf2(
    alg: &str,
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    keylen: usize,
) -> Result<Vec<u8>, DigestError> {
    let mut out = Vec::new();
    out.try_reserve_exact(keylen)
        .map_err(|_| DigestError::OutOfMemory)?;
    out.resize(keylen, 0);
    macro_rules! fast {
        ($d:ty) => {{
            pbkdf2::pbkdf2_hmac::<$d>(password, salt, iterations, &mut out);
            return Ok(out);
        }};
    }
    match alg {
        "md5" => fast!(md5::Md5),
        "sha1" => fast!(sha1::Sha1),
        "sha256" => fast!(sha2::Sha256),
        "sha384" => fast!(sha2::Sha384),
        "sha512" => fast!(sha2::Sha512),
        _ => {}
    }
    let key = HmacKey::new(alg, password).ok_or(DigestError::Unsupported)?;
    let mut written = 0;
    let mut index: u32 = 1;
    while written < keylen {
        let mut block = key
            .mac(&[salt, &index.to_be_bytes()])
            .ok_or(DigestError::Unsupported)?;
        let mut sum = block.clone();
        for _ in 1..iterations {
            block = key.mac(&[&block]).ok_or(DigestError::Unsupported)?;
            for (total, byte) in sum.iter_mut().zip(&block) {
                *total ^= byte;
            }
        }
        let take = (keylen - written).min(sum.len());
        out[written..written + take].copy_from_slice(&sum[..take]);
        written += take;
        index += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn known_digests() {
        let abc: &[&[u8]] = &[b"abc"];
        let check = |alg: &str, prefix: &str| {
            let out = digest(alg, abc, None).ok().expect("supported");
            assert!(hex(&out).starts_with(prefix), "{alg}: {}", hex(&out));
        };
        check("md4", "a448017aaf21");
        check("sha512-224", "4634270f707b");
        check("sha3-256", "3a985da74fe2");
        check("shake256", "483366601360");
        check("blake2b256", "bddd813c6342");
        check("blake2s256", "508c5e8c327c");
        check("ripemd160", "8eb208f7e05d");
        assert_eq!(
            digest("shake128", abc, Some(40)).ok().map(|out| out.len()),
            Some(40)
        );
        assert!(matches!(
            digest("sha256", abc, Some(16)),
            Err(DigestError::NotXof)
        ));
        assert!(matches!(
            digest("sm3", abc, None),
            Err(DigestError::Unsupported)
        ));
    }

    #[test]
    fn known_hmacs() {
        let check = |alg: &str, expected: &str| {
            assert_eq!(
                hex(&hmac(alg, b"key", b"abc").expect("supported")),
                expected,
                "{alg}"
            );
        };
        check(
            "sha3-256",
            "09b6dbab8d11795ca7c8d82f1cf91682013c7cb980abbb25473be4ae7f7b5683",
        );
        check(
            "md5-sha1",
            "a76e5cc4bdaa99b87cc7de69e0606e7d74fd2771909f120bb3b9a4649bb99bea2b4cec32",
        );
        check("ripemd160", "67fdce738ebfc7372bcd38f03c023b5746724d18");
        check("md4", "32c43d6d6eda7f1e464711473b956b68");
        check(
            "sha512-224",
            "28bc0433ef684ea9877c2f2437aa0ccfc2e8eb3a9b4c731606877b4f",
        );
        assert_eq!(hmac("shake128", b"key", b"abc"), None);
    }

    #[test]
    fn known_pbkdf2() {
        let check = |alg: &str, expected: &str| {
            let out = pbkdf2(alg, b"p", b"s", 2, 8).ok().expect("supported");
            assert_eq!(hex(&out), expected, "{alg}");
        };
        // Native Bun 1.4.4 output; the first uses the crate, the rest the generic loop.
        check("md5", "c9641e374bfab772");
        check("sha3-256", "d15fbbb4c04a81cc");
        check("blake2b256", "ab46b45423284e1e");
        check("md4", "fb666dd1e5c3a7d9");
        check("sha512-224", "cc69191b8129012e");
        check("ripemd160", "332c478ecdc03e9f");
        // RFC 6070 test vector 2 (SHA-1, two iterations).
        let rfc = pbkdf2("sha1", b"password", b"salt", 2, 20)
            .ok()
            .expect("sha1");
        assert_eq!(hex(&rfc), "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
        assert!(matches!(
            pbkdf2("shake128", b"p", b"s", 1, 8),
            Err(DigestError::Unsupported)
        ));
    }
}
