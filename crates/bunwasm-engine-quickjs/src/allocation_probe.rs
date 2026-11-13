//! Test only: counts every request this thread makes to the C allocator while it is armed.
//!
//! QuickJS and Rust's system allocator both call `malloc` and its family. In this test binary
//! those names resolve here, and each call is passed on to glibc's own entry point. A test arms
//! the counter where a stretch of code must allocate nothing and reads it where the stretch
//! ends. The counter and its switch are per thread, so tests running beside it do not count.
//!
//! This relies on glibc exporting `__libc_malloc` and its siblings, which is why the module
//! exists only for Linux with glibc. It measures the host build of the engine, not a guest.

use std::cell::Cell;
use std::ffi::c_void;

unsafe extern "C" {
    fn __libc_malloc(size: usize) -> *mut c_void;
    fn __libc_calloc(count: usize, size: usize) -> *mut c_void;
    fn __libc_realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn __libc_memalign(align: usize, size: usize) -> *mut c_void;
}

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static SEEN: Cell<usize> = const { Cell::new(0) };
}

fn note() {
    if ARMED.with(Cell::get) {
        SEEN.with(|seen| seen.set(seen.get() + 1));
    }
}

/// Starts counting this thread's allocation requests from zero.
pub(crate) fn arm() {
    SEEN.with(|seen| seen.set(0));
    ARMED.with(|armed| armed.set(true));
}

/// Stops counting and returns how many requests were made since `arm`.
pub(crate) fn disarm() -> usize {
    ARMED.with(|armed| armed.set(false));
    SEEN.with(Cell::get)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    note();
    unsafe { __libc_malloc(size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn calloc(count: usize, size: usize) -> *mut c_void {
    note();
    unsafe { __libc_calloc(count, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void {
    note();
    unsafe { __libc_realloc(pointer, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn memalign(align: usize, size: usize) -> *mut c_void {
    note();
    unsafe { __libc_memalign(align, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn aligned_alloc(align: usize, size: usize) -> *mut c_void {
    note();
    unsafe { __libc_memalign(align, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32 {
    note();
    let pointer = unsafe { __libc_memalign(align, size) };
    if pointer.is_null() {
        return 12;
    }
    unsafe { out.write(pointer) };
    0
}
