//! Embeds src/js/*.js as `POLYFILLS` and records the Bun version/revision
//! of the vendored sources.

use std::fs;
use std::path::Path;
use std::process::Command;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
    crypto(Path::new(&manifest), Path::new(&out));
    let js_dir = Path::new(&manifest).join("src/js");
    println!("cargo:rerun-if-changed={}", js_dir.display());

    let mut names: Vec<String> = fs::read_dir(&js_dir)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".js"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    // Development aid: files in $BUNWASM_JS_OVERRIDE_DIR replace same-named
    // polyfills (handy to test a module without touching the tree).
    println!("cargo:rerun-if-env-changed=BUNWASM_JS_OVERRIDE_DIR");
    let override_dir = std::env::var_os("BUNWASM_JS_OVERRIDE_DIR").map(std::path::PathBuf::from);
    let mut table = String::from("pub static POLYFILLS: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = override_dir
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|p| p.exists())
            .unwrap_or_else(|| js_dir.join(name));
        println!("cargo:rerun-if-changed={}", path.display());
        let stem = name.trim_end_matches(".js");
        table.push_str(&format!(
            "    ({stem:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    table.push_str("];\n");
    fs::write(Path::new(&out).join("polyfills.rs"), table).unwrap();

    let bun_dir = Path::new(&manifest).join("../../vendor/bun");
    let package_json = bun_dir.join("package.json");
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
    let revision = Command::new("git")
        .args(["-C", &bun_dir.display().to_string(), "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=BUNWASM_BUN_VERSION={version}");
    println!("cargo:rustc-env=BUNWASM_BUN_REVISION={revision}");
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
    let mut legacy = cc::Build::new();
    legacy
        .cpp(true)
        .std("c++17")
        .cpp_link_stdlib(None)
        .include(source.join("include"))
        .define("BORINGSSL_IMPLEMENTATION", None)
        .define("OPENSSL_NO_ASM", None)
        .flag_if_supported("-fno-exceptions")
        .flag_if_supported("-fno-rtti");
    if wasm {
        legacy
            .define(
                "OPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED",
                None,
            )
            .define("OPENSSL_NO_SOCK", None);
    }
    for file in ["decrepit/cfb/cfb.cc", "decrepit/blowfish/blowfish.cc"] {
        println!("cargo:rerun-if-changed={}", source.join(file).display());
        legacy.file(source.join(file));
    }
    legacy.compile("bunwasm_crypto_legacy");
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
