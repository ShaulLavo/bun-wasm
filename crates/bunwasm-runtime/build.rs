//! Embeds src/js/*.{js,ts} as JavaScript `POLYFILLS` and records the Bun version/revision
//! of the vendored sources.

use std::fs;
use std::path::Path;
use std::process::Command;

#[path = "build/polyfills.rs"]
mod polyfills;

/// Google Brotli 1.2.0 (third_party/brotli), the revision Bun pins.
fn build_brotli() {
    let source = Path::new("../../third_party/brotli/c");
    let mut build = cc::Build::new();
    build.include(source.join("include")).define("BROTLI_BUILD_PORTABLE", None).warnings(false);
    for part in ["common", "dec", "enc"] {
        // Sorted: directory order is not a reproducible link-input order.
        let mut files: Vec<_> = fs::read_dir(source.join(part)).unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|s| s == "c"))
            .collect();
        files.sort();
        build.files(files);
    }
    build.compile("bunwasm_brotli");
    println!("cargo:rerun-if-changed=../../third_party/brotli/c");
}

/// zlib-ng 2.3.3 in zlib-compatible mode (third_party/zlib-ng), configured like
/// Bun's scripts/build/deps/zlib.ts but with the portable C kernels only.
fn build_zlib_ng() {
    let source = Path::new("../../third_party/zlib-ng");
    let include = Path::new(&std::env::var("OUT_DIR").unwrap()).join("zlib-ng");
    fs::create_dir_all(&include).unwrap();
    let zlib_h = fs::read_to_string(source.join("zlib.h.in")).unwrap().replace("@ZLIB_SYMBOL_PREFIX@", "");
    fs::write(include.join("zlib.h"), zlib_h).unwrap();
    let zconf_h = fs::read_to_string(source.join("zconf.h.in")).unwrap()
        .replace("#ifdef HAVE_UNISTD_H ", "#if 1 ")
        .replace("#ifdef NEED_PTRDIFF_T ", "#if 0 ");
    fs::write(include.join("zconf.h"), zconf_h).unwrap();
    fs::copy(source.join("zlib_name_mangling.h.empty"), include.join("zlib_name_mangling.h")).unwrap();
    let mut build = cc::Build::new();
    build.include(&include).include(source).include(source.join("arch/generic")).warnings(false).std("c11");
    for define in [
        "ZLIB_COMPAT", "WITH_ALL_FALLBACKS", "INFLATE_STRICT", "HAVE_ATTRIBUTE_ALIGNED",
        "HAVE_BUILTIN_ASSUME_ALIGNED", "HAVE_BUILTIN_CTZ", "HAVE_BUILTIN_CTZLL", "HAVE_VISIBILITY_HIDDEN",
        "HAVE_VISIBILITY_INTERNAL", "HAVE_POSIX_MEMALIGN", "__USE_LARGEFILE64",
    ] {
        build.define(define, None);
    }
    build.define("_LARGEFILE64_SOURCE", "1");
    for name in [
        // compress.c and uncompr.c are omitted: bunwasm-glue already exports a
        // `compress2` for Bun's crates and nothing here calls the one-shot API.
        "adler32", "cpu_features", "crc32", "crc32_braid_comb", "deflate", "deflate_fast",
        "deflate_huff", "deflate_medium", "deflate_quick", "deflate_rle", "deflate_slow", "deflate_stored",
        "functable", "infback", "inflate", "inftrees", "insert_string", "insert_string_roll", "trees",
        "zutil",
    ] {
        build.file(source.join(format!("{name}.c")));
    }
    for name in [
        "adler32_c", "adler32_fold_c", "chunkset_c", "compare256_c", "crc32_braid_c", "crc32_chorba_c",
        "crc32_fold_c", "slide_hash_c",
    ] {
        build.file(source.join(format!("arch/generic/{name}.c")));
    }
    build.compile("bunwasm_zlib");
    println!("cargo:rerun-if-changed=../../third_party/zlib-ng");
}

fn main() {
    build_brotli();
    build_zlib_ng();
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
    polyfills::embed(Path::new(&manifest), Path::new(&out));

    let bun_dir = Path::new(&manifest).join("../../vendor/bun");
    for path in [bun_dir.join(".git/HEAD"), bun_dir.join(".git/refs/heads"), bun_dir.join(".git/packed-refs")] {
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
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
