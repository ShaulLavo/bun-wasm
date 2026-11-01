//! Narrow BoringSSL client TLS declarations.
//!
//! Constructors return owned contexts, sessions and BIOs. Method, protocol and
//! ALPN pointers are borrowed from BoringSSL or their owning session. In particular,
//! `SSL_set_bio` transfers both BIO pointers to the SSL object, so callers must
//! disarm their Rust-side BIO owners after that call.

use std::ffi::{c_char, c_int, c_uint, c_void};

pub enum SslCtx {}
pub enum Ssl {}
pub enum SslMethod {}
pub enum Bio {}
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
    pub fn BIO_free(bio: *mut Bio) -> c_int;
    pub fn BIO_read(bio: *mut Bio, out: *mut c_void, len: c_int) -> c_int;
    pub fn BIO_write(bio: *mut Bio, input: *const c_void, len: c_int) -> c_int;
    pub fn BIO_ctrl_pending(bio: *const Bio) -> usize;
    pub fn BIO_shutdown_wr(bio: *mut Bio) -> c_int;
    pub fn ERR_get_error() -> u32;
}
