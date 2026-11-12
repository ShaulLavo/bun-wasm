//! POSIX functions that wasi-libc does not provide, implemented in Rust.
//!
//! `third_party/libc` declares them for wasm32-wasi (src/wasi/posix_compat.rs);
//! this crate supplies the symbols. Anything that cannot work in a WASI
//! sandbox fails the way a restricted POSIX system would: `-1` with `errno`
//! set to `ENOSYS`/`EPERM`, never a trap.
#![cfg(target_os = "wasi")]
#![allow(clippy::missing_safety_doc)]

use core::ffi::{c_int, c_void};

mod fdpath;
mod mman;
mod process;

pub(crate) fn set_errno(e: c_int) {
    unsafe extern "C" {
        fn __errno_location() -> *mut c_int;
    }
    // SAFETY: wasi-libc's accessor returns this program's errno, a plain global or, in a
    // shared-group member, thread-local; a plain `static` of the latter is its TLS offset.
    unsafe { *__errno_location() = e };
}

pub(crate) fn fail<T: From<i8>>(e: c_int) -> T {
    set_errno(e);
    T::from(-1)
}

/// Keeps the crate linked when nothing references a symbol directly.
pub fn init() {}

#[allow(unused)]
pub(crate) type CVoid = c_void;
