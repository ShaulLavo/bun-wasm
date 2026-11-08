//! One cancellable wait provider for the shared-group engine and nested Wasm.
#[link(wasm_import_module = "runtime_shm")]
unsafe extern "C" {
    fn futex_wait32(address: u32, expected: i32, timeout_ns: i64) -> i32;
    fn futex_wait64(address: u32, expected: i64, timeout_ns: i64) -> i32;
    fn futex_wake(address: u32, count: u32) -> i32;
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_futex_wait32(address: u32, expected: i32, timeout_ns: i64) -> i32 {
    unsafe { futex_wait32(address, expected, timeout_ns) }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_futex_wait64(address: u32, expected: i64, timeout_ns: i64) -> i32 {
    unsafe { futex_wait64(address, expected, timeout_ns) }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_futex_wake(address: u32, count: u32) -> i32 {
    unsafe { futex_wake(address, count) }
}
