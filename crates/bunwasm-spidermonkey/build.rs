use std::{env, path::PathBuf};

#[path = "../bunwasm-cli/max_memory.rs"]
mod max_memory;

fn main() {
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_G2_DIR");
    println!("cargo:rerun-if-env-changed=SPIDERMONKEY_NATIVE_DIR");
    if env::var("TARGET").unwrap() != "wasm32-wasip1" {
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
