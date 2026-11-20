//! P-256, P-384 and P-521 keys over the BoringSSL the guest already links. The import,
//! export, ECDSA and ECDH steps follow Bun's `CryptoKeyECOpenSSL.cpp`,
//! `CryptoAlgorithmECDSAOpenSSL.cpp` and `CryptoAlgorithmECDHOpenSSL.cpp`, so lenient JWK
//! scalars, point checks and signature shapes match Bun. Keys travel as JWK, as for the
//! other key types in `crypto.rs`.
use crate::crypto::{CURVE_MISMATCH, KEY_TYPE};
use bunwasm_crypto_sys::ec::*;
use bunwasm_crypto_sys::node::{
    BN_bin2bn, BN_new, EC_GROUP_get_degree, EC_KEY_check_key, EC_KEY_free, EC_KEY_generate_key,
    EC_KEY_get0_group, EC_KEY_get0_private_key, EC_KEY_get0_public_key, EC_KEY_new_by_curve_name,
    EC_KEY_set_private_key, EC_KEY_set_public_key, EC_POINT_free, EC_POINT_mul, EC_POINT_new,
    EC_POINT_oct2point, EC_POINT_point2oct, ECDH_compute_key, ERR_clear_error,
    POINT_CONVERSION_UNCOMPRESSED,
};
use serde_json::{Value as J, json};
use std::ffi::{c_int, c_long};
use std::ptr;

type Result<T> = std::result::Result<T, &'static str>;

/// A WebCrypto named curve, its BoringSSL NID and its ASN.1 object identifier.
#[derive(Clone, Copy)]
pub(crate) struct Curve {
    pub name: &'static str,
    pub oid: &'static str,
    nid: c_int,
}

const CURVES: [Curve; 3] = [
    Curve {
        name: "P-256",
        oid: "1.2.840.10045.3.1.7",
        nid: NID_X9_62_PRIME256V1,
    },
    Curve {
        name: "P-384",
        oid: "1.3.132.0.34",
        nid: NID_SECP384R1,
    },
    Curve {
        name: "P-521",
        oid: "1.3.132.0.35",
        nid: NID_SECP521R1,
    },
];

pub(crate) fn curve(name: &str) -> Result<Curve> {
    CURVES
        .into_iter()
        .find(|curve| curve.name == name)
        .ok_or("NotSupportedError")
}

/// Runs a BoringSSL step and drops whatever it left on the thread's error queue, so a
/// failed parse cannot surface later in an unrelated cipher or TLS error message.
fn clean<T>(step: impl FnOnce() -> Result<T>) -> Result<T> {
    let result = step();
    // SAFETY: clears this thread's BoringSSL error queue.
    unsafe { ERR_clear_error() };
    result
}

struct Bn(*mut BigNum);
impl Drop for Bn {
    fn drop(&mut self) {
        // SAFETY: owned BIGNUM, freed once; BN_clear_free accepts null.
        unsafe { BN_clear_free(self.0) }
    }
}
impl Bn {
    fn new() -> Result<Self> {
        // SAFETY: allocates a fresh BIGNUM.
        Self::owned(unsafe { BN_new() })
    }
    fn from_bytes(bytes: &[u8]) -> Result<Self> {
        // SAFETY: BN_bin2bn copies `bytes` into a fresh BIGNUM.
        Self::owned(unsafe { BN_bin2bn(bytes.as_ptr(), bytes.len(), ptr::null_mut()) })
    }
    fn owned(bn: *mut BigNum) -> Result<Self> {
        if bn.is_null() {
            Err("OperationError")
        } else {
            Ok(Self(bn))
        }
    }
    fn release(self) -> *mut BigNum {
        let bn = self.0;
        std::mem::forget(self);
        bn
    }
}

/// Big-endian bytes of `bn`, left-padded to `size` as Bun's `convertToBytesExpand` does.
fn padded(bn: *const BigNum, size: usize) -> Result<Vec<u8>> {
    let mut out = vec![0; size];
    // SAFETY: `bn` is a live BIGNUM and `out` holds `size` bytes.
    if bn.is_null() || unsafe { BN_bn2bin_padded(out.as_mut_ptr(), size, bn) } != 1 {
        return Err("OperationError");
    }
    Ok(out)
}

struct Point(*mut EcPoint);
impl Drop for Point {
    fn drop(&mut self) {
        // SAFETY: owned point, freed once; EC_POINT_free accepts null.
        unsafe { EC_POINT_free(self.0) }
    }
}

struct Pkey(*mut EvpKey);
impl Drop for Pkey {
    fn drop(&mut self) {
        // SAFETY: owned EVP_PKEY, freed once; EVP_PKEY_free accepts null.
        unsafe { EVP_PKEY_free(self.0) }
    }
}

/// Parses one DER value with a `d2i_*` function and rejects trailing bytes, as Bun does.
fn d2i<T>(b: &[u8], parse: impl FnOnce(*mut *const u8, c_long) -> *mut T) -> Result<*mut T> {
    let len = c_long::try_from(b.len()).map_err(|_| "DataError")?;
    let mut cursor = b.as_ptr();
    let value = parse(&mut cursor, len);
    if value.is_null() {
        return Err("DataError");
    }
    // `cursor` advanced within `b` past the parsed value.
    if cursor as usize - b.as_ptr() as usize != b.len() {
        return Err("DataError");
    }
    Ok(value)
}

/// Encodes with an `i2d_*` function: a length query, then the write.
fn i2d(encode: impl Fn(*mut *mut u8) -> c_int) -> Result<Vec<u8>> {
    let len = usize::try_from(encode(ptr::null_mut())).map_err(|_| "OperationError")?;
    if len == 0 {
        return Err("OperationError");
    }
    let mut out = vec![0; len];
    let mut cursor = out.as_mut_ptr();
    if usize::try_from(encode(&mut cursor)).ok() != Some(len) {
        return Err("OperationError");
    }
    Ok(out)
}

struct Key(*mut EcKey);
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: owned EC_KEY, freed once; EC_KEY_free accepts null.
        unsafe { EC_KEY_free(self.0) }
    }
}

impl Key {
    fn new(curve: Curve) -> Result<Self> {
        // SAFETY: allocates an EC_KEY on a built-in curve.
        Self::owned(unsafe { EC_KEY_new_by_curve_name(curve.nid) })
    }
    fn owned(key: *mut EcKey) -> Result<Self> {
        if key.is_null() {
            Err("DataError")
        } else {
            Ok(Self(key))
        }
    }
    fn group(&self) -> *const EcGroup {
        // SAFETY: a live EC_KEY always has a group.
        unsafe { EC_KEY_get0_group(self.0) }
    }
    /// Field size in bytes: 32, 48 or 66.
    fn size(&self) -> usize {
        // SAFETY: a live group.
        (unsafe { EC_GROUP_get_degree(self.group()) } as usize).div_ceil(8)
    }
    /// The key, after BoringSSL's consistency check and a check of its curve.
    fn checked(self, curve: Curve, mismatch: &'static str) -> Result<Self> {
        // SAFETY: live EC_KEY and group.
        if unsafe { EC_GROUP_get_curve_name(self.group()) } != curve.nid {
            return Err(mismatch);
        }
        // SAFETY: live EC_KEY.
        if unsafe { EC_KEY_check_key(self.0) } != 1 {
            return Err("DataError");
        }
        Ok(self)
    }
    fn set_public(&self, point: Point) -> Result<()> {
        // SAFETY: EC_KEY_set_public_key copies the point.
        if unsafe { EC_KEY_set_public_key(self.0, point.0) } != 1 {
            return Err("DataError");
        }
        Ok(())
    }
    fn point(&self) -> Result<Point> {
        // SAFETY: allocates a point on this key's group.
        let point = Point(unsafe { EC_POINT_new(self.group()) });
        if point.0.is_null() {
            Err("OperationError")
        } else {
            Ok(point)
        }
    }

    fn from_jwk(curve: Curve, x: &[u8], y: &[u8], d: Option<&[u8]>) -> Result<Self> {
        let key = Self::new(curve)?;
        let point = key.point()?;
        let (x, y) = (Bn::from_bytes(x)?, Bn::from_bytes(y)?);
        // SAFETY: live group, point and coordinates; the point copies them.
        if unsafe {
            EC_POINT_set_affine_coordinates_GFp(key.group(), point.0, x.0, y.0, ptr::null_mut())
        } != 1
        {
            return Err("DataError");
        }
        key.set_public(point)?;
        if let Some(d) = d {
            let d = Bn::from_bytes(d)?;
            // SAFETY: EC_KEY_set_private_key copies the scalar.
            if unsafe { EC_KEY_set_private_key(key.0, d.0) } != 1 {
                return Err("DataError");
            }
        }
        key.checked(curve, "DataError")
    }
    fn from_raw(curve: Curve, b: &[u8]) -> Result<Self> {
        let key = Self::new(curve)?;
        let point = key.point()?;
        // SAFETY: `b` is readable for its length; the point decodes a copy.
        if unsafe { EC_POINT_oct2point(key.group(), point.0, b.as_ptr(), b.len(), ptr::null_mut()) }
            != 1
        {
            return Err("DataError");
        }
        key.set_public(point)?;
        key.checked(curve, "DataError")
    }
    /// Node's raw-private form: the scalar at exactly the group order's size, as Bun requires.
    fn from_scalar(curve: Curve, b: &[u8]) -> Result<Self> {
        let key = Self::new(curve)?;
        if b.len() != key.size() {
            return Err("DataError");
        }
        let d = Bn::from_bytes(b)?;
        let point = key.point()?;
        // SAFETY: live group, point and scalar; the key copies the scalar and point.
        let ok = unsafe {
            EC_KEY_set_private_key(key.0, d.0) == 1
                && EC_POINT_mul(
                    key.group(),
                    point.0,
                    d.0,
                    ptr::null(),
                    ptr::null(),
                    ptr::null_mut(),
                ) == 1
        };
        if !ok {
            return Err("DataError");
        }
        key.set_public(point)?;
        key.checked(curve, "DataError")
    }
    fn from_sec1(curve: Curve, b: &[u8]) -> Result<Self> {
        // SAFETY: d2i reads at most `len` bytes from the cursor.
        let key = d2i(b, |cursor, len| unsafe {
            d2i_ECPrivateKey(ptr::null_mut(), cursor, len)
        })?;
        Self(key).checked(curve, "DataError")
    }
    fn from_evp(curve: Curve, pkey: Pkey) -> Result<Self> {
        // SAFETY: live EVP_PKEY.
        if unsafe { EVP_PKEY_id(pkey.0) } != EVP_PKEY_EC {
            return Err(KEY_TYPE);
        }
        // SAFETY: get1 returns a new reference the Key owns.
        Self::owned(unsafe { EVP_PKEY_get1_EC_KEY(pkey.0) })?.checked(curve, CURVE_MISMATCH)
    }
    fn from_pkcs8(curve: Curve, b: &[u8]) -> Result<Self> {
        // SAFETY: d2i reads at most `len` bytes from the cursor.
        let info = d2i(b, |cursor, len| unsafe {
            d2i_PKCS8_PRIV_KEY_INFO(ptr::null_mut(), cursor, len)
        })?;
        // SAFETY: `info` is live until freed just below.
        let pkey = Pkey(unsafe { EVP_PKCS82PKEY(info) });
        // SAFETY: freed once.
        unsafe { PKCS8_PRIV_KEY_INFO_free(info) };
        if pkey.0.is_null() {
            return Err("DataError");
        }
        Self::from_evp(curve, pkey)
    }
    fn from_spki(curve: Curve, b: &[u8]) -> Result<Self> {
        // SAFETY: d2i reads at most `len` bytes from the cursor.
        let pkey = Pkey(d2i(b, |cursor, len| unsafe {
            d2i_PUBKEY(ptr::null_mut(), cursor, len)
        })?);
        Self::from_evp(curve, pkey)
    }

    fn evp(&self) -> Result<Pkey> {
        // SAFETY: a fresh EVP_PKEY takes its own reference to the EC_KEY.
        let pkey = Pkey(unsafe { EVP_PKEY_new() });
        if pkey.0.is_null() || unsafe { EVP_PKEY_set1_EC_KEY(pkey.0, self.0) } != 1 {
            return Err("OperationError");
        }
        Ok(pkey)
    }
    fn jwk(&self, curve: Curve) -> Result<J> {
        let (x, y) = (Bn::new()?, Bn::new()?);
        // SAFETY: live group, public point and output BIGNUMs.
        if unsafe {
            EC_POINT_get_affine_coordinates_GFp(
                self.group(),
                EC_KEY_get0_public_key(self.0),
                x.0,
                y.0,
                ptr::null_mut(),
            )
        } != 1
        {
            return Err("OperationError");
        }
        let size = self.size();
        let mut k = json!({
            "kty": "EC",
            "crv": curve.name,
            "x": b64(&padded(x.0, size)?),
            "y": b64(&padded(y.0, size)?),
        });
        // SAFETY: live EC_KEY; null when there is no private scalar.
        let d = unsafe { EC_KEY_get0_private_key(self.0) };
        if !d.is_null() {
            k["d"] = b64(&padded(d, size)?).into();
        }
        Ok(k)
    }
    fn raw(&self) -> Result<Vec<u8>> {
        // SAFETY: live group and point; the first call sizes the second.
        let point = unsafe { EC_KEY_get0_public_key(self.0) };
        let encode = |out: *mut u8, len: usize| unsafe {
            EC_POINT_point2oct(
                self.group(),
                point,
                POINT_CONVERSION_UNCOMPRESSED,
                out,
                len,
                ptr::null_mut(),
            )
        };
        let len = encode(ptr::null_mut(), 0);
        let mut out = vec![0; len];
        if len == 0 || encode(out.as_mut_ptr(), len) != len {
            return Err("OperationError");
        }
        Ok(out)
    }
}

fn b64(b: &[u8]) -> String {
    crate::encoding::base64_encode(b, true)
}

/// The JWK members a key needs. A decoder error is the caller's DataError.
pub(crate) struct JwkParts {
    pub x: Vec<u8>,
    pub y: Vec<u8>,
    pub d: Option<Vec<u8>>,
}

fn key(curve: Curve, k: &JwkParts) -> Result<Key> {
    Key::from_jwk(curve, &k.x, &k.y, k.d.as_deref())
}

pub(crate) fn generate(curve: Curve) -> Result<J> {
    clean(|| {
        let key = Key::new(curve).map_err(|_| "OperationError")?;
        // SAFETY: live EC_KEY on a built-in curve.
        if unsafe { EC_KEY_generate_key(key.0) } != 1 {
            return Err("OperationError");
        }
        key.jwk(curve)
    })
}

/// Imports `b` in `format` ("jwk" takes decoded parts) and answers the canonical JWK.
pub(crate) fn import(curve: Curve, format: &str, b: &[u8], jwk: Option<&JwkParts>) -> Result<J> {
    clean(|| {
        let key = match (format, jwk) {
            ("jwk", Some(parts)) => key(curve, parts)?,
            ("raw", _) => Key::from_raw(curve, b)?,
            ("raw-private", _) => Key::from_scalar(curve, b)?,
            ("sec1", _) => Key::from_sec1(curve, b)?,
            ("pkcs8", _) => Key::from_pkcs8(curve, b)?,
            ("spki", _) => Key::from_spki(curve, b)?,
            _ => return Err("NotSupportedError"),
        };
        key.jwk(curve)
    })
}

pub(crate) fn export(curve: Curve, format: &str, k: &JwkParts) -> Result<Vec<u8>> {
    clean(|| {
        let key = key(curve, k)?;
        match format {
            "raw" => key.raw(),
            // SAFETY: each encoder reads the live key and writes at most the queried length.
            "sec1" => i2d(|out| unsafe { i2d_ECPrivateKey(key.0, out) }),
            "spki" => {
                let pkey = key.evp()?;
                i2d(|out| unsafe { i2d_PUBKEY(pkey.0, out) })
            }
            "pkcs8" => {
                let pkey = key.evp()?;
                // SAFETY: live EVP_PKEY; the info is freed below.
                let info = unsafe { EVP_PKEY2PKCS8(pkey.0) };
                if info.is_null() {
                    return Err("OperationError");
                }
                let der = i2d(|out| unsafe { i2d_PKCS8_PRIV_KEY_INFO(info, out) });
                // SAFETY: freed once.
                unsafe { PKCS8_PRIV_KEY_INFO_free(info) };
                der
            }
            _ => Err("NotSupportedError"),
        }
    })
}

struct Sig(*mut EcdsaSig);
impl Drop for Sig {
    fn drop(&mut self) {
        // SAFETY: owned signature, freed once; ECDSA_SIG_free accepts null.
        unsafe { ECDSA_SIG_free(self.0) }
    }
}

/// ECDSA over a precomputed digest: DER for Node's default, r || s otherwise.
pub(crate) fn sign(curve: Curve, k: &JwkParts, digest: &[u8], der: bool) -> Result<Vec<u8>> {
    clean(|| {
        let key = key(curve, k)?;
        // SAFETY: live private key; `digest` is readable for its length.
        let sig = Sig(unsafe { ECDSA_do_sign(digest.as_ptr(), digest.len(), key.0) });
        if sig.0.is_null() {
            return Err("OperationError");
        }
        if der {
            // SAFETY: live signature.
            return i2d(|out| unsafe { i2d_ECDSA_SIG(sig.0, out) });
        }
        let (mut r, mut s) = (ptr::null(), ptr::null());
        // SAFETY: live signature; r and s stay owned by it.
        unsafe { ECDSA_SIG_get0(sig.0, &mut r, &mut s) };
        let size = key.size();
        let mut out = padded(r, size)?;
        out.extend_from_slice(&padded(s, size)?);
        Ok(out)
    })
}

pub(crate) fn verify(
    curve: Curve,
    k: &JwkParts,
    digest: &[u8],
    sig: &[u8],
    der: bool,
) -> Result<bool> {
    clean(|| {
        let key = key(curve, k)?;
        let size = key.size();
        let parsed = if der {
            // SAFETY: strict DER parse of a readable buffer.
            Sig(unsafe { ECDSA_SIG_from_bytes(sig.as_ptr(), sig.len()) })
        } else {
            // Bun answers false when the signature is not r || s at the key's size.
            if sig.len() != size * 2 {
                return Ok(false);
            }
            let (r, s) = (Bn::from_bytes(&sig[..size])?, Bn::from_bytes(&sig[size..])?);
            // SAFETY: a fresh signature takes ownership of r and s on success.
            let out = Sig(unsafe { ECDSA_SIG_new() });
            if out.0.is_null() || unsafe { ECDSA_SIG_set0(out.0, r.0, s.0) } != 1 {
                return Err("OperationError");
            }
            r.release();
            s.release();
            out
        };
        if parsed.0.is_null() {
            return Ok(false);
        }
        // SAFETY: live digest, signature and key.
        Ok(unsafe { ECDSA_do_verify(digest.as_ptr(), digest.len(), parsed.0, key.0) } == 1)
    })
}

/// ECDH's shared x coordinate, the field size long.
pub(crate) fn derive(curve: Curve, private: &JwkParts, public: &JwkParts) -> Result<Vec<u8>> {
    clean(|| {
        let (key, peer) = (key(curve, private)?, key(curve, public)?);
        let mut out = vec![0; key.size()];
        // SAFETY: live keys; `out` holds the field size, the most ECDH writes.
        let written = unsafe {
            ECDH_compute_key(
                out.as_mut_ptr().cast(),
                out.len(),
                EC_KEY_get0_public_key(peer.0),
                key.0,
                ptr::null(),
            )
        };
        if usize::try_from(written).ok() != Some(out.len()) {
            return Err("OperationError");
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(k: &J) -> JwkParts {
        let field = |name: &str| k[name].as_str().map(crate::encoding::base64_decode);
        JwkParts {
            x: field("x").unwrap(),
            y: field("y").unwrap(),
            d: field("d"),
        }
    }

    #[test]
    fn every_curve_round_trips_signs_and_agrees() {
        for name in ["P-256", "P-384", "P-521"] {
            let c = curve(name).unwrap();
            let private = generate(c).unwrap();
            let k = parts(&private);
            let size = k.x.len();
            assert_eq!(
                size,
                [32, 48, 66][["P-256", "P-384", "P-521"]
                    .iter()
                    .position(|n| *n == name)
                    .unwrap()]
            );
            let public = JwkParts {
                x: k.x.clone(),
                y: k.y.clone(),
                d: None,
            };
            for format in ["sec1", "pkcs8"] {
                let der = export(c, format, &k).unwrap();
                assert_eq!(
                    import(c, format, &der, None).unwrap(),
                    private,
                    "{name} {format}"
                );
            }
            let mut public_jwk = private.clone();
            public_jwk.as_object_mut().unwrap().remove("d");
            for format in ["spki", "raw"] {
                let der = export(c, format, &public).unwrap();
                assert_eq!(
                    import(c, format, &der, None).unwrap(),
                    public_jwk,
                    "{name} {format}"
                );
            }
            let digest = [7u8; 32];
            for der in [false, true] {
                let sig = sign(c, &k, &digest, der).unwrap();
                if !der {
                    assert_eq!(sig.len(), size * 2);
                }
                assert!(verify(c, &public, &digest, &sig, der).unwrap());
                assert!(!verify(c, &public, &[8u8; 32], &sig, der).unwrap());
            }
            let other = parts(&generate(c).unwrap());
            let other_public = JwkParts {
                x: other.x.clone(),
                y: other.y.clone(),
                d: None,
            };
            assert_eq!(
                derive(c, &k, &other_public).unwrap(),
                derive(c, &other, &public).unwrap()
            );
        }
    }

    #[test]
    fn a_short_jwk_scalar_is_padded_and_a_wrong_curve_is_named() {
        let c = curve("P-521").unwrap();
        let mut k = parts(&generate(c).unwrap());
        while k.d.as_ref().unwrap()[0] != 0 {
            k = parts(&generate(c).unwrap());
        }
        let short = JwkParts {
            x: k.x.clone(),
            y: k.y.clone(),
            d: Some(k.d.as_ref().unwrap()[1..].to_vec()),
        };
        let canonical = import(c, "jwk", &[], Some(&short)).unwrap();
        assert_eq!(
            crate::encoding::base64_decode(canonical["d"].as_str().unwrap()).len(),
            66
        );
        let der = export(
            c,
            "spki",
            &JwkParts {
                x: k.x,
                y: k.y,
                d: None,
            },
        )
        .unwrap();
        assert_eq!(
            import(curve("P-256").unwrap(), "spki", &der, None).err(),
            Some(CURVE_MISMATCH)
        );
    }
}
