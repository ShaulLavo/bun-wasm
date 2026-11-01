//! Experimental G3 JSAPI declarations. The standalone feature retains the accepted G2 probe.
extern crate encoding_c;
extern crate encoding_c_mem;
#[allow(
    unsafe_op_in_unsafe_fn,
    reason = "Copied Mozilla C ABI glue keeps raw-pointer operations inside unsafe entry points"
)]
#[path = "glue/normalizer.rs"]
mod normalizer;
use core::ffi::c_char;
pub type Handle = u32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Config {
    pub stack_low: usize,
    pub stack_high: usize,
    pub max_gc_bytes: u32,
    pub tier: u8,
    pub interruptible: u8,
}
#[path = "../../bunwasm-cli/max_memory.rs"]
mod max_memory;

pub fn max_memory_bytes() -> u32 {
    max_memory::MAX_MEMORY_BYTES as u32
}

extern "C" {
    pub fn bsm_init(config: *const Config);
    pub fn bsm_shutdown();
    pub fn bsm_undefined() -> Handle;
    pub fn bsm_null() -> Handle;
    pub fn bsm_bool(value: u8) -> Handle;
    pub fn bsm_number_value(value: f64) -> Handle;
    pub fn bsm_string(value: *const c_char, len: usize) -> Handle;
    pub fn bsm_bigint(value: i64, unsigned: u8) -> Handle;
    pub fn bsm_global() -> Handle;
    pub fn bsm_uint8_array(bytes: *const u8, len: usize) -> Handle;
    pub fn bsm_same_value(a: Handle, b: Handle) -> bool;
    pub fn bsm_define_hidden(
        object: Handle,
        key: *const c_char,
        len: usize,
        value: Handle,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_error(kind: u32, message: *const c_char, len: usize) -> Handle;
    pub fn bsm_kind(handle: Handle) -> u32;
    pub fn bsm_dup(handle: Handle) -> Handle;
    pub fn bsm_release(handle: Handle);
    pub fn bsm_number(handle: Handle) -> f64;
    pub fn bsm_bigint_value(handle: Handle) -> i64;
    pub fn bsm_bool_value(handle: Handle) -> u8;
    pub fn bsm_string_data(handle: Handle, len: *mut usize) -> *const c_char;
    pub fn bsm_bytes(handle: Handle, len: *mut usize) -> *const u8;
    pub fn bsm_new_object() -> Handle;
    pub fn bsm_new_array(len: usize) -> Handle;
    pub fn bsm_get(object: Handle, key: *const c_char, len: usize, out: *mut Handle) -> bool;
    pub fn bsm_set(
        object: Handle,
        key: *const c_char,
        len: usize,
        value: Handle,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_keys(object: Handle) -> Handle;
    pub fn bsm_array_get(array: Handle, index: u32, out: *mut Handle) -> bool;
    pub fn bsm_array_set(array: Handle, index: u32, value: Handle) -> bool;
    pub fn bsm_function(name: *const c_char, len: usize, native_id: u32) -> Handle;
    pub fn bsm_call(
        function: Handle,
        this: Handle,
        args: *const Handle,
        len: usize,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_eval_script(
        source: *const c_char,
        len: usize,
        filename: *const c_char,
        line: i32,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_eval_module(
        source: *const c_char,
        len: usize,
        name: *const c_char,
        name_len: usize,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_import(specifier: *const c_char, len: usize, out: *mut Handle) -> bool;
    pub fn bsm_drain_jobs(out: *mut Handle) -> bool;
    pub fn bsm_terminated() -> bool;
    pub fn bsm_promise_state(handle: Handle) -> i32;
    pub fn bsm_promise_result(handle: Handle) -> Handle;
    pub fn bsm_promise_then(
        promise: Handle,
        fulfilled: Handle,
        rejected: Handle,
        out: *mut Handle,
    ) -> bool;
    pub fn bsm_external_buffer(data: *mut u8, len: usize) -> Handle;
    pub fn bsm_detach_external(handle: Handle) -> bool;
    pub fn bsm_is_detachable_buffer(handle: Handle) -> bool;
    pub fn bsm_detach_buffer(handle: Handle);
    pub fn bsm_is_proxy(handle: Handle) -> bool;
    pub fn bsm_proxy_target(handle: Handle) -> Handle;
    pub fn bsm_is_error(handle: Handle) -> bool;
    pub fn bsm_async_context() -> Handle;
    pub fn bsm_set_async_context(handle: Handle);
    pub fn bsm_gc();
    pub fn bsm_heap_info(used: *mut f64, total: *mut f64, external: *mut f64);
    pub fn bsm_eval(source: *const c_char, len: usize, status: *mut u32) -> Handle;
    pub fn bsm_answer(handle: Handle) -> f64;
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
