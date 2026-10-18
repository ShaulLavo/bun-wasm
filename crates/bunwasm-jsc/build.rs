//! Links the static JavaScriptCore built by `scripts/build-jsc.sh` (in `JSC_BUILD_DIR`), and
//! compiles `cpp/helpers.cpp` against JSC's private headers with the flags the JSC build used.
//!
//! One libc: every native compile and final link uses the consumer sysroot built by Waffle.
//! Rust's bundled libc stays disabled with `-C link-self-contained=no` (env.sh).
//! The sysroot overlays unchanged SDK libc++ inputs without adding stock libc search paths.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-env-changed=JSC_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
    println!("cargo:rerun-if-changed=cpp/helpers.cpp");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    bun_version(&manifest);
    if target != "wasm32-wasip1" {
        // Host builds (cargo check, tests of pure-Rust parts) link nothing.
        return;
    }
    let jsc = PathBuf::from(
        env::var("JSC_BUILD_DIR").unwrap_or_else(|_| "/work/tmp/bun-wasm-jsc".into()),
    );
    let sdk = PathBuf::from(env::var("WASI_SDK_PATH").expect("WASI_SDK_PATH (source env.sh)"));
    let sysroot = PathBuf::from(env::var("BUN_WASM_SYSROOT").expect("source env.sh"));
    let obj = jsc.join("build/jsc");
    for lib in [
        "lib/libJavaScriptCore.a",
        "lib/libWTF.a",
        "lib/libbmalloc.a",
    ] {
        assert!(
            obj.join(lib).exists(),
            "{} missing: run scripts/build-jsc.sh",
            obj.join(lib).display()
        );
        println!("cargo:rerun-if-changed={}", obj.join(lib).display());
    }
    for lib in [
        "icu/prefix/lib/libicuuc.a",
        "icu/prefix/lib/libicui18n.a",
        "icu/prefix/lib/libicudata.a",
        "shim/libwasi-compat.a",
    ] {
        println!("cargo:rerun-if-changed={}", jsc.join(lib).display());
    }

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    compile_helpers(&sdk, &sysroot, &obj, &manifest, &out);

    let libdir = sysroot.join("lib/wasm32-wasip1");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!(
        "cargo:rustc-link-search=native={}",
        obj.join("lib").display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        jsc.join("icu/prefix/lib").display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        jsc.join("shim").display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        libdir.join("noeh").display()
    );
    println!("cargo:rustc-link-search=native={}", libdir.display());
    for lib in [
        "bunjsc_helpers",
        "JavaScriptCore",
        "WTF",
        "bmalloc",
        "icui18n",
        "icuuc",
        "icudata",
        "wasi-compat",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    // libc++ (no exceptions), and the wasi-libc emulation library JSC's CPU-time code uses.
    // bunwasm-posix provides mmap, signals and getpid, so their emulation libraries stay out.
    for lib in ["c++", "c++abi", "wasi-emulated-process-clocks"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    // The binary links the patched sysroot's crt1-command.o itself (crates/bunwasm-cli/build.rs under
    // engine-jsc): link args from a dependency's build script don't reach it.
}

/// helpers.cpp uses JSC internals, so it is compiled exactly like the jsc shell (jsc.cpp):
/// same defines, include paths, forced shim header and language flags, taken from the JSC
/// build's compile_commands.json.
fn compile_helpers(sdk: &Path, sysroot: &Path, obj: &Path, manifest: &Path, out: &Path) {
    let db = fs::read_to_string(obj.join("compile_commands.json")).expect("compile_commands.json");
    let entry = db
        .split("\"directory\":")
        .find(|e| e.contains("/Source/JavaScriptCore/jsc.cpp\""))
        .expect("jsc.cpp in compile_commands.json");
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
    let src = manifest.join("cpp/helpers.cpp");
    let o = out.join("helpers.o");
    let status = Command::new(sdk.join("bin/clang++"))
        .args(&flags)
        .arg(format!("--sysroot={}", sysroot.display()))
        .arg("-c")
        .arg(&src)
        .arg("-o")
        .arg(&o)
        .current_dir(obj)
        .env("PATH", "/usr/bin:/bin")
        .status()
        .expect("clang++");
    assert!(status.success(), "compiling helpers.cpp failed");
    let lib = out.join("libbunjsc_helpers.a");
    let _ = fs::remove_file(&lib);
    let status = Command::new(sdk.join("bin/llvm-ar"))
        .arg("rcs")
        .arg(&lib)
        .arg(&o)
        .status()
        .unwrap();
    assert!(status.success());
}

fn bun_version(manifest: &Path) {
    let package_json = manifest.join("../../vendor/bun/package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let version = fs::read_to_string(&package_json)
        .ok()
        .and_then(|text| {
            let start = text.find("\"version\"")?;
            let rest = &text[start + 9..];
            let open = rest.find('"')? + 1;
            let close = rest[open..].find('"')? + open;
            Some(rest[open..close].to_owned())
        })
        .unwrap_or_else(|| "0.0.0".to_owned());
    println!("cargo:rustc-env=BUNWASM_BUN_VERSION={version}");
}
