//! G2 only. The C++ shim owns JSAPI roots; no Engine implementation exists yet.
extern crate encoding_c;
extern crate encoding_c_mem;
#[allow(
    unsafe_op_in_unsafe_fn,
    reason = "Copied Mozilla C ABI glue keeps raw-pointer operations inside unsafe entry points"
)]
#[path = "glue/normalizer.rs"]
mod normalizer;
use core::ffi::c_char;
#[repr(C)]
pub struct Config {
    pub stack_low: usize,
    pub stack_high: usize,
    pub max_gc_bytes: u32,
    pub tier: u8,
    pub interruptible: u8,
}
extern "C" {
    pub fn bsm_init(config: *const Config);
    pub fn bsm_shutdown();
    pub fn bsm_eval(source: *const c_char, len: usize, status: *mut u32) -> u32;
    pub fn bsm_release(handle: u32);
    pub fn bsm_number(handle: u32) -> f64;
    pub fn bsm_answer(handle: u32) -> f64;
    pub fn bsm_gc();
    pub fn bsm_poll_count(tier: u8) -> u32;
    pub fn bsm_pbl_entries() -> u32;
    pub fn bsm_force_oom();
    fn bunsm_host_fatal(message: *const c_char, len: usize) -> !;
}
#[no_mangle]
pub extern "C" fn install_rust_hooks() {
    std::panic::set_hook(Box::new(|_| unsafe {
        bunsm_host_fatal(c"SpiderMonkey Rust panic".as_ptr(), 22)
    }));
}
/// # Safety
/// `reason` points to a live, NUL-terminated message for this call.
#[no_mangle]
pub unsafe extern "C" fn RustMozCrash(
    _file: *const c_char,
    _line: i32,
    reason: *const c_char,
) -> ! {
    let text = unsafe { std::ffi::CStr::from_ptr(reason) };
    unsafe { bunsm_host_fatal(text.as_ptr(), text.to_bytes().len()) }
}
