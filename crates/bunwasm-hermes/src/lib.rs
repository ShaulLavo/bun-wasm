//! The Hermes VM, compiled to wasm32-wasip1 (hermes/build.sh), behind bun-wasm's C shim
//! (cpp/shim.cpp). bunwasm-runtime's Hermes engine (src/engine_hermes.rs) is its only user.
//!
//! Values are [`Handle`]s: indices into the shim's slot table, which the VM scans as GC roots.
//! A handle owns one reference (`bh_dup` adds one, `bh_release` drops one). Calls that can
//! throw return `false` and store the thrown value's handle in their out-parameter.
//!
//! The runtime implements three callbacks the shim calls: `bunhermes_host_call` (every native
//! function), `bunhermes_host_drop` (a native function was collected) and
//! `bunhermes_host_interrupt` (cancellation poll at async-break checkpoints).
use core::ffi::{c_char, c_void};

pub type Handle = u32;

/// `bh_kind` results.
pub mod kind {
    pub const UNDEFINED: i32 = 0;
    pub const NULL: i32 = 1;
    pub const BOOL: i32 = 2;
    pub const NUMBER: i32 = 3;
    pub const STRING: i32 = 4;
    pub const SYMBOL: i32 = 5;
    pub const BIGINT: i32 = 6;
    pub const OBJECT: i32 = 7;
    pub const FUNCTION: i32 = 8;
    pub const ARRAY: i32 = 9;
    pub const UINT8ARRAY: i32 = 10;
    pub const ARRAYBUFFER: i32 = 11;
}

unsafe extern "C" {
    pub fn bh_init(max_heap_mib: u32, interruptible: bool);
    pub fn bh_dup(h: Handle) -> Handle;
    pub fn bh_release(h: Handle);

    pub fn bh_undefined() -> Handle;
    pub fn bh_null() -> Handle;
    pub fn bh_bool(b: bool) -> Handle;
    pub fn bh_number(n: f64) -> Handle;
    pub fn bh_string(s: *const c_char, len: usize) -> Handle;
    pub fn bh_bigint(n: i64, is_unsigned: bool) -> Handle;
    pub fn bh_object() -> Handle;
    pub fn bh_array(length: u32) -> Handle;
    pub fn bh_uint8array(bytes: *const u8, len: usize) -> Handle;
    pub fn bh_global() -> Handle;

    pub fn bh_kind(h: Handle) -> i32;
    pub fn bh_get_bool(h: Handle) -> bool;
    pub fn bh_get_number(h: Handle) -> f64;
    pub fn bh_string_data(h: Handle, len: *mut usize, ascii: *mut bool) -> *const c_void;
    pub fn bh_get_bigint(h: Handle, out: *mut i64) -> bool;
    pub fn bh_bytes(h: Handle, len: *mut usize) -> *const u8;

    pub fn bh_get(obj: Handle, key: *const c_char, len: usize, out: *mut Handle) -> bool;
    pub fn bh_set(obj: Handle, key: *const c_char, len: usize, v: Handle, out: *mut Handle)
    -> bool;
    pub fn bh_get_index(obj: Handle, index: u32, out: *mut Handle) -> bool;
    pub fn bh_set_index(obj: Handle, index: u32, v: Handle, out: *mut Handle) -> bool;

    pub fn bh_function(name: *const c_char, len: usize, id: u32) -> Handle;
    pub fn bh_call(
        f: Handle,
        this: Handle,
        args: *const Handle,
        count: usize,
        out: *mut Handle,
    ) -> bool;
    pub fn bh_construct(f: Handle, args: *const Handle, count: usize, out: *mut Handle) -> bool;
    pub fn bh_eval(
        source: *const c_char,
        len: usize,
        url: *const c_char,
        url_len: usize,
        out: *mut Handle,
    ) -> bool;

    pub fn bh_has_jobs() -> bool;
    pub fn bh_drain_jobs(out: *mut Handle) -> bool;

    pub fn bh_strict_equals(a: Handle, b: Handle) -> bool;
    pub fn bh_instance_of(v: Handle, ctor: Handle) -> bool;
    pub fn bh_is_proxy(v: Handle) -> bool;
    pub fn bh_proxy_target(v: Handle) -> Handle;
    pub fn bh_is_error(v: Handle) -> bool;
    pub fn bh_is_detachable(v: Handle) -> bool;
    pub fn bh_detach(v: Handle);
    pub fn bh_gc();
    pub fn bh_heap_info(used: *mut f64, size: *mut f64);
}
