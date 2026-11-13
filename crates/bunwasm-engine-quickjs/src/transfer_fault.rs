//! Validation builds only (`QUICKJS_TRANSFER_FAULT=1` in `scripts/build-engine-quickjs.sh`).
//! A release never compiles this module: it exists under `cfg(bun_wasm_transfer_fault)`, and
//! the producer gives such a side no receipt, so no program can be staged from it.
//!
//! The transfer native must not need memory from its first detach on (`transfer.rs`). This
//! module makes that checkable on a real guest. From the first detach until the program calls
//! `__transferFault()`, every allocation this side asks for is refused and counted: the C
//! allocator calls of QuickJS and of the Rust allocator, which the linker routes here with
//! `--wrap`, and the transport buffers the side asks the core for. A program that calls
//! `__transferFault()` as its next statement after `postMessage` therefore runs the whole
//! stretch (the detaches, the commit, the native's return through the engine's wrapper, and
//! `postMessage`'s own return) with no memory to be had, and learns how many requests were
//! refused. The message must be whole whatever that number is.
//!
//! The core's own allocator is not routed here: it is another module.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering::Relaxed};

/// wasi-libc's `ENOMEM`.
const OUT_OF_MEMORY: i32 = 48;

// One thread runs each instance of a side, and every member of a group has its own instance.
static ARMED: AtomicBool = AtomicBool::new(false);
static REFUSED: AtomicI32 = AtomicI32::new(0);

unsafe extern "C" {
    fn __real_malloc(size: usize) -> *mut c_void;
    fn __real_calloc(count: usize, size: usize) -> *mut c_void;
    fn __real_realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn __real_posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32;
    fn __real_bun_core_alloc(bytes: u32, align: u32) -> u32;
    fn __real_bun_shared_buffer_alloc(bytes: u32) -> u32;
}

fn refuse() -> bool {
    if !ARMED.load(Relaxed) {
        return false;
    }
    REFUSED.fetch_add(1, Relaxed);
    true
}

/// The first detach of a transfer: from here nothing is granted.
pub(crate) fn enter() {
    if !ARMED.swap(true, Relaxed) {
        REFUSED.store(0, Relaxed);
    }
}

/// Ends the stretch. The requests refused in it, or -1 when no transfer had detached anything.
fn leave() -> i32 {
    if !ARMED.swap(false, Relaxed) {
        return -1;
    }
    REFUSED.load(Relaxed)
}

/// Installs `__transferFault()`. It takes no arguments and returns a small integer, so the
/// engine's wrapper allocates nothing on the way in.
pub(crate) fn install(ctx: &rquickjs::Ctx<'_>) {
    let report = rquickjs::Function::new(ctx.clone(), leave).expect("transfer fault report");
    ctx.globals()
        .set("__transferFault", report)
        .expect("transfer fault global");
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_malloc(size: usize) -> *mut c_void {
    if refuse() {
        return std::ptr::null_mut();
    }
    unsafe { __real_malloc(size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_calloc(count: usize, size: usize) -> *mut c_void {
    if refuse() {
        return std::ptr::null_mut();
    }
    unsafe { __real_calloc(count, size) }
}

/// A refused `realloc` leaves the block as it was, as the C allocator's own failure does.
#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_realloc(pointer: *mut c_void, size: usize) -> *mut c_void {
    if size != 0 && refuse() {
        return std::ptr::null_mut();
    }
    unsafe { __real_realloc(pointer, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_posix_memalign(
    out: *mut *mut c_void,
    align: usize,
    size: usize,
) -> i32 {
    if refuse() {
        return OUT_OF_MEMORY;
    }
    unsafe { __real_posix_memalign(out, align, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_bun_core_alloc(bytes: u32, align: u32) -> u32 {
    if refuse() {
        return 0;
    }
    unsafe { __real_bun_core_alloc(bytes, align) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_bun_shared_buffer_alloc(bytes: u32) -> u32 {
    if refuse() {
        return 0;
    }
    unsafe { __real_bun_shared_buffer_alloc(bytes) }
}
