//! Narrow BoringSSL client TLS declarations.
//!
//! Constructors return owned contexts, sessions and BIOs. Method, protocol and
//! ALPN pointers are borrowed from BoringSSL or their owning session. In particular,
//! `SSL_set_bio` transfers both BIO pointers to the SSL object, so callers must
//! disarm their Rust-side BIO owners after that call.

pub use crate::x509::{BIO_free, Bio};
use std::ffi::{c_char, c_int, c_uint, c_void};

pub enum SslCtx {}
pub enum Ssl {}
pub enum SslMethod {}
pub enum X509StoreCtx {}

pub const SSL_FILETYPE_PEM: c_int = 1;
pub const SSL_VERIFY_NONE: c_int = 0;
pub const SSL_VERIFY_PEER: c_int = 1;
pub const SSL_ERROR_NONE: c_int = 0;
pub const SSL_ERROR_SSL: c_int = 1;
pub const SSL_ERROR_WANT_READ: c_int = 2;
pub const SSL_ERROR_WANT_WRITE: c_int = 3;
pub const SSL_ERROR_ZERO_RETURN: c_int = 6;

unsafe extern "C" {
    pub fn TLS_client_method() -> *const SslMethod;
    pub fn SSL_CTX_new(method: *const SslMethod) -> *mut SslCtx;
    pub fn SSL_CTX_free(ctx: *mut SslCtx);
    pub fn SSL_CTX_set_verify(
        ctx: *mut SslCtx,
        mode: c_int,
        callback: Option<unsafe extern "C" fn(c_int, *mut X509StoreCtx) -> c_int>,
    );
    pub fn SSL_CTX_set_min_proto_version(ctx: *mut SslCtx, version: u16) -> c_int;
    pub fn SSL_CTX_set_max_proto_version(ctx: *mut SslCtx, version: u16) -> c_int;
    pub fn SSL_CTX_load_verify_locations(
        ctx: *mut SslCtx,
        ca_file: *const c_char,
        ca_directory: *const c_char,
    ) -> c_int;
    pub fn SSL_new(ctx: *mut SslCtx) -> *mut Ssl;
    pub fn SSL_free(ssl: *mut Ssl);
    pub fn SSL_set_connect_state(ssl: *mut Ssl);
    pub fn SSL_set_bio(ssl: *mut Ssl, read: *mut Bio, write: *mut Bio);
    pub fn SSL_do_handshake(ssl: *mut Ssl) -> c_int;
    pub fn SSL_read(ssl: *mut Ssl, out: *mut c_void, len: c_int) -> c_int;
    pub fn SSL_write(ssl: *mut Ssl, input: *const c_void, len: c_int) -> c_int;
    pub fn SSL_get_error(ssl: *const Ssl, result: c_int) -> c_int;
    pub fn SSL_shutdown(ssl: *mut Ssl) -> c_int;
    pub fn SSL_is_init_finished(ssl: *const Ssl) -> c_int;
    pub fn SSL_get_version(ssl: *const Ssl) -> *const c_char;
    pub fn SSL_get0_alpn_selected(ssl: *const Ssl, data: *mut *const u8, len: *mut c_uint);
    pub fn SSL_set_tlsext_host_name(ssl: *mut Ssl, name: *const c_char) -> c_int;
    pub fn SSL_set1_host(ssl: *mut Ssl, hostname: *const c_char) -> c_int;
    pub fn BIO_new_bio_pair(
        bio1: *mut *mut Bio,
        write1: usize,
        bio2: *mut *mut Bio,
        write2: usize,
    ) -> c_int;
    pub fn BIO_read(bio: *mut Bio, out: *mut c_void, len: c_int) -> c_int;
    pub fn BIO_write(bio: *mut Bio, input: *const c_void, len: c_int) -> c_int;
    pub fn BIO_ctrl_pending(bio: *const Bio) -> usize;
    pub fn BIO_shutdown_wr(bio: *mut Bio) -> c_int;
    pub fn ERR_get_error() -> u32;
}

// All shared certificate, key, stack and BIO types come from the X.509 module.
pub use crate::x509::{
    Certificate, ERR_clear_error, EVP_PKEY_free, Key, OPENSSL_free, OPENSSL_sk_num,
    OPENSSL_sk_value, Stack, X509_free, d2i_X509,
};
use std::ffi::c_long;

pub enum X509Store {}
pub enum X509LazyCertSet {}
pub enum SslCipher {}
pub enum CryptoBuffer {}

pub const TLS1_2_VERSION: u16 = 0x0303;
pub const TLS1_3_VERSION: u16 = 0x0304;
pub const SSL_MODE_ENABLE_PARTIAL_WRITE: u32 = 1;
pub const SSL_TLSEXT_ERR_OK: c_int = 0;
pub const SSL_TLSEXT_ERR_ALERT_FATAL: c_int = 2;

unsafe extern "C" {
    pub fn SSL_CTX_set_verify_depth(ctx: *mut SslCtx, depth: c_int);
    pub fn SSL_CTX_set_max_cert_list(ctx: *mut SslCtx, limit: usize);
    pub fn SSL_CTX_set_cert_store(ctx: *mut SslCtx, store: *mut X509Store);
    pub fn SSL_CTX_use_certificate(ctx: *mut SslCtx, certificate: *mut Certificate) -> c_int;
    pub fn SSL_CTX_add1_chain_cert(ctx: *mut SslCtx, certificate: *mut Certificate) -> c_int;
    pub fn SSL_CTX_use_PrivateKey(ctx: *mut SslCtx, key: *mut Key) -> c_int;
    pub fn SSL_CTX_check_private_key(ctx: *const SslCtx) -> c_int;
    pub fn SSL_set_verify(
        ssl: *mut Ssl,
        mode: c_int,
        callback: Option<unsafe extern "C" fn(c_int, *mut X509StoreCtx) -> c_int>,
    );
    pub fn SSL_set_mode(ssl: *mut Ssl, mode: u32) -> u32;
    pub fn SSL_set_alpn_protos(ssl: *mut Ssl, protocols: *const u8, len: usize) -> c_int;
    pub fn SSL_get_verify_result(ssl: *const Ssl) -> c_long;
    pub fn SSL_get_current_cipher(ssl: *const Ssl) -> *const SslCipher;
    pub fn SSL_CIPHER_get_name(cipher: *const SslCipher) -> *const c_char;
    pub fn SSL_get0_peer_certificates(ssl: *const Ssl) -> *const Stack;
    pub fn BIO_ctrl_get_write_guarantee(bio: *mut Bio) -> usize;
    pub fn BIO_new_mem_buf(input: *const c_void, len: isize) -> *mut Bio;
    pub fn X509_STORE_new() -> *mut X509Store;
    pub fn X509_STORE_free(store: *mut X509Store);
    pub fn X509_STORE_add_cert(store: *mut X509Store, certificate: *mut Certificate) -> c_int;
    pub fn X509_STORE_add_lazy_cert_set(store: *mut X509Store, set: *mut X509LazyCertSet) -> c_int;
    pub fn X509_LAZY_CERT_SET_new_static(
        certificates: *const *const u8,
        lengths: *const usize,
        count: usize,
    ) -> *mut X509LazyCertSet;
    pub fn X509_LAZY_CERT_SET_free(set: *mut X509LazyCertSet);
    pub fn X509_LAZY_CERT_SET_num(set: *const X509LazyCertSet) -> usize;
    pub fn X509_LAZY_CERT_SET_get0(set: *mut X509LazyCertSet, index: usize) -> *mut Certificate;
    pub fn d2i_AutoPrivateKey(
        output: *mut *mut Key,
        input: *mut *const u8,
        len: c_long,
    ) -> *mut Key;
    pub fn CRYPTO_BUFFER_data(buffer: *const CryptoBuffer) -> *const u8;
    pub fn CRYPTO_BUFFER_len(buffer: *const CryptoBuffer) -> usize;
    pub fn OPENSSL_cleanse(input: *mut c_void, len: usize);

    pub fn TLS_server_method() -> *const SslMethod;
    pub fn SSL_set_accept_state(ssl: *mut Ssl);
}

unsafe extern "C" {
    pub fn X509_STORE_up_ref(store: *mut X509Store) -> c_int;
    pub fn PEM_read_bio(
        bio: *mut Bio,
        name: *mut *mut c_char,
        header: *mut *mut c_char,
        data: *mut *mut u8,
        len: *mut c_long,
    ) -> c_int;
}

unsafe extern "C" {
    pub fn SSL_CTX_set_alpn_select_cb(
        ctx: *mut SslCtx,
        callback: Option<
            unsafe extern "C" fn(
                ssl: *mut Ssl,
                output: *mut *const u8,
                output_len: *mut u8,
                input: *const u8,
                input_len: c_uint,
                argument: *mut c_void,
            ) -> c_int,
        >,
        argument: *mut c_void,
    );
}

// Native tests use the library's explicit clock override, never production code.
pub enum X509VerifyParam {}
unsafe extern "C" {
    pub fn SSL_get0_param(ssl: *mut Ssl) -> *mut X509VerifyParam;
    pub fn X509_VERIFY_PARAM_set_time_posix(param: *mut X509VerifyParam, time: i64);
    pub fn SSL_get_servername(ssl: *const Ssl, name_type: c_int) -> *const c_char;
}
