use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=JSC_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    if env::var("TARGET").unwrap() != "wasm32-wasip1" {
        return;
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let original = manifest.join("../../vendor/bun/src/jsc/bindings/RegularExpression.cpp");
    println!("cargo:rerun-if-changed={}", original.display());
    let original = fs::read_to_string(original).unwrap();
    let structure = original
        .split_once("namespace Bun {")
        .unwrap()
        .1
        .split_once("extern \"C\" Bun::RegularExpression* Yarr__RegularExpression__init")
        .unwrap()
        .0;
    let bindings = original
        .split_once("extern \"C\" Bun::RegularExpression* Yarr__RegularExpression__compile")
        .unwrap()
        .1;
    let mut source = format!(
        r#"#include "config.h"
#include "InitializeThreading.h"
#include <JavaScriptCore/Options.h>
#include <JavaScriptCore/YarrInterpreter.h>
#include <wtf/BumpPointerAllocator.h>
namespace Bun {{
{structure}
extern "C" Bun::RegularExpression* Yarr__RegularExpression__compile{bindings}
extern "C" void Yarr__RegularExpression__deinit(Bun::RegularExpression* re) {{ delete re; }}
extern "C" void bunwasm_yarr_initialize() {{ JSC::initialize(); }}
"#
    );
    let conversions = manifest.join("../../vendor/bun/src/jsc/bindings/NumberConversions.cpp");
    println!("cargo:rerun-if-changed={}", conversions.display());
    let conversions = fs::read_to_string(conversions)
        .unwrap()
        .replace("#include \"root.h\"", "#include \"config.h\"")
        .replace("[[ZIG_EXPORT(nothrow)]] ", "");
    source.push_str(&conversions);
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("yarr.cpp"), source).unwrap();
    let jsc = PathBuf::from(
        env::var("JSC_BUILD_DIR").unwrap_or_else(|_| "/work/tmp/bun-wasm-jsc".into()),
    );
    let obj = jsc.join("build/jsc");
    let sdk = PathBuf::from(env::var("WASI_SDK_PATH").expect("source env.sh"));
    let database = obj.join("compile_commands.json");
    println!("cargo:rerun-if-changed={}", database.display());
    let entries: serde_json::Value = serde_json::from_slice(&fs::read(database).unwrap()).unwrap();
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["file"]
                .as_str()
                .unwrap()
                .ends_with("/Source/JavaScriptCore/jsc.cpp")
        })
        .unwrap();
    let command = entry["command"].as_str().unwrap();
    let flags = compiler_flags(command);
    let status = Command::new(sdk.join("bin/clang++"))
        .args(flags)
        .arg("-c")
        .arg(out.join("yarr.cpp"))
        .arg("-o")
        .arg(out.join("yarr.o"))
        .current_dir(&obj)
        .status()
        .unwrap();
    assert!(status.success(), "compiling Bun's Yarr bindings");
    let status = Command::new(sdk.join("bin/llvm-ar"))
        .arg("rcs")
        .arg(out.join("libbunwasm_yarr.a"))
        .arg(out.join("yarr.o"))
        .status()
        .unwrap();
    assert!(status.success());
    link(&out, &obj, &jsc, &sdk);
}

fn compiler_flags(command: &str) -> Vec<String> {
    let mut flags = Vec::new();
    let mut words = command.split_whitespace().skip(1);
    while let Some(word) = words.next() {
        match word {
            "-o" | "-c" | "-MF" | "-MT" => {
                words.next();
            }
            "-include" | "-isystem" | "-iquote" | "-I" => {
                flags.extend([word.to_owned(), words.next().unwrap().to_owned()])
            }
            "-MD" => {}
            word if word.starts_with('-') => flags.push(word.replace("\\\"", "\"")),
            _ => {}
        }
    }
    flags
}

fn link(out: &Path, obj: &Path, jsc: &Path, sdk: &Path) {
    for directory in [
        out.to_path_buf(),
        obj.join("lib"),
        jsc.join("icu/prefix/lib"),
        jsc.join("shim"),
        sdk.join("share/wasi-sysroot/lib/wasm32-wasip1/noeh"),
        sdk.join("share/wasi-sysroot/lib/wasm32-wasip1"),
    ] {
        println!("cargo:rustc-link-search=native={}", directory.display());
    }
    for library in [
        "bunwasm_yarr",
        "JavaScriptCore",
        "WTF",
        "bmalloc",
        "icui18n",
        "icuuc",
        "icudata",
        "wasi-compat",
        "c++",
        "c++abi",
        "wasi-emulated-process-clocks",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
}
