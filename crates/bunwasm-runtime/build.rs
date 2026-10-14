//! Embeds src/js/*.js as `POLYFILLS` and records the Bun version/revision
//! of the vendored sources.

use std::fs;
use std::path::Path;
use std::process::Command;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
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
    let mut table = String::from("pub static POLYFILLS: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = js_dir.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let stem = name.trim_end_matches(".js");
        table.push_str(&format!("    ({stem:?}, include_str!({:?})),\n", path.display().to_string()));
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
