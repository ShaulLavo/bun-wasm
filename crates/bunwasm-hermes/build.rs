//! Links the static Hermes VM built by `hermes/build.sh` (in `HERMES_BUILD_DIR`). The VM's CMake
//! build also compiles `cpp/shim.cpp` into it, with the VM's own flags (defines such as
//! HERMES_SANDBOX_WASM change the VM's layout); `hermes/smoke.sh` refreshes it.
//!
//! One libc: the consumer sysroot built by Waffle, and its no-exceptions libc++.
use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-env-changed=HERMES_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    if target != "wasm32-wasip1" {
        // Host builds (cargo check) link nothing.
        return;
    }
    let hermes = PathBuf::from(
        env::var("HERMES_BUILD_DIR").expect("set HERMES_BUILD_DIR to the VM library build"),
    );
    let sysroot = PathBuf::from(env::var("BUN_WASM_SYSROOT").expect("source env.sh"));
    let libs = hermes.join("wasi/lib");
    let lib = libs.join("libhermesvm_bunwasm.a");
    assert!(
        lib.exists(),
        "{} missing: run hermes/build.sh",
        lib.display()
    );
    println!("cargo:rerun-if-changed={}", lib.display());

    let libdir = sysroot.join("lib/wasm32-wasip1");
    println!("cargo:rustc-link-search=native={}", libs.display());
    println!(
        "cargo:rustc-link-search=native={}",
        libdir.join("noeh").display()
    );
    println!("cargo:rustc-link-search=native={}", libdir.display());
    // libc++ without exceptions, and wasi-libc's process-clock emulation (Hermes's CPU-time
    // queries). bunwasm-posix provides mmap, signals and getpid.
    if env::var_os("CARGO_FEATURE_STANDALONE").is_some() {
        for lib in [
            "wasi-emulated-signal",
            "wasi-emulated-getpid",
        ] {
            println!("cargo:rustc-link-lib=static={lib}");
        }
        let crt = libdir.join("crt1-command.o");
        println!("cargo:rustc-link-arg-examples={}", crt.display());
        println!("cargo:rustc-link-arg-examples=-zstack-size=8388608");
    }
    for lib in [
        "hermesvm_bunwasm",
        "c++",
        "c++abi",
        "wasi-emulated-process-clocks",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
}
