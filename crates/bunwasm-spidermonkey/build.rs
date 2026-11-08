use std::{env, path::PathBuf};

#[path = "../bunwasm-cli/max_memory.rs"]
mod max_memory;

fn main() {
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_G2_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_NATIVE_DIR");
    if env::var("TARGET").unwrap() != "wasm32-wasip1" {
        build_unicode_controls();
        return;
    }
    let standalone = env::var_os("CARGO_FEATURE_STANDALONE").is_some();
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
    cc::Build::new()
        .cpp(true)
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
    println!("cargo:rustc-link-search=native={}", native.display());
    println!(
        "cargo:rustc-link-search=native={}",
        sysroot.join("lib/wasm32-wasip1/noeh").display()
    );
    println!("cargo:rustc-link-lib=static=spidermonkey_g2");
    println!("cargo:rustc-link-lib=static=c++");
    println!("cargo:rustc-link-lib=static=c++abi");
    for lib in if standalone {
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
