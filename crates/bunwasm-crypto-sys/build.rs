use std::path::Path;
use std::process::Command;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
    crypto(Path::new(&manifest), Path::new(&out));
}

fn check_crypto_cache(manifest: &Path, build: &Path, wasm: bool, guard: &Path) {
    let mut preflight = Command::new("cmake");
    preflight.arg(format!("-DBUILD_DIR={}", build.display()));
    if wasm {
        let sdk = std::env::var("WASI_SDK_PATH").expect("source env.sh");
        let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
        preflight.args([
            format!("-DEXPECTED_C={sdk}/bin/clang"),
            format!("-DEXPECTED_CXX={sdk}/bin/clang++"),
            "-DEXPECTED_SYSTEM=WASI".into(),
            "-DEXPECTED_PROCESSOR=wasm32".into(),
            "-DEXPECTED_TARGET=wasm32-wasip1".into(),
            format!("-DEXPECTED_SYSROOT={sysroot}"),
            format!(
                "-DEXPECTED_TOOLCHAIN_FILE={}",
                manifest.join("../../jsc/wasi-jsc.cmake").display()
            ),
        ]);
    } else {
        preflight.args([
            "-DEXPECTED_C=/usr/bin/cc",
            "-DEXPECTED_CXX=/usr/bin/c++",
            "-DEXPECTED_SYSTEM=native",
            "-DEXPECTED_TOOLCHAIN_FILE=",
            "-DEXPECTED_SYSROOT=",
        ]);
    }
    assert!(
        preflight.arg("-P").arg(guard).status().unwrap().success(),
        "BoringSSL cache does not match the requested toolchain; choose a fresh BUNWASM_BORINGSSL_BUILD"
    );
}

fn crypto(manifest: &Path, out: &Path) {
    for name in [
        "BUNWASM_BORINGSSL_SOURCE",
        "BUNWASM_BORINGSSL_BUILD",
        "WASI_SDK_PATH",
        "BUN_WASM_SYSROOT",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=c/rsa.c");
    println!("cargo:rerun-if-changed=../../jsc/wasi-jsc.cmake");
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
    // CMake can silently retain a native compiler when a WASI toolchain is requested.
    // Validate the existing compiler and target before allowing reconfiguration.
    let guard = manifest.join("../../scripts/check-cmake-cache.cmake");
    println!("cargo:rerun-if-changed={}", guard.display());
    check_crypto_cache(manifest, &build, wasm, &guard);
    let profile = program_profile(&build);
    {
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
            let flags = format!(
                "-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK{}",
                profile.c_flags()
            );
            configure
                .arg(format!(
                    "-DCMAKE_TOOLCHAIN_FILE={}",
                    manifest.join("../../jsc/wasi-jsc.cmake").display()
                ))
                .args([
                    format!("-DCMAKE_C_FLAGS={flags}"),
                    format!("-DCMAKE_CXX_FLAGS={flags}"),
                ]);
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
        check_crypto_cache(manifest, &build, wasm, &guard);
        profile.stamp(&build);
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
        let sysroot = std::env::var("BUN_WASM_SYSROOT").expect("source env.sh");
        println!("cargo:rustc-link-search=native={sysroot}/lib/wasm32-wasip1/noeh");
        println!("cargo:rustc-link-search=native={sysroot}/lib/wasm32-wasip1");
        profile.link_cxx_runtime();
    } else {
        println!("cargo:rustc-link-lib=stdc++");
    }
}

/// The program profile of this BoringSSL build (docs/shared-group-profile.md). A build
/// directory keeps the profile it was configured for; any other profile is refused.
#[derive(Clone, Copy, PartialEq)]
enum Profile {
    Split,
    SharedGroup,
}

const STAMP: &str = "bunwasm-program-profile";

fn program_profile(build: &Path) -> Profile {
    println!("cargo:rerun-if-env-changed=BUN_WASM_PROGRAM_PROFILE");
    let profile = match std::env::var("BUN_WASM_PROGRAM_PROFILE").as_deref() {
        Err(_) => Profile::Split,
        Ok("shared-group") => Profile::SharedGroup,
        Ok(other) => panic!("unsupported BUN_WASM_PROGRAM_PROFILE {other}"),
    };
    let stamp = std::fs::read_to_string(build.join(STAMP)).ok();
    let configured = build.join("CMakeCache.txt").exists();
    let matches = match stamp.as_deref() {
        Some(value) => value == profile.name(),
        // A pre-profile build directory can only be a split build.
        None => !configured || profile == Profile::Split,
    };
    assert!(
        matches,
        "BoringSSL build directory belongs to another program profile; choose a fresh BUNWASM_BORINGSSL_BUILD"
    );
    profile
}

impl Profile {
    fn name(self) -> &'static str {
        match self {
            Self::Split => "split",
            Self::SharedGroup => "shared-group",
        }
    }

    fn c_flags(self) -> &'static str {
        match self {
            Self::Split => "",
            Self::SharedGroup => " -fPIC -matomics -mbulk-memory -mmutable-globals",
        }
    }

    fn stamp(self, build: &Path) {
        std::fs::write(build.join(STAMP), self.name()).expect("BoringSSL profile stamp");
    }

    /// A PIE link prefers a shared library for `-l`; a group member must not depend on one.
    fn link_cxx_runtime(self) {
        let names: [&str; 2] = match self {
            Self::Split => ["static=c++", "static=c++abi"],
            Self::SharedGroup => ["static:+verbatim=libc++.a", "static:+verbatim=libc++abi.a"],
        };
        for name in names {
            println!("cargo:rustc-link-lib={name}");
        }
    }
}
