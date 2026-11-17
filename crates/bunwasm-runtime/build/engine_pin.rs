//! Read an engine's pinned upstream revision from its build settings (`jsc/common.sh`,
//! `spidermonkey/common.sh`, `hermes/common.sh`) so `process.versions` names the source
//! the engine was built from. The shell file stays the single place the pin lives.
pub fn read(script: &str, variable: &str) -> String {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(&manifest).join("../..").join(script);
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    let prefix = format!("{variable}=");
    let value = text
        .lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("{script} sets no {variable}"));
    value.trim_matches('"').to_owned()
}
