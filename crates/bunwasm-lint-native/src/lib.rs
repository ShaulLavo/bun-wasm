//! Native dependencies used by Bun's lint/format drivers.
#![allow(non_snake_case)] // `Bun__normalizeUTF16` is the name Bun's Rust imports.

extern crate zstd_sys;

mod normalize;

pub use normalize::Bun__normalizeUTF16;

#[cfg(target_os = "wasi")]
unsafe extern "C" {
    fn bunwasm_yarr_initialize();
}

#[cfg(target_os = "wasi")]
#[unsafe(no_mangle)]
pub fn __bun_yarr_initialize() {
    unsafe { bunwasm_yarr_initialize() };
}
