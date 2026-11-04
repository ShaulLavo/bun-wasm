//! Symbols the vendored Bun crates import from Bun's C/C++ side.
//!
//! Most come from Bun itself: `bun_native.rs` is a copy of Bun's
//! `src/sema/standalone/native.rs`, its pure-Rust stand-in for the parser's
//! native dependencies (mimalloc, highway, simdutf, WTF dtoa/parseDouble),
//! written for its parser-only binary, with real base64 and zlib added. The rest
//! (JSC helpers and link-time dispatch slots) live in `extra`. BoringSSL symbols
//! come from the shared crypto archive owner on every target.
#![allow(non_snake_case, clippy::missing_safety_doc)]
#![feature(linkage)]

extern crate bunwasm_crypto_sys;

mod bun_native;
mod bundler;
mod extra;
#[cfg(not(target_os = "wasi"))]
mod native_host;

pub use bun_native::set_stack_size;

/// Reference from a binary's `main` so the linker keeps this crate.
pub fn init() {
    // The parser checks remaining stack against this; wasm stacks are 8 MiB
    // (see the CLI's `-z stack-size`), leave headroom for the host frames.
    set_stack_size(7 << 20);
}
