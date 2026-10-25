//! Links the static Hermes VM built by `hermes/build.sh` (in `HERMES_BUILD_DIR`) and compiles
//! `cpp/shim.cpp` with the flags the VM itself was built with, taken from the Hermes build's
//! compile_commands.json (defines such as HERMES_SANDBOX_WASM change the VM's layout).
//!
//! One libc: the consumer sysroot built by Waffle, and its no-exceptions libc++.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-env-changed=HERMES_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    println!("cargo:rerun-if-changed=cpp/shim.cpp");
    if target != "wasm32-wasip1" {
        // Host builds (cargo check) link nothing.
        return;
    }
    let hermes = PathBuf::from(
        env::var("HERMES_BUILD_DIR").unwrap_or_else(|_| "/work/tmp/bun-wasm-hermes".into()),
    );
    let sdk = PathBuf::from(env::var("WASI_SDK_PATH").expect("WASI_SDK_PATH (source env.sh)"));
    let sysroot = PathBuf::from(env::var("BUN_WASM_SYSROOT").expect("source env.sh"));
    let obj = hermes.join("wasi");
    let lib = obj.join("lib/libhermesvm_bunwasm.a");
    assert!(lib.exists(), "{} missing: run scripts/build-hermes.sh", lib.display());
    println!("cargo:rerun-if-changed={}", lib.display());

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    compile_shim(&sdk, &sysroot, &obj, &manifest, &out);

    let libdir = sysroot.join("lib/wasm32-wasip1");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-search=native={}", obj.join("lib").display());
    println!("cargo:rustc-link-search=native={}", libdir.join("noeh").display());
    println!("cargo:rustc-link-search=native={}", libdir.display());
    for lib in ["bunhermes_shim", "hermesvm_bunwasm"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    // libc++ without exceptions, and wasi-libc's process-clock emulation (Hermes's CPU-time
    // queries). bunwasm-posix provides mmap, signals and getpid.
    for lib in ["c++", "c++abi", "wasi-emulated-process-clocks"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
}

/// The VM's own compile command for lib/VM/Runtime.cpp, minus its input and output.
fn compile_shim(sdk: &Path, sysroot: &Path, obj: &Path, manifest: &Path, out: &Path) {
    let db = fs::read_to_string(obj.join("compile_commands.json")).expect("compile_commands.json");
    let entry = db
        .split("\"directory\":")
        .find(|e| e.contains("/lib/VM/Runtime.cpp\""))
        .expect("lib/VM/Runtime.cpp in compile_commands.json");
    let start = entry.find("\"command\": \"").unwrap() + 12;
    let command = &entry[start..start + entry[start..].find("\",\n").unwrap()];
    let mut flags = Vec::new();
    let mut words = command.split_whitespace().skip(1);
    while let Some(w) = words.next() {
        match w {
            "-o" | "-c" | "-MF" | "-MT" | "--sysroot" => {
                words.next();
            }
            "-include" | "-isystem" | "-iquote" | "-I" => {
                flags.extend([w.to_owned(), words.next().unwrap().to_owned()])
            }
            "-MD" => {}
            w if w.starts_with("--sysroot=") => {}
            w if w.starts_with('-') => flags.push(w.replace("\\\"", "\"")),
            _ => {}
        }
    }
    let o = out.join("shim.o");
    let status = Command::new(sdk.join("bin/clang++"))
        .args(&flags)
        .arg(format!("--sysroot={}", sysroot.display()))
        .arg("-c")
        .arg(manifest.join("cpp/shim.cpp"))
        .arg("-o")
        .arg(&o)
        .current_dir(obj)
        .env("PATH", "/usr/bin:/bin")
        .status()
        .expect("clang++");
    assert!(status.success(), "compiling shim.cpp failed");
    let lib = out.join("libbunhermes_shim.a");
    let _ = fs::remove_file(&lib);
    let status = Command::new(sdk.join("bin/llvm-ar"))
        .arg("rcs")
        .arg(&lib)
        .arg(&o)
        .status()
        .unwrap();
    assert!(status.success());
}
