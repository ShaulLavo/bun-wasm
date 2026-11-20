//! BoringSSL declarations for NIST-curve keys: JWK, SEC1, PKCS#8, SPKI and raw point
//! encodings, ECDSA and ECDH. Every function is part of BoringSSL's public API at the
//! pinned revision; `node.rs` declares the group, point and key basics shared with ECDH.
use std::ffi::{c_int, c_long};

pub use crate::node::{BigNum, BnCtx, EcGroup, EcKey, EcPoint};
pub use crate::x509::{Key as EvpKey, i2d_PUBKEY};

pub enum EcdsaSig {}
pub enum Pkcs8Info {}

unsafe extern "C" {
    pub fn EC_GROUP_get_curve_name(group: *const EcGroup) -> c_int;
    pub fn EC_POINT_get_affine_coordinates_GFp(
        group: *const EcGroup,
        point: *const EcPoint,
        x: *mut BigNum,
        y: *mut BigNum,
        ctx: *mut BnCtx,
    ) -> c_int;
    pub fn EC_POINT_set_affine_coordinates_GFp(
        group: *const EcGroup,
        point: *mut EcPoint,
        x: *const BigNum,
        y: *const BigNum,
        ctx: *mut BnCtx,
    ) -> c_int;
    pub fn BN_bn2bin_padded(out: *mut u8, len: usize, input: *const BigNum) -> c_int;
    pub fn BN_clear_free(bn: *mut BigNum);

    pub fn d2i_ECPrivateKey(out: *mut *mut EcKey, input: *mut *const u8, len: c_long)
    -> *mut EcKey;
    pub fn i2d_ECPrivateKey(key: *const EcKey, out: *mut *mut u8) -> c_int;

    pub fn EVP_PKEY_new() -> *mut EvpKey;
    pub fn EVP_PKEY_free(key: *mut EvpKey);
    pub fn EVP_PKEY_id(key: *const EvpKey) -> c_int;
    pub fn EVP_PKEY_set1_EC_KEY(key: *mut EvpKey, ec: *mut EcKey) -> c_int;
    pub fn EVP_PKEY_get1_EC_KEY(key: *const EvpKey) -> *mut EcKey;
    pub fn d2i_PUBKEY(out: *mut *mut EvpKey, input: *mut *const u8, len: c_long) -> *mut EvpKey;
    pub fn d2i_PKCS8_PRIV_KEY_INFO(
        out: *mut *mut Pkcs8Info,
        input: *mut *const u8,
        len: c_long,
    ) -> *mut Pkcs8Info;
    pub fn i2d_PKCS8_PRIV_KEY_INFO(info: *const Pkcs8Info, out: *mut *mut u8) -> c_int;
    pub fn PKCS8_PRIV_KEY_INFO_free(info: *mut Pkcs8Info);
    pub fn EVP_PKCS82PKEY(info: *const Pkcs8Info) -> *mut EvpKey;
    pub fn EVP_PKEY2PKCS8(key: *const EvpKey) -> *mut Pkcs8Info;

    pub fn ECDSA_do_sign(digest: *const u8, len: usize, key: *const EcKey) -> *mut EcdsaSig;
    pub fn ECDSA_do_verify(
        digest: *const u8,
        len: usize,
        sig: *const EcdsaSig,
        key: *const EcKey,
    ) -> c_int;
    pub fn ECDSA_SIG_new() -> *mut EcdsaSig;
    pub fn ECDSA_SIG_free(sig: *mut EcdsaSig);
    pub fn ECDSA_SIG_get0(sig: *const EcdsaSig, r: *mut *const BigNum, s: *mut *const BigNum);
    pub fn ECDSA_SIG_set0(sig: *mut EcdsaSig, r: *mut BigNum, s: *mut BigNum) -> c_int;
    pub fn ECDSA_SIG_from_bytes(input: *const u8, len: usize) -> *mut EcdsaSig;
    pub fn i2d_ECDSA_SIG(sig: *const EcdsaSig, out: *mut *mut u8) -> c_int;
}

/// `EVP_PKEY_EC`.
pub const EVP_PKEY_EC: c_int = 408;
/// Curve NIDs for P-256, P-384 and P-521.
pub const NID_X9_62_PRIME256V1: c_int = 415;
pub const NID_SECP384R1: c_int = 715;
pub const NID_SECP521R1: c_int = 716;
