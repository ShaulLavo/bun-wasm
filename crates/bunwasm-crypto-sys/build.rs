use std::path::Path;
use std::process::Command;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
    crypto(Path::new(&manifest), Path::new(&out));
}

fn crypto(manifest: &Path, out: &Path) {
    for name in [
        "BUNWASM_BORINGSSL_SOURCE",
        "BUNWASM_BORINGSSL_BUILD",
        "WASI_SDK_PATH",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=c/rsa.c");
    let source = std::env::var_os("BUNWASM_BORINGSSL_SOURCE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../vendor/boringssl"));
    assert!(
        source.join("include/openssl/evp.h").exists(),
        "run scripts/sync-crypto.sh first"
    );
    let wasm = std::env::var("TARGET").unwrap() == "wasm32-wasip1";
    let build = std::env::var_os("BUNWASM_BORINGSSL_BUILD")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| out.join("boringssl"));
    if !build.join("libcrypto.a").exists() {
        let mut configure = Command::new("cmake");
        configure
            .arg("-S")
            .arg(&source)
            .arg("-B")
            .arg(&build)
            .args([
                "-G",
                "Ninja",
                "-DCMAKE_BUILD_TYPE=MinSizeRel",
                "-DOPENSSL_NO_ASM=1",
                "-DBUILD_TESTING=OFF",
            ]);
        if wasm {
            configure.arg(format!("-DCMAKE_TOOLCHAIN_FILE={}", manifest.join("../../jsc/wasi-jsc.cmake").display()))
                .args(["-DCMAKE_C_FLAGS=-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK", "-DCMAKE_CXX_FLAGS=-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK"]);
        } else {
            configure.args([
                "-DCMAKE_C_COMPILER=/usr/bin/cc",
                "-DCMAKE_CXX_COMPILER=/usr/bin/c++",
            ]);
        }
        assert!(
            configure.status().unwrap().success(),
            "BoringSSL configure failed"
        );
        assert!(
            Command::new("cmake")
                .arg("--build")
                .arg(&build)
                .args(["--target", "crypto", "--parallel", "2"])
                .status()
                .unwrap()
                .success(),
            "BoringSSL build failed"
        );
    }
    cc::Build::new()
        .file(manifest.join("c/rsa.c"))
        .include(source.join("include"))
        .compile("bunwasm_crypto");
    println!("cargo:rustc-link-search=native={}", build.display());
    println!("cargo:rustc-link-lib=static=crypto");
    if wasm {
        let sdk = std::env::var("WASI_SDK_PATH").unwrap();
        println!("cargo:rustc-link-search=native={sdk}/share/wasi-sysroot/lib/wasm32-wasip1/noeh");
        println!("cargo:rustc-link-search=native={sdk}/share/wasi-sysroot/lib/wasm32-wasip1");
        println!("cargo:rustc-link-lib=static=c++");
        println!("cargo:rustc-link-lib=static=c++abi");
    } else {
        println!("cargo:rustc-link-lib=stdc++");
    }
}
