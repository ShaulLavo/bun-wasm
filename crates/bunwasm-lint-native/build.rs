use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=JSC_BUILD_DIR");
    println!("cargo:rerun-if-env-changed=WASI_SDK_PATH");
    println!("cargo:rerun-if-env-changed=BUN_WASM_SYSROOT");
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
    let jsc = PathBuf::from(
        env::var("JSC_BUILD_DIR").unwrap_or_else(|_| "/work/tmp/bun-wasm-jsc".into()),
    );
    let options = yarr_options(&jsc.join("webkit/Source/JavaScriptCore"));
    let mut source = format!(
        r#"#include "config.h"
#include <wtf/Threading.h>
#include <JavaScriptCore/Options.h>
#include <JavaScriptCore/YarrInterpreter.h>
#include <wtf/BumpPointerAllocator.h>
namespace Bun {{
{structure}
extern "C" Bun::RegularExpression* Yarr__RegularExpression__compile{bindings}
extern "C" void Yarr__RegularExpression__deinit(Bun::RegularExpression* re) {{ delete re; }}
extern "C" void bunwasm_yarr_initialize() {{ WTF::initialize(); using namespace WTF; JSC::Options::AllowUnfinalizedAccessScope scope; {options} g_jscConfig.options.isFinalized = true; }}
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

    let obj = jsc.join("build/jsc");
    let sdk = PathBuf::from(env::var("WASI_SDK_PATH").expect("source env.sh"));
    let sysroot = PathBuf::from(env::var("BUN_WASM_SYSROOT").expect("source env.sh"));
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
    let mut objects = Vec::new();
    let yarr = jsc.join("webkit/Source/JavaScriptCore/yarr");
    let sources = [
        "YarrPattern.cpp",
        "YarrInterpreter.cpp",
        "YarrCanonicalizeUCS2.cpp",
        "YarrErrorCode.cpp",
        "YarrFlags.cpp",
        "YarrUnicodeProperties.cpp",
    ];
    let paths = std::iter::once(out.join("yarr.cpp"))
        .chain(sources.map(|name| yarr.join(name)))
        .chain(std::iter::once(obj.join(
            "JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp",
        )));
    for (index, path) in paths.enumerate() {
        // Index 0 is yarr.cpp, written above by this script; watching it would rerun the
        // script on every build. Its inputs are watched where they are read.
        if index > 0 {
            println!("cargo:rerun-if-changed={}", path.display());
        }
        let object = out.join(format!("yarr-{index}.o"));
        let status = Command::new(sdk.join("bin/clang++"))
            .args(&flags)
            .arg(format!("--sysroot={}", sysroot.display()))
            .arg("-c")
            .arg(path)
            .arg("-o")
            .arg(&object)
            .current_dir(&obj)
            .status()
            .unwrap();
        assert!(status.success(), "compiling Bun's Yarr interpreter");
        objects.push(object);
    }
    let archive = out.join("libbunwasm_yarr.a");
    let _ = fs::remove_file(&archive);
    let status = Command::new(sdk.join("bin/llvm-ar"))
        .arg("rcs")
        .arg(&archive)
        .args(objects)
        .status()
        .unwrap();
    assert!(status.success());
    link(&out, &obj, &jsc, &sysroot);
}

// Yarr's VM-free interpreter reads three options. Initialize the defaults from
// the same WebKit checkout, without Options.cpp's VM/JIT initialization graph.
fn yarr_options(jsc: &Path) -> String {
    let mut names = std::collections::BTreeSet::new();
    for file in [
        "yarr/YarrInterpreter.cpp",
        "yarr/YarrPattern.cpp",
        "yarr/YarrParser.h",
    ] {
        let path = jsc.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let source = fs::read_to_string(path).unwrap();
        for call in source.split("Options::").skip(1) {
            let Some((name, rest)) = call.split_once('(') else {
                continue;
            };
            if rest.starts_with(')') && name.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                names.insert(name.to_owned());
            }
        }
    }
    let path = jsc.join("runtime/OptionsList.h");
    println!("cargo:rerun-if-changed={}", path.display());
    let source = fs::read_to_string(path).unwrap();
    let mut output = String::new();
    for name in names {
        let line = source
            .lines()
            .find(|line| line.contains(&format!(", {name},")))
            .unwrap();
        let default = line.split(',').nth(2).unwrap().trim();
        output.push_str(&format!("JSC::Options::{name}() = {default}; "));
    }
    output
}

fn compiler_flags(command: &str) -> Vec<String> {
    let mut flags = Vec::new();
    let mut words = command.split_whitespace().skip(1);
    while let Some(word) = words.next() {
        match word {
            "-o" | "-c" | "-MF" | "-MT" | "--sysroot" => {
                words.next();
            }
            "-include" | "-isystem" | "-iquote" | "-I" => {
                flags.extend([word.to_owned(), words.next().unwrap().to_owned()])
            }
            "-MD" => {}
            word if word.starts_with("--sysroot=") => {}
            word if word.starts_with('-') => flags.push(word.replace("\\\"", "\"")),
            _ => {}
        }
    }
    flags
}

fn link(out: &Path, obj: &Path, jsc: &Path, sysroot: &Path) {
    for directory in [
        out.to_path_buf(),
        obj.join("lib"),
        jsc.join("icu/prefix/lib"),
        jsc.join("shim"),
        sysroot.join("lib/wasm32-wasip1/noeh"),
        sysroot.join("lib/wasm32-wasip1"),
    ] {
        println!("cargo:rustc-link-search=native={}", directory.display());
    }
    for library in [
        "bunwasm_yarr",
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
