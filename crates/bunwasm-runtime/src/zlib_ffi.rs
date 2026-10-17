//! The zlib API subset `compression.rs` calls, as zlib-ng 2.3.3 exports it in
//! zlib-compatible mode (third_party/zlib-ng, built by build.rs).

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};

pub type voidpf = *mut c_void;
pub type uInt = c_uint;
pub type alloc_func = unsafe extern "C" fn(voidpf, uInt, uInt) -> voidpf;
pub type free_func = unsafe extern "C" fn(voidpf, voidpf);

/// `z_stream` from zlib.h.
#[repr(C)]
pub struct z_stream {
    pub next_in: *mut u8,
    pub avail_in: c_uint,
    pub total_in: c_ulong,
    pub next_out: *mut u8,
    pub avail_out: c_uint,
    pub total_out: c_ulong,
    pub msg: *mut c_char,
    pub state: *mut c_void,
    pub zalloc: alloc_func,
    pub zfree: free_func,
    pub opaque: voidpf,
    pub data_type: c_int,
    pub adler: c_ulong,
    pub reserved: c_ulong,
}

pub const Z_NO_FLUSH: c_int = 0;
pub const Z_FINISH: c_int = 4;
pub const Z_OK: c_int = 0;
pub const Z_STREAM_END: c_int = 1;
pub const Z_NEED_DICT: c_int = 2;
pub const Z_ERRNO: c_int = -1;
pub const Z_STREAM_ERROR: c_int = -2;
pub const Z_DATA_ERROR: c_int = -3;
pub const Z_MEM_ERROR: c_int = -4;
pub const Z_BUF_ERROR: c_int = -5;
pub const Z_VERSION_ERROR: c_int = -6;
pub const Z_DEFLATED: c_int = 8;

unsafe extern "C" {
    pub fn zlibVersion() -> *const c_char;
    pub fn deflateInit2_(
        strm: *mut z_stream,
        level: c_int,
        method: c_int,
        window_bits: c_int,
        mem_level: c_int,
        strategy: c_int,
        version: *const c_char,
        stream_size: c_int,
    ) -> c_int;
    pub fn deflate(strm: *mut z_stream, flush: c_int) -> c_int;
    pub fn deflateEnd(strm: *mut z_stream) -> c_int;
    pub fn deflateReset(strm: *mut z_stream) -> c_int;
    pub fn deflateParams(strm: *mut z_stream, level: c_int, strategy: c_int) -> c_int;
    pub fn deflateSetDictionary(strm: *mut z_stream, dictionary: *const u8, length: uInt) -> c_int;
    pub fn inflateInit2_(strm: *mut z_stream, window_bits: c_int, version: *const c_char, stream_size: c_int) -> c_int;
    pub fn inflate(strm: *mut z_stream, flush: c_int) -> c_int;
    pub fn inflateEnd(strm: *mut z_stream) -> c_int;
    pub fn inflateReset(strm: *mut z_stream) -> c_int;
    pub fn inflateSetDictionary(strm: *mut z_stream, dictionary: *const u8, length: uInt) -> c_int;
}
