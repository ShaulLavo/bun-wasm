//! Embeds src/js/*.{js,ts} as JavaScript `POLYFILLS` and records the Bun version/revision
//! of the vendored sources.

use std::fs;
use std::path::Path;
use std::process::Command;

#[path = "build/polyfills.rs"]
mod polyfills;

fn main() {
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
