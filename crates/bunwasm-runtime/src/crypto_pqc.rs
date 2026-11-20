//! WebCrypto ML-KEM, ML-DSA and ChaCha20-Poly1305 over the BoringSSL the guest already
//! links (`crates/bunwasm-crypto-sys/c/pqc.c`). Keys travel as AKP JWK, as Bun exports
//! them: `pub` is the encoded public key and `priv` the FIPS seed. SPKI and PKCS#8 use
//! the algorithm OIDs with no parameters, and PKCS#8 holds only the seed (`[0]`), the
//! form native Bun 1.4.4 writes.
use bunwasm_crypto_sys::pqc::*;
use pkcs8::der::{Decode, Encode};
use serde_json::{Value as J, json};

type Result<T> = std::result::Result<T, &'static str>;

/// An ML-KEM or ML-DSA parameter set: its WebCrypto name, adapter kind and OID.
#[derive(Clone, Copy)]
pub(crate) struct Algorithm {
    pub name: &'static str,
    kind: i32,
    oid: &'static str,
}

const ALGORITHMS: [Algorithm; 5] = [
    Algorithm {
        name: "ML-KEM-768",
        kind: 0,
        oid: "2.16.840.1.101.3.4.4.2",
    },
    Algorithm {
        name: "ML-KEM-1024",
        kind: 1,
        oid: "2.16.840.1.101.3.4.4.3",
    },
    Algorithm {
        name: "ML-DSA-44",
        kind: 2,
        oid: "2.16.840.1.101.3.4.3.17",
    },
    Algorithm {
        name: "ML-DSA-65",
        kind: 3,
        oid: "2.16.840.1.101.3.4.3.18",
    },
    Algorithm {
        name: "ML-DSA-87",
        kind: 4,
        oid: "2.16.840.1.101.3.4.3.19",
    },
];

pub(crate) fn algorithm(name: &str) -> Option<Algorithm> {
    ALGORITHMS.into_iter().find(|a| a.name == name)
}

impl Algorithm {
    fn size(self, what: i32) -> usize {
        // SAFETY: a pure table lookup.
        unsafe { bunwasm_pqc_size(self.kind, what) }
    }
    fn public_size(self) -> usize {
        self.size(0)
    }
    fn seed_size(self) -> usize {
        self.size(1)
    }
    /// Ciphertext for ML-KEM, signature for ML-DSA.
    fn output_size(self) -> usize {
        self.size(2)
    }
    fn public_from_seed(self, seed: &[u8]) -> Result<Vec<u8>> {
        if seed.len() != self.seed_size() {
            return Err("DataError");
        }
        let mut public = vec![0; self.public_size()];
        // SAFETY: the adapter reads `seed` and writes exactly `public.len()` bytes.
        let ok = unsafe {
            bunwasm_pqc_public(
                self.kind,
                seed.as_ptr(),
                seed.len(),
                public.as_mut_ptr(),
                public.len(),
            )
        };
        if ok != 1 {
            return Err("DataError");
        }
        Ok(public)
    }
    fn alg_id(self) -> Result<pkcs8::ObjectIdentifier> {
        pkcs8::ObjectIdentifier::new(self.oid).map_err(|_| "OperationError")
    }
}

fn b64(b: &[u8]) -> String {
    crate::encoding::base64_encode(b, true)
}

/// The AKP JWK for a key: `priv` (the seed) only for a private key.
fn jwk(a: Algorithm, public: &[u8], seed: Option<&[u8]>) -> J {
    let mut k = json!({"kty": "AKP", "alg": a.name, "pub": b64(public)});
    if let Some(seed) = seed {
        k["priv"] = b64(seed).into();
    }
    k
}

/// A key's public bytes and seed from its JWK record.
pub(crate) struct Parts {
    pub public: Vec<u8>,
    pub seed: Option<Vec<u8>>,
}

impl Drop for Parts {
    fn drop(&mut self) {
        if let Some(seed) = self.seed.as_mut() {
            crate::crypto_ec::wipe(seed);
        }
    }
}

pub(crate) fn generate(a: Algorithm) -> Result<J> {
    let mut seed = vec![0; a.seed_size()];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut seed);
    let public = a.public_from_seed(&seed).map_err(|_| "OperationError")?;
    let k = jwk(a, &public, Some(&seed));
    crate::crypto_ec::wipe(&mut seed);
    Ok(k)
}

/// Imports `b` in `format` (`jwk` takes decoded parts) and answers the canonical JWK.
pub(crate) fn import(a: Algorithm, format: &str, b: &[u8], parts: Option<&Parts>) -> Result<J> {
    match format {
        "raw-public" => {
            if b.len() != a.public_size() {
                return Err("DataError");
            }
            Ok(jwk(a, b, None))
        }
        "raw-seed" => Ok(jwk(a, &a.public_from_seed(b)?, Some(b))),
        "spki" => {
            let info = spki::SubjectPublicKeyInfoRef::try_from(b).map_err(|_| "DataError")?;
            if info.algorithm.oid != a.alg_id()? {
                return Err(crate::crypto::KEY_TYPE);
            }
            let public = info.subject_public_key.as_bytes().ok_or("DataError")?;
            if info.algorithm.parameters.is_some() || public.len() != a.public_size() {
                return Err("DataError");
            }
            Ok(jwk(a, public, None))
        }
        "pkcs8" => {
            let info = pkcs8::PrivateKeyInfo::from_der(b).map_err(|_| "DataError")?;
            if info.algorithm.oid != a.alg_id()? {
                return Err(crate::crypto::KEY_TYPE);
            }
            // The seed form: [0] IMPLICIT OCTET STRING, short length.
            let inner = info.private_key;
            if info.algorithm.parameters.is_some()
                || inner.len() != a.seed_size() + 2
                || inner[0] != 0x80
                || usize::from(inner[1]) != a.seed_size()
            {
                return Err("DataError");
            }
            let seed = &inner[2..];
            Ok(jwk(a, &a.public_from_seed(seed)?, Some(seed)))
        }
        "jwk" => {
            let parts = parts.ok_or("DataError")?;
            let Some(seed) = parts.seed.as_deref() else {
                if parts.public.len() != a.public_size() {
                    return Err("DataError");
                }
                return Ok(jwk(a, &parts.public, None));
            };
            // Bun refuses a private JWK whose "pub" is not the seed's public key.
            let public = a.public_from_seed(seed)?;
            if public != parts.public {
                return Err("DataError");
            }
            Ok(jwk(a, &public, Some(seed)))
        }
        _ => Err("NotSupportedError"),
    }
}

pub(crate) fn export(a: Algorithm, format: &str, k: &Parts) -> Result<Vec<u8>> {
    let alg = pkcs8::AlgorithmIdentifierRef {
        oid: a.alg_id()?,
        parameters: None,
    };
    match format {
        "spki" => spki::SubjectPublicKeyInfoRef {
            algorithm: alg,
            subject_public_key: pkcs8::der::asn1::BitStringRef::from_bytes(&k.public)
                .map_err(|_| "OperationError")?,
        }
        .to_der()
        .map_err(|_| "OperationError"),
        "pkcs8" => {
            let seed = k.seed.as_deref().ok_or("InvalidAccessError")?;
            let mut inner = vec![
                0x80,
                u8::try_from(seed.len()).map_err(|_| "OperationError")?,
            ];
            inner.extend_from_slice(seed);
            let der = pkcs8::PrivateKeyInfo::new(alg, &inner)
                .to_der()
                .map_err(|_| "OperationError");
            crate::crypto_ec::wipe(&mut inner);
            der
        }
        _ => Err("NotSupportedError"),
    }
}

pub(crate) fn sign(a: Algorithm, k: &Parts, data: &[u8], context: &[u8]) -> Result<Vec<u8>> {
    let seed = k.seed.as_deref().ok_or("InvalidAccessError")?;
    let mut sig = vec![0; a.output_size()];
    // SAFETY: the adapter reads each input slice and writes exactly the signature size.
    let ok = unsafe {
        bunwasm_mldsa_sign(
            a.kind,
            seed.as_ptr(),
            seed.len(),
            data.as_ptr(),
            data.len(),
            context.as_ptr(),
            context.len(),
            sig.as_mut_ptr(),
        )
    };
    if ok != 1 {
        return Err("OperationError");
    }
    Ok(sig)
}

pub(crate) fn verify(a: Algorithm, k: &Parts, data: &[u8], sig: &[u8], context: &[u8]) -> bool {
    // SAFETY: the adapter only reads the slices.
    unsafe {
        bunwasm_mldsa_verify(
            a.kind,
            k.public.as_ptr(),
            k.public.len(),
            sig.as_ptr(),
            sig.len(),
            data.as_ptr(),
            data.len(),
            context.as_ptr(),
            context.len(),
        ) == 1
    }
}

/// (shared secret, ciphertext).
pub(crate) fn encapsulate(a: Algorithm, k: &Parts) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut ct = vec![0; a.output_size()];
    let mut ss = vec![0; 32];
    // SAFETY: the adapter reads the public key and writes the ciphertext and 32-byte secret.
    let ok = unsafe {
        bunwasm_mlkem_encap(
            a.kind,
            k.public.as_ptr(),
            k.public.len(),
            ct.as_mut_ptr(),
            ss.as_mut_ptr(),
        )
    };
    if ok != 1 {
        return Err("OperationError");
    }
    Ok((ss, ct))
}

pub(crate) fn decapsulate(a: Algorithm, k: &Parts, ct: &[u8]) -> Result<Vec<u8>> {
    let seed = k.seed.as_deref().ok_or("InvalidAccessError")?;
    let mut ss = vec![0; 32];
    // SAFETY: the adapter reads the seed and ciphertext and writes the 32-byte secret.
    let ok = unsafe {
        bunwasm_mlkem_decap(
            a.kind,
            seed.as_ptr(),
            seed.len(),
            ct.as_ptr(),
            ct.len(),
            ss.as_mut_ptr(),
        )
    };
    if ok != 1 {
        return Err("OperationError");
    }
    Ok(ss)
}

/// ChaCha20-Poly1305 with a 16-byte tag after the ciphertext.
pub(crate) fn chacha20_poly1305(
    key: &[u8],
    iv: &[u8],
    ad: &[u8],
    input: &[u8],
    encrypt: bool,
) -> Result<Vec<u8>> {
    if !encrypt && input.len() < 16 {
        return Err("OperationError");
    }
    let mut out = vec![0; input.len() + 16];
    let mut len = out.len();
    // SAFETY: the adapter reads each input slice and writes at most `len` bytes.
    let ok = unsafe {
        bunwasm_chacha20_poly1305(
            i32::from(encrypt),
            key.as_ptr(),
            key.len(),
            iv.as_ptr(),
            iv.len(),
            ad.as_ptr(),
            ad.len(),
            input.as_ptr(),
            input.len(),
            out.as_mut_ptr(),
            &mut len,
        )
    };
    if ok != 1 {
        return Err("OperationError");
    }
    out.truncate(len);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(k: &J) -> Parts {
        let field = |name: &str| k[name].as_str().map(crate::encoding::base64_decode);
        Parts {
            public: field("pub").unwrap(),
            seed: field("priv"),
        }
    }

    #[test]
    fn every_parameter_set_round_trips_and_works() {
        for a in ALGORITHMS {
            let private = generate(a).unwrap();
            let k = parts(&private);
            assert_eq!(k.public.len(), a.public_size(), "{}", a.name);
            let public = Parts {
                public: k.public.clone(),
                seed: None,
            };
            let mut public_jwk = private.clone();
            public_jwk.as_object_mut().unwrap().remove("priv");
            let pkcs8 = export(a, "pkcs8", &k).unwrap();
            assert_eq!(
                import(a, "pkcs8", &pkcs8, None).unwrap(),
                private,
                "{}",
                a.name
            );
            let spki = export(a, "spki", &public).unwrap();
            assert_eq!(
                import(a, "spki", &spki, None).unwrap(),
                public_jwk,
                "{}",
                a.name
            );
            assert_eq!(
                import(a, "raw-seed", k.seed.as_deref().unwrap(), None).unwrap(),
                private
            );
            if a.name.starts_with("ML-KEM") {
                let (ss, ct) = encapsulate(a, &public).unwrap();
                assert_eq!(decapsulate(a, &k, &ct).unwrap(), ss);
            } else {
                let sig = sign(a, &k, b"data", b"ctx").unwrap();
                assert!(verify(a, &public, b"data", &sig, b"ctx"));
                assert!(!verify(a, &public, b"data", &sig, b""));
            }
        }
    }

    #[test]
    fn a_jwk_whose_pub_does_not_match_its_seed_is_refused() {
        let a = algorithm("ML-DSA-44").unwrap();
        let k = parts(&generate(a).unwrap());
        let other = parts(&generate(a).unwrap());
        let mixed = Parts {
            public: other.public.clone(),
            seed: k.seed.clone(),
        };
        assert_eq!(import(a, "jwk", &[], Some(&mixed)).err(), Some("DataError"));
    }

    #[test]
    fn chacha20_poly1305_matches_rfc_8439() {
        // RFC 8439 section 2.8.2.
        let key: Vec<u8> = (0x80..0xa0).collect();
        let iv = [
            0x07, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
        ];
        let ad = [
            0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
        ];
        let text = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
        let sealed = chacha20_poly1305(&key, &iv, &ad, text, true).unwrap();
        assert_eq!(
            &sealed[sealed.len() - 16..],
            &[
                0x1a, 0xe1, 0x0b, 0x59, 0x4f, 0x09, 0xe2, 0x6a, 0x7e, 0x90, 0x2e, 0xcb, 0xd0, 0x60,
                0x06, 0x91
            ]
        );
        assert_eq!(
            chacha20_poly1305(&key, &iv, &ad, &sealed, false).unwrap(),
            text
        );
        let mut tampered = sealed.clone();
        tampered[0] ^= 1;
        assert!(chacha20_poly1305(&key, &iv, &ad, &tampered, false).is_err());
    }
}
