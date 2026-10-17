//! Native dependencies used by Bun's lint/format drivers.

extern crate zstd_sys;

#[cfg(target_os = "wasi")]
unsafe extern "C" {
    fn bunwasm_yarr_initialize();
}

#[cfg(target_os = "wasi")]
#[unsafe(no_mangle)]
pub fn __bun_yarr_initialize() {
    unsafe { bunwasm_yarr_initialize() };
}
