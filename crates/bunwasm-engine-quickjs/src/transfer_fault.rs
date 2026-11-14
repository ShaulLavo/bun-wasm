//! Validation sides only: `QUICKJS_TRANSFER_FAULT=1`, `JSC_TRANSFER_FAULT=1` or
//! `SPIDERMONKEY_TRANSFER_FAULT=1` to the side's producer (`scripts/src/transfer-fault.sh`).
//! A release never compiles this module: it exists under `cfg(bun_wasm_transfer_fault)`, and
//! the producer gives such a side no receipt, so no program can be staged from it. The three
//! engine crates share this file.
//!
//! The transfer native must not need memory from its first detach on (`transfer.rs`). This
//! module makes that checkable on a real guest. From the first detach until the program calls
//! `__transferFault()`, every allocation this side asks for is refused and counted: the C
//! allocator calls of the engine and of the Rust allocator, which the linker routes here with
//! `--wrap`, and the buffers the side asks the core for. A program that calls
//! `__transferFault()` as its next statement after `postMessage` therefore runs the whole
//! stretch (the detaches, the commit, the native's return through the engine's wrapper, and
//! `postMessage`'s own return) with no memory to be had, and learns how many requests were
//! refused. The message must be whole whatever that number is: an engine may ask for memory
//! there as long as it carries on when it gets none, as SpiderMonkey does when a detach
//! shrinks its view table.
//!
//! `__transferFaultWatch()` opens a stretch that only counts. `__transferFaultWatch()`
//! followed at once by `__transferFault()` measures what entering the report itself asks for,
//! so that it is not mistaken for a request of the transfer.
//!
//! Each engine installs the two functions itself, as natives that take no arguments and
//! return a small integer, so that the engine's own call path has nothing to allocate. The
//! core's allocator is not routed here: it is another module.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering::Relaxed};

/// wasi-libc's `ENOMEM`.
const OUT_OF_MEMORY: i32 = 48;
/// `MAP_FAILED`.
const NO_MAPPING: *mut c_void = usize::MAX as *mut c_void;

// One thread runs each instance of a side, and every member of a group has its own instance.
static ARMED: AtomicBool = AtomicBool::new(false);
static REFUSING: AtomicBool = AtomicBool::new(false);
static REQUESTS: AtomicI32 = AtomicI32::new(0);

unsafe extern "C" {
    fn __real_malloc(size: usize) -> *mut c_void;
    fn __real_calloc(count: usize, size: usize) -> *mut c_void;
    fn __real_realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn __real_posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32;
    fn __real_aligned_alloc(align: usize, size: usize) -> *mut c_void;
    fn __real_mmap(
        address: *mut c_void,
        length: usize,
        protection: i32,
        flags: i32,
        descriptor: i32,
        offset: i64,
    ) -> *mut c_void;
    fn __real_bun_core_alloc(bytes: u32, align: u32) -> u32;
    fn __real_bun_shared_buffer_alloc(bytes: u32) -> u32;
}

/// Counts a request made inside a stretch. True when the stretch refuses it.
fn refuse() -> bool {
    if !ARMED.load(Relaxed) {
        return false;
    }
    REQUESTS.fetch_add(1, Relaxed);
    REFUSING.load(Relaxed)
}

fn open(refusing: bool) {
    if !ARMED.swap(true, Relaxed) {
        REQUESTS.store(0, Relaxed);
    }
    REFUSING.store(refusing, Relaxed);
}

/// The first detach of a transfer: from here nothing is granted.
pub(crate) fn enter() {
    open(true);
}

/// `__transferFaultWatch()`: opens a stretch that counts and grants.
#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_transfer_fault_watch() {
    open(false);
}

/// `__transferFault()`: ends the stretch. The requests made in it, or -1 when none was open.
#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_transfer_fault_leave() -> i32 {
    if !ARMED.swap(false, Relaxed) {
        return -1;
    }
    REFUSING.store(false, Relaxed);
    REQUESTS.load(Relaxed)
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

/// A refused `realloc` leaves the block as it was, as the C allocator's own failure does. A
/// `realloc` to nothing is a release and is not a request.
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
unsafe extern "C" fn __wrap_aligned_alloc(align: usize, size: usize) -> *mut c_void {
    if refuse() {
        return std::ptr::null_mut();
    }
    unsafe { __real_aligned_alloc(align, size) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_mmap(
    address: *mut c_void,
    length: usize,
    protection: i32,
    flags: i32,
    descriptor: i32,
    offset: i64,
) -> *mut c_void {
    if refuse() {
        return NO_MAPPING;
    }
    unsafe { __real_mmap(address, length, protection, flags, descriptor, offset) }
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
