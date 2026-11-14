use std::{env, path::PathBuf};

#[path = "../bunwasm-cli/max_memory.rs"]
mod max_memory;
#[path = "../bunwasm-runtime/build/program_profile.rs"]
mod program_profile;

fn main() {
    program_profile::configure();
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_LIBCXX_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_G2_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_NATIVE_DIR");
    if env::var("TARGET").unwrap() != "wasm32-wasip1" {
        build_unicode_controls();
        return;
    }
    let standalone = env::var_os("CARGO_FEATURE_STANDALONE").is_some();
    let controls = env::var_os("CARGO_FEATURE_CONTROLS").is_some();
    let native = PathBuf::from(
        env::var(if standalone {
            "SPIDERMONKEY_G2_DIR"
        } else {
            "SPIDERMONKEY_NATIVE_DIR"
        })
        .expect("SpiderMonkey native input directory"),
    );
    let baseline = if standalone {
        PathBuf::from(env::var("SPIDERMONKEY_BUILD_DIR").expect("G1 build root"))
    } else {
        native.clone()
    };
    let headers = if standalone {
        baseline.join("obj/dist/include")
    } else {
        native.join("include")
    };
    let confdefs = if standalone {
        baseline.join("obj/js/src/js-confdefs.h")
    } else {
        native.join("js-confdefs.h")
    };
    let sysroot = PathBuf::from(env::var("BUN_WASM_SYSROOT").expect("source env.sh"));
    // A shared-group side compiles the group arms against the atomics library and links the
    // atomics libc++ (jsc/build-libcxx.sh). wasm-ld refuses the SDK's under --shared-memory.
    let shared_group = env::var("BUN_WASM_PROGRAM_PROFILE").as_deref() == Ok("shared-group");
    assert!(
        !(shared_group && standalone),
        "the standalone probe is split-only"
    );
    let libcxx = if shared_group {
        PathBuf::from(env::var("SPIDERMONKEY_LIBCXX_DIR").expect("atomics libc++ directory"))
    } else {
        sysroot.join("lib/wasm32-wasip1/noeh")
    };
    let mut shim = cc::Build::new();
    if shared_group {
        shim.define("BUN_WASM_SHARED_GROUP", "1");
    }
    if controls {
        shim.define("BUNSM_CONTROLS", "1");
    }
    if env::var_os("CARGO_FEATURE_LOOP_CONTROLS").is_some() {
        shim.define("BUNSM_LOOP_CONTROLS", "1");
    }
    shim.cpp(true)
        .file(if env::var_os("CARGO_FEATURE_STANDALONE").is_some() {
            "cpp/shim.cpp"
        } else {
            "cpp/engine.cpp"
        })
        .include(headers)
        .flag("-include")
        .flag(confdefs.to_str().unwrap())
        .flag("-fPIC")
        .flag("-fno-exceptions")
        .flag("-fno-rtti")
        .flag("-std=c++20")
        .define("BUNWASM_EMBED", "1")
        .compile("spidermonkey_shim");
    println!("cargo:rerun-if-changed=cpp/shim.cpp");
    println!("cargo:rerun-if-changed=cpp/shim.h");
    println!("cargo:rerun-if-changed=cpp/engine.cpp");
    println!("cargo:rerun-if-changed=cpp/engine.h");
    println!("cargo:rerun-if-changed=tests/engine-semantics.cpp");
    println!("cargo:rerun-if-changed=tests/require-recovery.cpp");
    println!("cargo:rerun-if-changed=tests/loop-dispatch.cpp");
    println!("cargo:rustc-link-search=native={}", native.display());
    println!("cargo:rustc-link-search=native={}", libcxx.display());
    println!("cargo:rustc-link-lib=static=spidermonkey_g2");
    println!("cargo:rustc-link-lib=static=c++");
    println!("cargo:rustc-link-lib=static=c++abi");
    for lib in if standalone || controls {
        [
            "wasi-emulated-signal",
            "wasi-emulated-getpid",
            "wasi-emulated-process-clocks",
        ]
        .as_slice()
    } else {
        &[]
    } {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    println!(
        "cargo:rustc-link-arg-examples={}",
        sysroot.join("lib/wasm32-wasip1/crt1-command.o").display()
    );
    println!("cargo:rustc-link-arg-examples=-zstack-size=8388608");
    let maximum = max_memory::MAX_MEMORY_BYTES;
    println!("cargo:rustc-link-arg-examples=--max-memory={maximum}");
}

fn build_unicode_controls() {
    if env::var_os("CARGO_FEATURE_UNICODE_CONTROLS").is_none() {
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spidermonkey/irregexp-icu");
    cc::Build::new()
        .cpp(true)
        .include(root.join("tests/platform"))
        .include(root.join("templates"))
        .include(root.join("include"))
        .file(root.join("allocator.cpp"))
        .file(root.join("icu_subset.cpp"))
        .file(root.join("tests/controls.cpp"))
        .file(root.join("generated/special-case.cc"))
        .file(root.join("tests/special-case-control.cpp"))
        .file(root.join("tests/old-special-case-control.cpp"))
        .define("V8_INTL_SUPPORT", "1")
        .flag("-std=c++20")
        .flag("-fno-exceptions")
        .flag("-fno-rtti")
        .define("BUNSM_ICU_CONTROLS", "1")
        .compile("bunwasm_icu_controls");
    println!("cargo:rerun-if-changed=../../spidermonkey/irregexp-icu");
}
