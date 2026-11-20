//! node:crypto's DiffieHellman, ECDH, crypto.diffieHellman and primes on BoringSSL, as in
//! Bun's JSDiffieHellman, JSECDH, CryptoDhJob and CryptoPrimes (src/jsc/bindings/node/crypto)
//! and ncrypto's DHPointer and BignumPointer. The key material lives in JavaScript as
//! big-endian bytes; each call rebuilds the BoringSSL objects it needs.

use std::ffi::{CString, c_int};
use std::ptr;

use bunwasm_crypto_sys::node::*;

use crate::data::{Args, NativeError, NativeResult, Val};
use crate::natives::Table;
use crate::node_cipher::clear_errors;

/// An owned BIGNUM.
struct Bn(*mut BigNum);

impl Drop for Bn {
    fn drop(&mut self) {
        // SAFETY: owned and freed once; BN_free accepts null.
        unsafe { BN_free(self.0) }
    }
}

impl Bn {
    fn from_bytes(bytes: &[u8]) -> Result<Bn, NativeError> {
        // SAFETY: reads `bytes` and allocates a new BIGNUM.
        let bn = unsafe { BN_bin2bn(bytes.as_ptr(), bytes.len(), ptr::null_mut()) };
        if bn.is_null() {
            return Err(NativeError::range_error("Out of memory"));
        }
        Ok(Bn(bn))
    }

    /// Hands ownership to a BoringSSL object that takes it.
    fn release(self) -> *mut BigNum {
        let bn = self.0;
        std::mem::forget(self);
        bn
    }
}

/// The minimal big-endian bytes of a BIGNUM (BN_bn2bin), empty for zero.
fn encode(bn: *const BigNum) -> Vec<u8> {
    // SAFETY: `bn` is a live BIGNUM and the output holds BN_num_bytes bytes.
    unsafe {
        let mut out = vec![0u8; BN_num_bytes(bn) as usize];
        BN_bn2bin(bn, out.as_mut_ptr());
        out
    }
}

fn bytes_or_null(value: Option<Vec<u8>>) -> Val {
    value.map_or(Val::Null, Val::Bytes)
}

/// An owned DH with its parameters, and optionally its keys.
struct DhKey(*mut Dh);

impl Drop for DhKey {
    fn drop(&mut self) {
        // SAFETY: owned and freed once.
        unsafe { DH_free(self.0) }
    }
}

impl DhKey {
    /// DHPointer::New(p, g) plus the keys JavaScript holds.
    fn new(
        p: &[u8],
        g: &[u8],
        public: Option<&[u8]>,
        private: Option<&[u8]>,
    ) -> Result<DhKey, NativeError> {
        // SAFETY: a fresh DH takes ownership of each BIGNUM it accepts.
        unsafe {
            let dh = DhKey(DH_new());
            if dh.0.is_null() {
                return Err(NativeError::range_error("Out of memory"));
            }
            let (p, g) = (Bn::from_bytes(p)?, Bn::from_bytes(g)?);
            if DH_set0_pqg(dh.0, p.0, ptr::null_mut(), g.0) != 1 {
                return Err(NativeError::error("Invalid DH parameters"));
            }
            p.release();
            g.release();
            let public = public.map(Bn::from_bytes).transpose()?;
            let private = private.map(Bn::from_bytes).transpose()?;
            let (public, private) = (
                public.map_or(ptr::null_mut(), Bn::release),
                private.map_or(ptr::null_mut(), Bn::release),
            );
            if (!public.is_null() || !private.is_null()) && DH_set0_key(dh.0, public, private) != 1
            {
                return Err(NativeError::error("Invalid DH key"));
            }
            Ok(dh)
        }
    }

    fn keys(&self) -> (Vec<u8>, Vec<u8>) {
        let (mut public, mut private) = (ptr::null(), ptr::null());
        // SAFETY: a live DH; the BIGNUMs stay owned by it.
        unsafe { DH_get0_key(self.0, &mut public, &mut private) };
        (encode(public), encode(private))
    }
}

/// RFC 3526 groups by Node's names; BoringSSL has no modp1 or modp2.
fn dh_group(name: &str) -> Option<Vec<u8>> {
    let make: unsafe extern "C" fn(*mut BigNum) -> *mut BigNum =
        match name.to_ascii_lowercase().as_str() {
            "modp5" => BN_get_rfc3526_prime_1536,
            "modp14" => BN_get_rfc3526_prime_2048,
            "modp15" => BN_get_rfc3526_prime_3072,
            "modp16" => BN_get_rfc3526_prime_4096,
            "modp17" => BN_get_rfc3526_prime_6144,
            "modp18" => BN_get_rfc3526_prime_8192,
            _ => return None,
        };
    // SAFETY: allocates a new BIGNUM holding the constant.
    let prime = Bn(unsafe { make(ptr::null_mut()) });
    (!prime.0.is_null()).then(|| encode(prime.0))
}

/// DH_generate_parameters_ex: (bits, generator) to the prime, or null.
fn dh_parameters(bits: i32, generator: i32) -> Option<Vec<u8>> {
    // SAFETY: a fresh DH; the prime stays owned by it.
    unsafe {
        let dh = DhKey(DH_new());
        if dh.0.is_null() || DH_generate_parameters_ex(dh.0, bits, generator, ptr::null_mut()) != 1
        {
            return None;
        }
        let mut p = ptr::null();
        DH_get0_pqg(dh.0, &mut p, ptr::null_mut(), ptr::null_mut());
        Some(encode(p))
    }
}

/// DHPointer::check: DH_check's flags, or -1 when the check itself fails.
fn dh_check(p: &[u8], g: &[u8]) -> Result<f64, NativeError> {
    let dh = DhKey::new(p, g, None, None)?;
    let mut flags: c_int = 0;
    // SAFETY: a live DH.
    let ok = unsafe { DH_check(dh.0, &mut flags) } == 1;
    Ok(if ok { f64::from(flags) } else { -1.0 })
}

/// DH_generate_key: (p, g, private or null) to [public, private], or null.
fn dh_generate(a: &Args<'_>) -> NativeResult {
    let dh = DhKey::new(a.bytes(0)?, a.bytes(1)?, None, a.opt_bytes(2))?;
    // SAFETY: a live DH.
    if unsafe { DH_generate_key(dh.0) } != 1 {
        return Ok(Val::Null);
    }
    let (public, private) = dh.keys();
    Ok(Val::Array(vec![Val::Bytes(public), Val::Bytes(private)]))
}

/// computeSecret: (p, g, private or null, peer) to the secret padded to the prime's size,
/// a number for a public key check failure (DH_check_pub_key's flags, or -1), or null.
fn dh_secret(a: &Args<'_>) -> NativeResult {
    let dh = DhKey::new(a.bytes(0)?, a.bytes(1)?, None, a.opt_bytes(2))?;
    let peer = Bn::from_bytes(a.bytes(3)?)?;
    let mut flags: c_int = 0;
    // SAFETY: a live DH and BIGNUM.
    if unsafe { DH_check_pub_key(dh.0, peer.0, &mut flags) } != 1 {
        return Ok(Val::Num(-1.0));
    }
    if flags != 0 {
        return Ok(Val::Num(f64::from(flags)));
    }
    // SAFETY: the output holds DH_size bytes, the most DH_compute_key writes.
    let size = unsafe { DH_size(dh.0) }.max(0) as usize;
    let mut out = vec![0u8; size];
    let written = unsafe { DH_compute_key(out.as_mut_ptr(), peer.0, dh.0) };
    if written < 0 {
        return Ok(Val::Null);
    }
    // A shorter secret is left-padded with zeros to the prime's size.
    out.truncate(written as usize);
    let mut padded = vec![0u8; size - out.len()];
    padded.extend(out);
    Ok(Val::Bytes(padded))
}

/// A static curve group by nid.
struct Group(*mut EcGroup);

impl Drop for Group {
    fn drop(&mut self) {
        // SAFETY: freed once; built-in groups ignore the free.
        unsafe { EC_GROUP_free(self.0) }
    }
}

impl Group {
    fn new(nid: i32) -> Result<Group, NativeError> {
        // SAFETY: a lookup of a built-in curve.
        let group = unsafe { EC_GROUP_new_by_curve_name(nid) };
        if group.is_null() {
            return Err(NativeError::error("Failed to get EC_GROUP"));
        }
        Ok(Group(group))
    }

    /// EC_POINT_oct2point, or None for bytes that are not a point on this curve.
    fn point(&self, bytes: &[u8]) -> Option<Point> {
        // SAFETY: a fresh point on a live group.
        unsafe {
            let point = Point(EC_POINT_new(self.0));
            if point.0.is_null()
                || EC_POINT_oct2point(
                    self.0,
                    point.0,
                    bytes.as_ptr(),
                    bytes.len(),
                    ptr::null_mut(),
                ) != 1
            {
                return None;
            }
            Some(point)
        }
    }

    /// EC_POINT_point2oct in `form`, or None when BoringSSL cannot encode it.
    fn encode(&self, point: *const EcPoint, form: c_int) -> Option<Vec<u8>> {
        // SAFETY: a live group and point; the output holds the size the first call reports.
        unsafe {
            let size = EC_POINT_point2oct(self.0, point, form, ptr::null_mut(), 0, ptr::null_mut());
            if size == 0 {
                return None;
            }
            let mut out = vec![0u8; size];
            (EC_POINT_point2oct(self.0, point, form, out.as_mut_ptr(), size, ptr::null_mut()) != 0)
                .then_some(out)
        }
    }
}

struct Point(*mut EcPoint);

impl Drop for Point {
    fn drop(&mut self) {
        // SAFETY: freed once; EC_POINT_free accepts null.
        unsafe { EC_POINT_free(self.0) }
    }
}

struct EcKeyHandle(*mut EcKey);

impl Drop for EcKeyHandle {
    fn drop(&mut self) {
        // SAFETY: freed once; EC_KEY_free accepts null.
        unsafe { EC_KEY_free(self.0) }
    }
}

/// createECDH's curve lookup: the nid, 0 for an unknown name, -1 for a curve BoringSSL lacks.
fn ecdh_curve(name: &str) -> f64 {
    let Ok(name) = CString::new(name) else {
        return 0.0;
    };
    // SAFETY: a NUL-terminated short name.
    let nid = unsafe { OBJ_sn2nid(name.as_ptr()) };
    if nid == 0 {
        return 0.0;
    }
    // SAFETY: the key is only probed and freed.
    let key = EcKeyHandle(unsafe { EC_KEY_new_by_curve_name(nid) });
    if key.0.is_null() {
        -1.0
    } else {
        f64::from(nid)
    }
}

/// An EC key on `nid` with the private and public parts JavaScript holds.
fn ec_key(
    nid: i32,
    private: Option<&[u8]>,
    public: Option<&[u8]>,
    group: &Group,
) -> Result<Option<EcKeyHandle>, NativeError> {
    // SAFETY: a fresh key on a built-in curve; the setters copy their arguments.
    unsafe {
        let key = EcKeyHandle(EC_KEY_new_by_curve_name(nid));
        if key.0.is_null() {
            return Err(NativeError::error("Failed to create key using named curve"));
        }
        if let Some(private) = private {
            let private = Bn::from_bytes(private)?;
            if EC_KEY_set_private_key(key.0, private.0) != 1 {
                return Ok(None);
            }
        }
        if let Some(public) = public {
            let Some(point) = group.point(public) else {
                return Ok(None);
            };
            if EC_KEY_set_public_key(key.0, point.0) != 1 {
                return Ok(None);
            }
        }
        Ok(Some(key))
    }
}

/// generateKeys: (nid) to [private, uncompressed public].
fn ecdh_generate(nid: i32) -> NativeResult {
    let group = Group::new(nid)?;
    let Some(key) = ec_key(nid, None, None, &group)? else {
        return Ok(Val::Null);
    };
    // SAFETY: a live key; its parts stay owned by it.
    unsafe {
        if EC_KEY_generate_key(key.0) != 1 {
            return Ok(Val::Null);
        }
        let public = group.encode(EC_KEY_get0_public_key(key.0), POINT_CONVERSION_UNCOMPRESSED);
        let private = encode(EC_KEY_get0_private_key(key.0));
        Ok(Val::Array(vec![Val::Bytes(private), bytes_or_null(public)]))
    }
}

/// A public point re-encoded: (nid, point, form) to bytes, or a number naming the step
/// that failed (1 parse, 2 size, 3 encode).
fn ecdh_point(nid: i32, bytes: &[u8], form: c_int) -> NativeResult {
    let group = Group::new(nid)?;
    let Some(point) = group.point(bytes) else {
        return Ok(Val::Num(1.0));
    };
    // SAFETY: a live group and point.
    let size =
        unsafe { EC_POINT_point2oct(group.0, point.0, form, ptr::null_mut(), 0, ptr::null_mut()) };
    if size == 0 {
        return Ok(Val::Num(2.0));
    }
    Ok(group
        .encode(point.0, form)
        .map_or(Val::Num(3.0), Val::Bytes))
}

/// setPrivateKey: (nid, private) to [private, uncompressed public], or 1 when the key is not
/// in [1, n - 1] (CryptoUtil.cpp isKeyValidForCurve), or 2 when the public key fails.
fn ecdh_private(nid: i32, bytes: &[u8]) -> NativeResult {
    let group = Group::new(nid)?;
    let private = Bn::from_bytes(bytes)?;
    // SAFETY: live BIGNUMs; the order stays owned by the group.
    let valid = unsafe {
        BN_is_zero(private.0) == 0 && BN_cmp(private.0, EC_GROUP_get0_order(group.0)) < 0
    };
    if !valid {
        return Ok(Val::Num(1.0));
    }
    // SAFETY: a fresh point on a live group.
    unsafe {
        let public = Point(EC_POINT_new(group.0));
        if public.0.is_null()
            || EC_POINT_mul(
                group.0,
                public.0,
                private.0,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            ) != 1
        {
            return Ok(Val::Num(2.0));
        }
        let encoded = group.encode(public.0, POINT_CONVERSION_UNCOMPRESSED);
        Ok(Val::Array(vec![
            Val::Bytes(encode(private.0)),
            bytes_or_null(encoded),
        ]))
    }
}

/// computeSecret: (nid, private or null, public or null, peer) to the secret, or 1 for an
/// invalid key pair, 2 for an invalid peer, 3 when the derivation fails.
fn ecdh_secret(a: &Args<'_>) -> NativeResult {
    let nid = a.i32(0)?;
    let group = Group::new(nid)?;
    let key = ec_key(nid, a.opt_bytes(1), a.opt_bytes(2), &group)?;
    // SAFETY: a live key.
    let Some(key) = key.filter(|key| unsafe { EC_KEY_check_key(key.0) } == 1) else {
        return Ok(Val::Num(1.0));
    };
    let Some(peer) = group.point(a.bytes(3)?) else {
        return Ok(Val::Num(2.0));
    };
    // SAFETY: a live group.
    let size = (unsafe { EC_GROUP_get_degree(group.0) } as usize).div_ceil(8);
    let mut out = vec![0u8; size];
    // SAFETY: the output holds `size` bytes.
    let written =
        unsafe { ECDH_compute_key(out.as_mut_ptr().cast(), size, peer.0, key.0, ptr::null()) };
    Ok(if written == size as c_int {
        Val::Bytes(out)
    } else {
        Val::Num(3.0)
    })
}

/// X25519 for crypto.diffieHellman: (private, public) to the secret, or null.
fn x25519(private: &[u8], public: &[u8]) -> Val {
    if private.len() != 32 || public.len() != 32 {
        return Val::Null;
    }
    let mut out = vec![0u8; 32];
    // SAFETY: three 32-byte buffers.
    let ok = unsafe { X25519(out.as_mut_ptr(), private.as_ptr(), public.as_ptr()) } == 1;
    if ok { Val::Bytes(out) } else { Val::Null }
}

/// checkPrime: BN_is_prime_ex's 1, 0, or -1 on failure.
fn prime_check(candidate: &[u8], checks: i32) -> Result<f64, NativeError> {
    let candidate = Bn::from_bytes(candidate)?;
    // SAFETY: a fresh context for a live BIGNUM.
    unsafe {
        let ctx = BN_CTX_new();
        let result = BN_is_prime_ex(candidate.0, checks, ctx, ptr::null_mut());
        BN_CTX_free(ctx);
        Ok(f64::from(result))
    }
}

/// generatePrime: (bits, safe, add or null, rem or null) to the prime, or null.
fn prime_generate(a: &Args<'_>) -> NativeResult {
    let add = a.opt_bytes(2).map(Bn::from_bytes).transpose()?;
    let rem = a.opt_bytes(3).map(Bn::from_bytes).transpose()?;
    let prime = Bn(unsafe { BN_new() });
    if prime.0.is_null() {
        return Err(NativeError::range_error("Out of memory"));
    }
    let pointer = |bn: &Option<Bn>| bn.as_ref().map_or(ptr::null(), |bn| bn.0.cast_const());
    // SAFETY: live BIGNUMs; add and rem may be null.
    let ok = unsafe {
        BN_generate_prime_ex(
            prime.0,
            a.i32(0)?,
            c_int::from(a.bool(1)),
            pointer(&add),
            pointer(&rem),
            ptr::null_mut(),
        )
    } == 1;
    Ok(if ok {
        Val::Bytes(encode(prime.0))
    } else {
        Val::Null
    })
}

/// Bun's generatePrime check that `add` fits the size and exceeds `rem`:
/// (bits, add, rem or null) to 0, 1 for options.add, 2 for options.rem.
fn prime_options(bits: i32, add: &[u8], rem: Option<&[u8]>) -> Result<f64, NativeError> {
    let add = Bn::from_bytes(add)?;
    // SAFETY: live BIGNUMs.
    unsafe {
        if BN_num_bits(add.0) as i64 > i64::from(bits) {
            return Ok(1.0);
        }
        if let Some(rem) = rem {
            let rem = Bn::from_bytes(rem)?;
            if BN_cmp(add.0, rem.0) <= 0 {
                return Ok(2.0);
            }
        }
    }
    Ok(0.0)
}

fn install_dh(t: &mut Table) {
    t.add("nodeCrypto.dhGroup", |a| {
        Ok(bytes_or_null(dh_group(a.str(0)?)))
    });
    t.add("nodeCrypto.dhParameters", |a| {
        clear_errors();
        let prime = dh_parameters(a.i32(0)?, a.i32(1)?);
        clear_errors();
        Ok(bytes_or_null(prime))
    });
    t.add("nodeCrypto.dhCheck", |a| {
        let flags = dh_check(a.bytes(0)?, a.bytes(1)?)?;
        clear_errors();
        Ok(Val::Num(flags))
    });
    t.add("nodeCrypto.dhGenerate", |a| {
        let keys = dh_generate(&a);
        clear_errors();
        keys
    });
    t.add("nodeCrypto.dhSecret", |a| {
        let secret = dh_secret(&a);
        clear_errors();
        secret
    });
}

fn install_ecdh(t: &mut Table) {
    t.add("nodeCrypto.ecdhCurve", |a| {
        Ok(Val::Num(ecdh_curve(a.str(0)?)))
    });
    t.add("nodeCrypto.ecdhGenerate", |a| {
        let keys = ecdh_generate(a.i32(0)?);
        clear_errors();
        keys
    });
    t.add("nodeCrypto.ecdhPoint", |a| {
        let point = ecdh_point(a.i32(0)?, a.bytes(1)?, a.i32(2)?);
        clear_errors();
        point
    });
    t.add("nodeCrypto.ecdhPrivate", |a| {
        let keys = ecdh_private(a.i32(0)?, a.bytes(1)?);
        clear_errors();
        keys
    });
    t.add("nodeCrypto.ecdhSecret", |a| {
        let secret = ecdh_secret(&a);
        clear_errors();
        secret
    });
    t.add("nodeCrypto.x25519", |a| {
        Ok(x25519(a.bytes(0)?, a.bytes(1)?))
    });
}

fn install_primes(t: &mut Table) {
    t.add("nodeCrypto.primeCheck", |a| {
        let result = prime_check(a.bytes(0)?, a.i32(1)?);
        clear_errors();
        result.map(Val::Num)
    });
    t.add("nodeCrypto.primeOptions", |a| {
        prime_options(a.i32(0)?, a.bytes(1)?, a.opt_bytes(2)).map(Val::Num)
    });
    t.add("nodeCrypto.primeGenerate", |a| {
        let prime = prime_generate(&a);
        clear_errors();
        prime
    });
}

pub fn install(t: &mut Table) {
    install_dh(t);
    install_ecdh(t);
    install_primes(t);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    // RFC 5903 section 8.1.
    const I: &str = "c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433";
    const GI: &str = "04dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3";
    const GR: &str = "04d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf6356fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab";
    const SECRET: &str = "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de";

    #[test]
    fn ecdh_rfc5903_p256() {
        let nid = ecdh_curve("prime256v1") as i32;
        assert_eq!(ecdh_curve("P-256"), 0.0);
        let Val::Array(keys) = ecdh_private(nid, &hex(I)).unwrap() else {
            panic!()
        };
        assert_eq!(keys[1], Val::Bytes(hex(GI)));
        let secret = ecdh_secret(&Args(&[
            Val::Num(f64::from(nid)),
            Val::Bytes(hex(I)),
            Val::Bytes(hex(GI)),
            Val::Bytes(hex(GR)),
        ]))
        .unwrap();
        assert_eq!(secret, Val::Bytes(hex(SECRET)));
        let compressed = ecdh_point(nid, &hex(GI), POINT_CONVERSION_COMPRESSED).unwrap();
        assert_eq!(compressed, Val::Bytes(hex(&format!("03{}", &GI[2..66]))));
        assert_eq!(
            ecdh_point(nid, &[4, 1], POINT_CONVERSION_UNCOMPRESSED).unwrap(),
            Val::Num(1.0)
        );
        assert_eq!(ecdh_private(nid, &[0; 32]).unwrap(), Val::Num(1.0));
        let no_keys = ecdh_secret(&Args(&[
            Val::Num(f64::from(nid)),
            Val::Null,
            Val::Null,
            Val::Bytes(hex(GR)),
        ]))
        .unwrap();
        assert_eq!(no_keys, Val::Num(1.0));
    }

    #[test]
    fn dh_group_keys_agree() {
        let prime = dh_group("MODP5").unwrap();
        assert_eq!(prime.len(), 192);
        assert!(dh_group("modp2").is_none());
        assert_eq!(dh_check(&prime, &[2]).unwrap(), 8.0);
        let generate = |private: &[u8]| {
            let Val::Array(keys) = dh_generate(&Args(&[
                Val::Bytes(prime.clone()),
                Val::Bytes(vec![2]),
                Val::Bytes(private.to_vec()),
            ]))
            .unwrap() else {
                panic!()
            };
            keys
        };
        let (alice, bob) = (generate(&[0x11; 32]), generate(&[0x22; 32]));
        let secret = |own: &[u8], peer: &Val| {
            let Val::Bytes(peer) = peer else { panic!() };
            dh_secret(&Args(&[
                Val::Bytes(prime.clone()),
                Val::Bytes(vec![2]),
                Val::Bytes(own.to_vec()),
                Val::Bytes(peer.clone()),
            ]))
            .unwrap()
        };
        assert_eq!(secret(&[0x11; 32], &bob[0]), secret(&[0x22; 32], &alice[0]));
        // DH_CHECK_PUBKEY_TOO_SMALL; node_dh.ts reports any flag as "Supplied key is invalid".
        assert_eq!(secret(&[0x11; 32], &Val::Bytes(vec![1])), Val::Num(1.0));
    }

    #[test]
    fn primes() {
        let mersenne_61 = (2u64.pow(61) - 1).to_be_bytes();
        assert_eq!(prime_check(&mersenne_61, 0).unwrap(), 1.0);
        assert_eq!(prime_check(&561u32.to_be_bytes(), 0).unwrap(), 0.0);
        let Val::Bytes(prime) = prime_generate(&Args(&[
            Val::Num(64.0),
            Val::Bool(false),
            Val::Null,
            Val::Null,
        ]))
        .unwrap() else {
            panic!()
        };
        assert_eq!(prime.len(), 8);
        assert_eq!(prime_check(&prime, 0).unwrap(), 1.0);
        assert_eq!(prime_options(8, &[4, 0], None).unwrap(), 1.0);
        assert_eq!(prime_options(32, &[12], Some(&[12])).unwrap(), 2.0);
        assert_eq!(x25519(&[1; 32], &[0; 32]), Val::Null);
    }
}
