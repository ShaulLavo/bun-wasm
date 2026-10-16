use aes::cipher::{
    BlockDecryptMut, BlockEncryptMut, KeyIvInit, StreamCipher, block_padding::Pkcs7,
};
use aes::cipher::{BlockEncrypt, KeyInit};
use ed25519_dalek::{Signer, Verifier};
use pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rand_core::OsRng;
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use serde_json::{Value as J, json};
use signature::hazmat::{PrehashSigner, PrehashVerifier};
use spki::{DecodePublicKey, EncodePublicKey};
use subtle::ConstantTimeEq;

type Result<T> = std::result::Result<T, &'static str>;
fn data<T, E>(r: std::result::Result<T, E>) -> Result<T> {
    r.map_err(|_| "DataError")
}
fn operation<T, E>(r: std::result::Result<T, E>) -> Result<T> {
    r.map_err(|_| "OperationError")
}
fn text<'a>(v: &'a J, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or("DataError")
}
fn number(v: &J, key: &str) -> Result<usize> {
    v[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or("OperationError")
}
fn decode(s: &str) -> Vec<u8> {
    crate::encoding::base64_decode(s)
}
fn bytes(v: &J, key: &str) -> Result<Vec<u8>> {
    Ok(decode(text(v, key)?))
}
fn b64(b: &[u8]) -> String {
    crate::encoding::base64_encode(b, true)
}
fn output(b: impl AsRef<[u8]>) -> J {
    json!({"data":b64(b.as_ref())})
}
fn big(v: &J, key: &str) -> Result<rsa::BigUint> {
    Ok(rsa::BigUint::from_bytes_be(&bytes(v, key)?))
}
fn hash(alg: &J, input: &[u8]) -> Result<Vec<u8>> {
    crate::encoding::digest(text(alg, "hash")?, input).ok_or("NotSupportedError")
}

pub fn request(input: &str) -> String {
    let result = serde_json::from_str::<J>(input)
        .map_err(|_| "DataError")
        .and_then(|q| dispatch(&q));
    match result {
        Ok(v) => v.to_string(),
        Err(name) => json!({"error":name}).to_string(),
    }
}

fn dispatch(q: &J) -> Result<J> {
    let alg = &q["algorithm"];
    match text(q, "op")? {
        "generate" => generate(alg),
        "import" => import(alg, text(q, "format")?, &bytes(q, "data")?),
        "export" => export(alg, text(q, "format")?, &q["key"]),
        "sign" | "verify" => sign(q),
        "encrypt" | "decrypt" => crypt(q),
        "derive" => derive(q),
        _ => Err("NotSupportedError"),
    }
}

fn rsa_private(k: &J) -> Result<rsa::RsaPrivateKey> {
    let primes = if k["p"].is_string() && k["q"].is_string() {
        vec![big(k, "p")?, big(k, "q")?]
    } else {
        vec![]
    };
    let key = data(rsa::RsaPrivateKey::from_components(
        big(k, "n")?,
        big(k, "e")?,
        big(k, "d")?,
        primes,
    ))?;
    data(key.validate())?;
    Ok(key)
}
fn rsa_public(k: &J) -> Result<rsa::RsaPublicKey> {
    data(rsa::RsaPublicKey::new(big(k, "n")?, big(k, "e")?))
}
fn rsa_jwk(k: &rsa::RsaPublicKey) -> J {
    json!({"kty":"RSA","n":b64(&k.n().to_bytes_be()),"e":b64(&k.e().to_bytes_be())})
}
fn rsa_private_jwk(k: &rsa::RsaPrivateKey) -> Result<J> {
    let mut v = rsa_jwk(&k.to_public_key());
    v["d"] = b64(&k.d().to_bytes_be()).into();
    v["p"] = b64(&k.primes()[0].to_bytes_be()).into();
    v["q"] = b64(&k.primes()[1].to_bytes_be()).into();
    v["dp"] = b64(&(k.d() % (&k.primes()[0] - 1u32)).to_bytes_be()).into();
    v["dq"] = b64(&(k.d() % (&k.primes()[1] - 1u32)).to_bytes_be()).into();
    v["qi"] = b64(&data(k.crt_coefficient().ok_or("DataError"))?.to_bytes_be()).into();
    Ok(v)
}
fn okp_jwk(curve: &str, secret: &[u8], public: &[u8]) -> J {
    let mut k = json!({"kty":"OKP","crv":curve,"x":b64(public)});
    if !secret.is_empty() {
        k["d"] = b64(secret).into();
    }
    k
}
fn pair(mut private: J) -> J {
    let mut public = private.clone();
    for name in ["d", "p", "q", "dp", "dq", "qi"] {
        public.as_object_mut().unwrap().remove(name);
    }
    json!({"privateKey":private.take(),"publicKey":public})
}
fn secret32(k: &J) -> Result<[u8; 32]> {
    data(bytes(k, "d")?.try_into())
}
fn public32(k: &J) -> Result<[u8; 32]> {
    data(bytes(k, "x")?.try_into())
}

fn generate(a: &J) -> Result<J> {
    let name = text(a, "name")?;
    match name {
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "RSA-OAEP" => {
            let bits = number(a, "modulusLength")?;
            if !(512..=8192).contains(&bits) {
                return Err("OperationError");
            }
            let exponent = rsa::BigUint::from_bytes_be(&bytes(a, "publicExponent")?);
            let k = operation(rsa::RsaPrivateKey::new_with_exp(
                &mut OsRng, bits, &exponent,
            ))?;
            Ok(pair(rsa_private_jwk(&k)?))
        }
        "ECDSA" | "ECDH" => match text(a, "namedCurve")? {
            "P-256" => Ok(pair(data(serde_json::from_str(
                &p256::SecretKey::random(&mut OsRng).to_jwk_string(),
            ))?)),
            "P-384" => Ok(pair(data(serde_json::from_str(
                &p384::SecretKey::random(&mut OsRng).to_jwk_string(),
            ))?)),
            _ => Err("NotSupportedError"),
        },
        "Ed25519" => {
            let k = ed25519_dalek::SigningKey::generate(&mut OsRng);
            Ok(pair(okp_jwk(
                name,
                &k.to_bytes(),
                &k.verifying_key().to_bytes(),
            )))
        }
        "X25519" => {
            let k = x25519_dalek::StaticSecret::random_from_rng(OsRng);
            Ok(pair(okp_jwk(
                name,
                &k.to_bytes(),
                x25519_dalek::PublicKey::from(&k).as_bytes(),
            )))
        }
        _ => Err("NotSupportedError"),
    }
}

fn ec_import(a: &J, format: &str, b: &[u8]) -> Result<J> {
    macro_rules! curve {
        ($c:ident) => {
            match format {
                "pkcs8" => Ok(data(serde_json::from_str(
                    &data($c::SecretKey::from_pkcs8_der(b))?.to_jwk_string(),
                ))?),
                "spki" => Ok(data(serde_json::from_str(
                    &data($c::PublicKey::from_public_key_der(b))?.to_jwk_string(),
                ))?),
                "raw" => Ok(data(serde_json::from_str(
                    &data($c::PublicKey::from_sec1_bytes(b))?.to_jwk_string(),
                ))?),
                "jwk" => {
                    let j: J = data(serde_json::from_slice(b))?;
                    if j["d"].is_string() {
                        return Ok(data(serde_json::from_str(
                            &data($c::SecretKey::from_jwk_str(&j.to_string()))?.to_jwk_string(),
                        ))?);
                    }
                    Ok(data(serde_json::from_str(
                        &data($c::PublicKey::from_jwk_str(&j.to_string()))?.to_jwk_string(),
                    ))?)
                }
                _ => Err("NotSupportedError"),
            }
        };
    }
    match text(a, "namedCurve")? {
        "P-256" => curve!(p256),
        "P-384" => curve!(p384),
        _ => Err("NotSupportedError"),
    }
}

fn import(a: &J, format: &str, b: &[u8]) -> Result<J> {
    let name = text(a, "name")?;
    let k = match name {
        "ECDSA" | "ECDH" => ec_import(a, format, b)?,
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "RSA-OAEP" => match format {
            "pkcs8" => rsa_private_jwk(&data(rsa::RsaPrivateKey::from_pkcs8_der(b))?)?,
            "spki" => rsa_jwk(&data(rsa::RsaPublicKey::from_public_key_der(b))?),
            "jwk" => {
                let k: J = data(serde_json::from_slice(b))?;
                if k["d"].is_string() {
                    rsa_private_jwk(&rsa_private(&k)?)?
                } else {
                    rsa_jwk(&rsa_public(&k)?)
                }
            }
            _ => return Err("NotSupportedError"),
        },
        "Ed25519" | "X25519" => okp_import(name, format, b)?,
        _ => return Err("NotSupportedError"),
    };
    Ok(json!({"key":k}))
}

fn okp_import(name: &str, format: &str, b: &[u8]) -> Result<J> {
    let oid = if name == "Ed25519" {
        "1.3.101.112"
    } else {
        "1.3.101.110"
    };
    let (secret, public) = match format {
        "jwk" => {
            let k: J = data(serde_json::from_slice(b))?;
            if text(&k, "kty")? != "OKP" || text(&k, "crv")? != name {
                return Err("DataError");
            }
            (
                if k["d"].is_string() {
                    bytes(&k, "d")?
                } else {
                    vec![]
                },
                bytes(&k, "x")?,
            )
        }
        "raw" => (vec![], b.to_vec()),
        "spki" => {
            let info = data(spki::SubjectPublicKeyInfoRef::try_from(b))?;
            if info.algorithm.oid.to_string() != oid || info.algorithm.parameters.is_some() {
                return Err("DataError");
            }
            (
                vec![],
                data(info.subject_public_key.as_bytes().ok_or("DataError"))?.to_vec(),
            )
        }
        "pkcs8" => {
            let info = data(pkcs8::PrivateKeyInfo::try_from(b))?;
            if info.algorithm.oid.to_string() != oid || info.algorithm.parameters.is_some() {
                return Err("DataError");
            }
            use pkcs8::der::Decode;
            let inner = data(pkcs8::der::asn1::OctetStringRef::from_der(info.private_key))?;
            (inner.as_bytes().to_vec(), vec![])
        }
        _ => return Err("NotSupportedError"),
    };
    if secret.is_empty() {
        if public.len() != 32 {
            return Err("DataError");
        }
        if name == "Ed25519" {
            data(ed25519_dalek::VerifyingKey::from_bytes(&data(
                public.as_slice().try_into(),
            )?))?;
        }
        return Ok(okp_jwk(name, &[], &public));
    }
    let raw: [u8; 32] = data(secret.as_slice().try_into())?;
    let derived = if name == "Ed25519" {
        ed25519_dalek::SigningKey::from_bytes(&raw)
            .verifying_key()
            .to_bytes()
    } else {
        *x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(raw)).as_bytes()
    };
    if !public.is_empty() && public != derived {
        return Err("DataError");
    }
    Ok(okp_jwk(name, &secret, &derived))
}

fn export(a: &J, format: &str, k: &J) -> Result<J> {
    let name = text(a, "name")?;
    if name == "ECDSA" || name == "ECDH" {
        return ec_export(a, format, k);
    }
    if name == "Ed25519" || name == "X25519" {
        return okp_export(name, format, k);
    }
    match format {
        "pkcs8" => Ok(output(data(rsa_private(k)?.to_pkcs8_der())?.as_bytes())),
        "spki" => Ok(output(data(rsa_public(k)?.to_public_key_der())?.as_bytes())),
        _ => Err("NotSupportedError"),
    }
}
fn ec_export(a: &J, format: &str, k: &J) -> Result<J> {
    macro_rules! curve {
        ($c:ident) => {
            match format {
                "pkcs8" => Ok(output(
                    data(data($c::SecretKey::from_jwk_str(&k.to_string()))?.to_pkcs8_der())?
                        .as_bytes(),
                )),
                "spki" => Ok(output(
                    data(data($c::PublicKey::from_jwk_str(&k.to_string()))?.to_public_key_der())?
                        .as_bytes(),
                )),
                "raw" => {
                    use $c::elliptic_curve::sec1::ToEncodedPoint;
                    Ok(output(
                        data($c::PublicKey::from_jwk_str(&k.to_string()))?
                            .to_encoded_point(false)
                            .as_bytes(),
                    ))
                }
                _ => Err("NotSupportedError"),
            }
        };
    }
    match text(a, "namedCurve")? {
        "P-256" => curve!(p256),
        "P-384" => curve!(p384),
        _ => Err("NotSupportedError"),
    }
}
fn okp_export(name: &str, format: &str, k: &J) -> Result<J> {
    use pkcs8::der::Encode;
    let oid = data(pkcs8::ObjectIdentifier::new(if name == "Ed25519" {
        "1.3.101.112"
    } else {
        "1.3.101.110"
    }))?;
    let alg = pkcs8::AlgorithmIdentifierRef {
        oid,
        parameters: None,
    };
    let b = bytes(k, if format == "pkcs8" { "d" } else { "x" })?;
    match format {
        "raw" => Ok(output(b)),
        "spki" => Ok(output(data(
            spki::SubjectPublicKeyInfoRef {
                algorithm: alg,
                subject_public_key: data(pkcs8::der::asn1::BitStringRef::from_bytes(&b))?,
            }
            .to_der(),
        )?)),
        "pkcs8" => {
            let inner = data(data(pkcs8::der::asn1::OctetStringRef::new(&b))?.to_der())?;
            Ok(output(data(
                pkcs8::PrivateKeyInfo::new(alg, &inner).to_der(),
            )?))
        }
        _ => Err("NotSupportedError"),
    }
}

fn sign(q: &J) -> Result<J> {
    let a = &q["algorithm"];
    let k = &q["key"];
    let input = bytes(q, "data")?;
    let verify = text(q, "op")? == "verify";
    let sig = if verify {
        bytes(q, "signature")?
    } else {
        vec![]
    };
    match text(a, "name")? {
        "HMAC" => {
            let expected = crate::encoding::hmac(text(a, "hash")?, &bytes(k, "k")?, &input)
                .ok_or("NotSupportedError")?;
            if !verify {
                return Ok(output(expected));
            }
            Ok(json!({"verified":bool::from(expected.ct_eq(&sig))}))
        }
        "Ed25519" => {
            if !verify {
                return Ok(output(
                    ed25519_dalek::SigningKey::from_bytes(&secret32(k)?)
                        .sign(&input)
                        .to_bytes(),
                ));
            }
            let key = data(ed25519_dalek::VerifyingKey::from_bytes(&public32(k)?))?;
            Ok(
                json!({"verified":ed25519_dalek::Signature::from_slice(&sig).is_ok_and(|s| key.verify(&input,&s).is_ok())}),
            )
        }
        "ECDSA" => ec_sign(a, k, &input, &sig, verify),
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" => rsa_sign(a, k, &input, &sig, verify),
        _ => Err("NotSupportedError"),
    }
}
fn ec_sign(a: &J, k: &J, input: &[u8], sig: &[u8], verify: bool) -> Result<J> {
    let digest = hash(a, input)?;
    macro_rules! curve { ($c:ident) => {{
        if !verify {
            let key=data($c::ecdsa::SigningKey::from_slice(&bytes(k,"d")?))?;
            let s: $c::ecdsa::Signature=operation(key.sign_prehash(&digest))?;
            return Ok(output(s.to_bytes()));
        }
        let public=data($c::PublicKey::from_jwk_str(&k.to_string()))?;
        let key=$c::ecdsa::VerifyingKey::from(public);
        Ok(json!({"verified":$c::ecdsa::Signature::from_slice(sig).is_ok_and(|s| key.verify_prehash(&digest,&s).is_ok())}))
    }}; }
    match text(a, "namedCurve")? {
        "P-256" => curve!(p256),
        "P-384" => curve!(p384),
        _ => Err("NotSupportedError"),
    }
}
unsafe extern "C" {
    fn bunwasm_rsa(
        op: i32,
        der: *const u8,
        der_len: usize,
        hash: i32,
        pss: i32,
        salt: i32,
        label: *const u8,
        label_len: usize,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_len: *mut usize,
    ) -> i32;
}
fn rsa_native(op: i32, a: &J, k: &J, input: &[u8], signature: &[u8]) -> Result<J> {
    let private = op == 0 || op == 3;
    let der = if private {
        data(rsa_private(k)?.to_pkcs1_der())?.as_bytes().to_vec()
    } else {
        data(rsa_public(k)?.to_pkcs1_der())?.as_bytes().to_vec()
    };
    let hash = match text(a, "hash")? {
        "SHA-1" => 1,
        "SHA-256" => 256,
        "SHA-384" => 384,
        "SHA-512" => 512,
        _ => return Err("NotSupportedError"),
    };
    let pss = text(a, "name")? == "RSA-PSS";
    let salt = if pss {
        i32::try_from(number(a, "saltLength")?).map_err(|_| "OperationError")?
    } else {
        0
    };
    let label = if op >= 2 { bytes(a, "label")? } else { vec![] };
    let mut output = if op == 1 {
        signature.to_vec()
    } else {
        vec![0; rsa_public(k)?.size()]
    };
    let mut length = output.len();
    // The C adapter borrows every slice for this call and writes at most output's capacity.
    let result = unsafe {
        bunwasm_rsa(
            op,
            der.as_ptr(),
            der.len(),
            hash,
            i32::from(pss),
            salt,
            label.as_ptr(),
            label.len(),
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            &mut length,
        )
    };
    if op == 1 {
        return Ok(json!({"verified":result==1}));
    }
    if result != 1 || length > output.len() {
        return Err("OperationError");
    }
    output.truncate(length);
    Ok(crate::crypto::output(output))
}
fn rsa_sign(a: &J, k: &J, input: &[u8], sig: &[u8], verify: bool) -> Result<J> {
    rsa_native(if verify { 1 } else { 0 }, a, k, input, sig)
}

fn crypt(q: &J) -> Result<J> {
    let a = &q["algorithm"];
    let k = &q["key"];
    let input = bytes(q, "data")?;
    let encrypt = text(q, "op")? == "encrypt";
    if text(a, "name")? == "RSA-OAEP" {
        return rsa_crypt(a, k, &input, encrypt);
    }
    let key = bytes(k, "k")?;
    let result = match text(a, "name")? {
        "AES-KW" => kw_crypt(&key, &input, encrypt),
        "AES-CBC" => cbc_crypt(&key, &bytes(a, "iv")?, &input, encrypt),
        "AES-CTR" => ctr_crypt(&key, &bytes(a, "counter")?, &input, number(a, "length")?),
        "AES-GCM" => gcm_crypt(
            &key,
            &bytes(a, "iv")?,
            &bytes(a, "additionalData")?,
            &input,
            number(a, "tagLength")?,
            encrypt,
        ),
        _ => Err("NotSupportedError"),
    }?;
    Ok(output(result))
}
fn cbc_crypt(key: &[u8], iv: &[u8], input: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    macro_rules! cipher {
        ($c:ty) => {{
            if encrypt {
                Ok(data(cbc::Encryptor::<$c>::new_from_slices(key, iv))?
                    .encrypt_padded_vec_mut::<Pkcs7>(input))
            } else {
                operation(
                    data(cbc::Decryptor::<$c>::new_from_slices(key, iv))?
                        .decrypt_padded_vec_mut::<Pkcs7>(input),
                )
            }
        }};
    }
    match key.len() {
        16 => cipher!(aes::Aes128),
        24 => cipher!(aes::Aes192),
        32 => cipher!(aes::Aes256),
        _ => Err("DataError"),
    }
}
fn ctr_crypt(key: &[u8], counter: &[u8], input: &[u8], length: usize) -> Result<Vec<u8>> {
    if counter.len() != 16 || !(1..=128).contains(&length) {
        return Err("OperationError");
    }
    let blocks = input.len().div_ceil(16);
    if length < usize::BITS as usize && blocks > (1usize << length) {
        return Err("OperationError");
    }
    let initial = u128::from_be_bytes(data(counter.try_into())?);
    let mask = u128::MAX >> (128 - length);
    let available = (initial & mask).wrapping_neg() & mask;
    let first = if available == 0 || available > usize::MAX as u128 {
        input.len()
    } else {
        (available as usize).saturating_mul(16).min(input.len())
    };
    let mut out = input.to_vec();
    ctr_apply(key, counter, &mut out[..first])?;
    if first < input.len() {
        ctr_apply(key, &(initial & !mask).to_be_bytes(), &mut out[first..])?;
    }
    Ok(out)
}
fn ctr_apply(key: &[u8], iv: &[u8], buf: &mut [u8]) -> Result<()> {
    macro_rules! cipher {
        ($c:ty) => {
            operation(data(ctr::Ctr128BE::<$c>::new_from_slices(key, iv))?.try_apply_keystream(buf))
        };
    }
    match key.len() {
        16 => cipher!(aes::Aes128),
        24 => cipher!(aes::Aes192),
        32 => cipher!(aes::Aes256),
        _ => Err("DataError"),
    }
}
fn gcm_crypt(
    key: &[u8],
    iv: &[u8],
    aad: &[u8],
    input: &[u8],
    tag: usize,
    encrypt: bool,
) -> Result<Vec<u8>> {
    macro_rules! run {
        ($c:ty) => {
            gcm::<$c>(key, iv, aad, input, tag, encrypt)
        };
    }
    match key.len() {
        16 => run!(aes::Aes128),
        24 => run!(aes::Aes192),
        32 => run!(aes::Aes256),
        _ => Err("DataError"),
    }
}
fn gcm<C>(
    key: &[u8],
    iv: &[u8],
    aad: &[u8],
    input: &[u8],
    tag_bits: usize,
    encrypt: bool,
) -> Result<Vec<u8>>
where
    C: aes::cipher::BlockCipher
        + BlockEncrypt
        + KeyInit
        + aes::cipher::BlockSizeUser<BlockSize = aes::cipher::consts::U16>,
{
    use ghash::universal_hash::UniversalHash;
    if iv.is_empty() || ![32, 64, 96, 104, 112, 120, 128].contains(&tag_bits) {
        return Err("OperationError");
    }
    let cipher = data(C::new_from_slice(key))?;
    let mut h = ghash::Block::default();
    cipher.encrypt_block(&mut h);
    let auth = ghash::GHash::new(&h);
    let mut j0 = ghash::Block::default();
    if iv.len() == 12 {
        j0[..12].copy_from_slice(iv);
        j0[15] = 1;
    } else {
        let mut g = auth.clone();
        g.update_padded(iv);
        let mut size = ghash::Block::default();
        size[8..].copy_from_slice(&((iv.len() as u64) * 8).to_be_bytes());
        g.update(&[size]);
        j0 = g.finalize();
    }
    let tag_len = tag_bits / 8;
    if !encrypt && input.len() < tag_len {
        return Err("OperationError");
    }
    let ciphertext = if encrypt {
        input
    } else {
        &input[..input.len() - tag_len]
    };
    let mut out = ciphertext.to_vec();
    let mut initial = j0;
    let counter = u32::from_be_bytes(data(initial[12..].try_into())?).wrapping_add(1);
    initial[12..].copy_from_slice(&counter.to_be_bytes());
    let mut stream = data(ctr::Ctr32BE::<C>::new_from_slices(key, &initial))?;
    if encrypt {
        operation(stream.try_apply_keystream(&mut out))?;
    }
    let mut g = auth;
    g.update_padded(aad);
    g.update_padded(if encrypt { &out } else { ciphertext });
    let mut size = ghash::Block::default();
    size[..8].copy_from_slice(&((aad.len() as u64) * 8).to_be_bytes());
    size[8..].copy_from_slice(&((ciphertext.len() as u64) * 8).to_be_bytes());
    g.update(&[size]);
    let mut expected = g.finalize();
    let mut mask = j0;
    cipher.encrypt_block(&mut mask);
    for (a, b) in expected.iter_mut().zip(mask) {
        *a ^= b;
    }
    if encrypt {
        out.extend_from_slice(&expected[..tag_len]);
        return Ok(out);
    }
    if !bool::from(expected[..tag_len].ct_eq(&input[input.len() - tag_len..])) {
        return Err("OperationError");
    }
    operation(stream.try_apply_keystream(&mut out))?;
    Ok(out)
}
fn rsa_crypt(a: &J, k: &J, input: &[u8], encrypt: bool) -> Result<J> {
    rsa_native(if encrypt { 2 } else { 3 }, a, k, input, &[])
}

fn derive(q: &J) -> Result<J> {
    let a = &q["algorithm"];
    let k = &q["key"];
    let len = number(q, "length")?;
    let out = match text(a, "name")? {
        "PBKDF2" | "HKDF" => derive_password(a, &bytes(k, "k")?, len)?,
        "X25519" => {
            let shared = x25519_dalek::StaticSecret::from(secret32(k)?)
                .diffie_hellman(&x25519_dalek::PublicKey::from(public32(&q["public"])?));
            if !shared.was_contributory() {
                return Err("OperationError");
            }
            shared.as_bytes().to_vec()
        }
        "ECDH" => ec_derive(a, k, &q["public"])?,
        _ => return Err("NotSupportedError"),
    };
    if len > out.len() {
        return Err("OperationError");
    }
    Ok(output(&out[..len]))
}
fn derive_password(a: &J, key: &[u8], length: usize) -> Result<Vec<u8>> {
    let mut out = vec![0; length];
    let salt = bytes(a, "salt")?;
    macro_rules! run {
        ($d:ty) => {{
            if text(a, "name")? == "PBKDF2" {
                let iterations =
                    u32::try_from(number(a, "iterations")?).map_err(|_| "OperationError")?;
                if iterations == 0 {
                    return Err("OperationError");
                }
                pbkdf2::pbkdf2_hmac::<$d>(key, &salt, iterations, &mut out);
            } else {
                operation(
                    hkdf::Hkdf::<$d>::new(Some(&salt), key).expand(&bytes(a, "info")?, &mut out),
                )?;
            }
            Ok(out)
        }};
    }
    match text(a, "hash")? {
        "SHA-1" => run!(sha1::Sha1),
        "SHA-256" => run!(sha2::Sha256),
        "SHA-384" => run!(sha2::Sha384),
        "SHA-512" => run!(sha2::Sha512),
        _ => Err("NotSupportedError"),
    }
}
fn ec_derive(a: &J, k: &J, public: &J) -> Result<Vec<u8>> {
    macro_rules! run {
        ($c:ident) => {{
            let secret = data($c::SecretKey::from_jwk_str(&k.to_string()))?;
            let public = data($c::PublicKey::from_jwk_str(&public.to_string()))?;
            Ok(
                $c::ecdh::diffie_hellman(secret.to_nonzero_scalar(), public.as_affine())
                    .raw_secret_bytes()
                    .to_vec(),
            )
        }};
    }
    match text(a, "namedCurve")? {
        "P-256" => run!(p256),
        "P-384" => run!(p384),
        _ => Err("NotSupportedError"),
    }
}

fn kw_crypt(key: &[u8], input: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    macro_rules! run {
        ($c:ty) => {{
            let kek = data(aes_kw::Kek::<$c>::try_from(key))?;
            if encrypt {
                operation(kek.wrap_vec(input))
            } else {
                operation(kek.unwrap_vec(input))
            }
        }};
    }
    match key.len() {
        16 => run!(aes::Aes128),
        24 => run!(aes::Aes192),
        32 => run!(aes::Aes256),
        _ => Err("DataError"),
    }
}
