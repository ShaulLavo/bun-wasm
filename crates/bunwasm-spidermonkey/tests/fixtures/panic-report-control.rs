fn trigger(mode: &str) -> ! {
    match mode {
        "string" => panic!("selected-engine panic control"),
        "owned" => std::panic::panic_any(String::from("owned panic control")),
        "opaque" => std::panic::panic_any(42_u32),
        "overflow" => std::panic::panic_any("x".repeat(2048)),
        _ => panic!("unknown panic control"),
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn __wrap_bunsm_host_call(
    _id: u32,
    _this: u32,
    _args: *const u32,
    _argc: usize,
    _out: *mut u32,
) -> bool {
    trigger(env!("BUNSM_PANIC_CONTROL"))
}

#[cfg(not(target_arch = "wasm32"))]
#[path = "../../src/panic_report.rs"]
mod panic_report;

#[cfg(not(target_arch = "wasm32"))]
unsafe extern "C" fn bunsm_host_fatal(message: *const std::ffi::c_char, length: usize) -> ! {
    use std::io::Write;
    let bytes = unsafe { std::slice::from_raw_parts(message.cast::<u8>(), length) };
    let _ = std::io::stderr().write_all(bytes);
    std::process::exit(134)
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    std::panic::set_hook(Box::new(|info| panic_report::fatal(info)));
    trigger(&std::env::args().nth(1).expect("panic control mode"));
}
