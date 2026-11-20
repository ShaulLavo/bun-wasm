//! BoringSSL declarations for node:crypto's ciphers, Diffie-Hellman, ECDH and primes.
//! Every function is part of BoringSSL's public API at the pinned revision.
use std::ffi::{c_char, c_int, c_uint, c_void};

pub use crate::x509::{BN_free, BigNum, ERR_clear_error, OBJ_nid2sn};

pub enum Cipher {}
pub enum CipherCtx {}
pub enum Engine {}
pub enum Dh {}
pub enum BnCtx {}
pub enum BnGencb {}
pub enum EcGroup {}
pub enum EcKey {}
pub enum EcPoint {}

pub const EVP_CTRL_AEAD_SET_IVLEN: c_int = 0x9;
pub const EVP_CTRL_AEAD_GET_TAG: c_int = 0x10;
pub const EVP_CTRL_AEAD_SET_TAG: c_int = 0x11;

/// `EVP_CIPHER_mode` values.
pub const EVP_CIPH_STREAM_CIPHER: u32 = 0x0;
pub const EVP_CIPH_ECB_MODE: u32 = 0x1;
pub const EVP_CIPH_CBC_MODE: u32 = 0x2;
pub const EVP_CIPH_CFB_MODE: u32 = 0x3;
pub const EVP_CIPH_OFB_MODE: u32 = 0x4;
pub const EVP_CIPH_CTR_MODE: u32 = 0x5;
pub const EVP_CIPH_GCM_MODE: u32 = 0x6;
pub const EVP_CIPH_XTS_MODE: u32 = 0x7;
pub const EVP_CIPH_CCM_MODE: u32 = 0x8;
pub const EVP_CIPH_OCB_MODE: u32 = 0x9;
pub const EVP_CIPH_WRAP_MODE: u32 = 0xa;

/// `point_conversion_form_t`.
pub const POINT_CONVERSION_COMPRESSED: c_int = 2;
pub const POINT_CONVERSION_UNCOMPRESSED: c_int = 4;
pub const POINT_CONVERSION_HYBRID: c_int = 6;

unsafe extern "C" {
    pub fn EVP_get_cipherbyname(name: *const c_char) -> *const Cipher;
    pub fn EVP_get_cipherbynid(nid: c_int) -> *const Cipher;
    pub fn EVP_CIPHER_nid(cipher: *const Cipher) -> c_int;
    pub fn EVP_CIPHER_block_size(cipher: *const Cipher) -> c_uint;
    pub fn EVP_CIPHER_key_length(cipher: *const Cipher) -> c_uint;
    pub fn EVP_CIPHER_iv_length(cipher: *const Cipher) -> c_uint;
    pub fn EVP_CIPHER_mode(cipher: *const Cipher) -> u32;
    pub fn EVP_CIPHER_CTX_new() -> *mut CipherCtx;
    pub fn EVP_CIPHER_CTX_free(ctx: *mut CipherCtx);
    pub fn EVP_CIPHER_CTX_ctrl(
        ctx: *mut CipherCtx,
        command: c_int,
        arg: c_int,
        ptr: *mut c_void,
    ) -> c_int;
    pub fn EVP_CIPHER_CTX_set_padding(ctx: *mut CipherCtx, pad: c_int) -> c_int;
    pub fn EVP_CIPHER_CTX_set_key_length(ctx: *mut CipherCtx, key_len: c_uint) -> c_int;
    pub fn EVP_CipherInit_ex(
        ctx: *mut CipherCtx,
        cipher: *const Cipher,
        engine: *mut Engine,
        key: *const u8,
        iv: *const u8,
        enc: c_int,
    ) -> c_int;
    pub fn EVP_CipherUpdate(
        ctx: *mut CipherCtx,
        out: *mut u8,
        out_len: *mut c_int,
        input: *const u8,
        in_len: c_int,
    ) -> c_int;
    pub fn EVP_CipherFinal_ex(ctx: *mut CipherCtx, out: *mut u8, out_len: *mut c_int) -> c_int;
    pub fn OBJ_sn2nid(name: *const c_char) -> c_int;

    pub fn ERR_peek_error() -> u32;
    pub fn ERR_error_string_n(packed: u32, buf: *mut c_char, len: usize) -> *mut c_char;
    pub fn ERR_lib_error_string(packed: u32) -> *const c_char;
    pub fn ERR_func_error_string(packed: u32) -> *const c_char;
    pub fn ERR_reason_error_string(packed: u32) -> *const c_char;

    pub fn BN_new() -> *mut BigNum;
    pub fn BN_bin2bn(input: *const u8, len: usize, ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_bn2bin(input: *const BigNum, out: *mut u8) -> usize;
    pub fn BN_num_bytes(bn: *const BigNum) -> c_uint;
    pub fn BN_num_bits(bn: *const BigNum) -> c_uint;
    pub fn BN_cmp(a: *const BigNum, b: *const BigNum) -> c_int;
    pub fn BN_is_zero(bn: *const BigNum) -> c_int;
    pub fn BN_set_word(bn: *mut BigNum, value: usize) -> c_int;
    pub fn BN_CTX_new() -> *mut BnCtx;
    pub fn BN_CTX_free(ctx: *mut BnCtx);
    pub fn BN_is_prime_ex(
        candidate: *const BigNum,
        checks: c_int,
        ctx: *mut BnCtx,
        cb: *mut BnGencb,
    ) -> c_int;
    pub fn BN_generate_prime_ex(
        ret: *mut BigNum,
        bits: c_int,
        safe: c_int,
        add: *const BigNum,
        rem: *const BigNum,
        cb: *mut BnGencb,
    ) -> c_int;
    pub fn BN_get_rfc3526_prime_1536(ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_get_rfc3526_prime_2048(ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_get_rfc3526_prime_3072(ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_get_rfc3526_prime_4096(ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_get_rfc3526_prime_6144(ret: *mut BigNum) -> *mut BigNum;
    pub fn BN_get_rfc3526_prime_8192(ret: *mut BigNum) -> *mut BigNum;

    pub fn DH_new() -> *mut Dh;
    pub fn DH_free(dh: *mut Dh);
    pub fn DH_set0_pqg(dh: *mut Dh, p: *mut BigNum, q: *mut BigNum, g: *mut BigNum) -> c_int;
    pub fn DH_get0_pqg(
        dh: *const Dh,
        p: *mut *const BigNum,
        q: *mut *const BigNum,
        g: *mut *const BigNum,
    );
    pub fn DH_set0_key(dh: *mut Dh, public: *mut BigNum, private: *mut BigNum) -> c_int;
    pub fn DH_get0_key(dh: *const Dh, public: *mut *const BigNum, private: *mut *const BigNum);
    pub fn DH_generate_parameters_ex(
        dh: *mut Dh,
        bits: c_int,
        generator: c_int,
        cb: *mut BnGencb,
    ) -> c_int;
    pub fn DH_check(dh: *const Dh, flags: *mut c_int) -> c_int;
    pub fn DH_check_pub_key(dh: *const Dh, public: *const BigNum, flags: *mut c_int) -> c_int;
    pub fn DH_generate_key(dh: *mut Dh) -> c_int;
    pub fn DH_compute_key(out: *mut u8, peer: *const BigNum, dh: *mut Dh) -> c_int;
    pub fn DH_size(dh: *const Dh) -> c_int;

    pub fn EC_GROUP_new_by_curve_name(nid: c_int) -> *mut EcGroup;
    pub fn EC_GROUP_free(group: *mut EcGroup);
    pub fn EC_GROUP_get_degree(group: *const EcGroup) -> c_uint;
    pub fn EC_GROUP_get0_order(group: *const EcGroup) -> *const BigNum;
    pub fn EC_KEY_new_by_curve_name(nid: c_int) -> *mut EcKey;
    pub fn EC_KEY_free(key: *mut EcKey);
    pub fn EC_KEY_get0_group(key: *const EcKey) -> *const EcGroup;
    pub fn EC_KEY_generate_key(key: *mut EcKey) -> c_int;
    pub fn EC_KEY_get0_private_key(key: *const EcKey) -> *const BigNum;
    pub fn EC_KEY_set_private_key(key: *mut EcKey, private: *const BigNum) -> c_int;
    pub fn EC_KEY_get0_public_key(key: *const EcKey) -> *const EcPoint;
    pub fn EC_KEY_set_public_key(key: *mut EcKey, public: *const EcPoint) -> c_int;
    pub fn EC_KEY_check_key(key: *const EcKey) -> c_int;
    pub fn EC_POINT_new(group: *const EcGroup) -> *mut EcPoint;
    pub fn EC_POINT_free(point: *mut EcPoint);
    pub fn EC_POINT_oct2point(
        group: *const EcGroup,
        point: *mut EcPoint,
        buf: *const u8,
        len: usize,
        ctx: *mut BnCtx,
    ) -> c_int;
    pub fn EC_POINT_point2oct(
        group: *const EcGroup,
        point: *const EcPoint,
        form: c_int,
        buf: *mut u8,
        len: usize,
        ctx: *mut BnCtx,
    ) -> usize;
    pub fn EC_POINT_mul(
        group: *const EcGroup,
        r: *mut EcPoint,
        n: *const BigNum,
        q: *const EcPoint,
        m: *const BigNum,
        ctx: *mut BnCtx,
    ) -> c_int;
    pub fn ECDH_compute_key(
        out: *mut c_void,
        out_len: usize,
        public: *const EcPoint,
        key: *const EcKey,
        kdf: *const c_void,
    ) -> c_int;
    pub fn X25519(out: *mut u8, private: *const u8, peer: *const u8) -> c_int;
}
