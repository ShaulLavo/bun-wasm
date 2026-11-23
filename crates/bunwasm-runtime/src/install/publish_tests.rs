use std::{fs, path::PathBuf};

use serde_json::json;

use super::{Package, bin_fields, installed_source, installed_source_path, publish_package};

fn package() -> Package {
    Package {
        name: "tool".into(),
        version: "1.0.0".into(),
        chain: vec!["tool".into()],
        source_chain: None,
        meta: json!({}),
        integrity: String::new(),
        tarball: "https://registry.invalid/tool/-/tool-1.0.0.tgz".into(),
        local: None,
        optional: false,
        explicit_tarball: false,
    }
}

/// A `node_modules` with an extracted staging directory holding `contents`.
fn modules(name: &str, contents: &[u8]) -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("bun-wasm-publish-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let staging = root.join(".tool.bun-wasm-tmp");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("index.js"), contents).unwrap();
    (root.clone(), staging, root.join("tool"))
}

#[test]
fn a_failed_record_write_leaves_no_older_record_beside_new_bytes() {
    let package = package();
    let (root, staging, path) = modules("record-failure", b"new");
    // An empty directory, which a rename replaces, with a record of the same identity.
    fs::create_dir(&path).unwrap();
    fs::write(installed_source_path(&path), installed_source(&package)).unwrap();
    let result = publish_package(&staging, &path, &package, |_, _| {
        Err("synthetic record write failure".into())
    });
    assert_eq!(result.unwrap_err(), "synthetic record write failure");
    assert_eq!(fs::read(path.join("index.js")).unwrap(), b"new");
    assert!(
        !installed_source_path(&path).exists(),
        "a stale record would make the next install accept these bytes unchecked"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn publishing_replaces_an_existing_package_and_records_its_source() {
    let package = package();
    let (root, staging, path) = modules("replace", b"new");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("index.js"), b"old").unwrap();
    fs::write(installed_source_path(&path), b"[\"tool\",\"0.9.0\"]").unwrap();
    publish_package(&staging, &path, &package, super::io::write).unwrap();
    assert_eq!(fs::read(path.join("index.js")).unwrap(), b"new");
    assert!(!staging.exists());
    assert_eq!(
        fs::read(installed_source_path(&path)).unwrap(),
        installed_source(&package)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_binary_fields_outlive_extraction() {
    let manifest = json!({
        "name": "tool",
        "version": "1.0.0",
        "bin": {"tool": "cli.js"},
        "directories": {"bin": "bin", "lib": "lib"},
        "dependencies": {"other": "1.0.0"},
        "description": "x".repeat(1024),
    });
    assert_eq!(bin_fields(&manifest), json!({"bin": {"tool": "cli.js"}}));
    assert_eq!(
        bin_fields(&json!({"name": "plain", "version": "1.0.0"})),
        serde_json::Value::Null
    );
    assert_eq!(
        bin_fields(&json!({"name": "@scope/tool", "bin": "cli.js", "readme": "x"})),
        json!({"name": "@scope/tool", "bin": "cli.js"})
    );
    assert_eq!(
        bin_fields(&json!({"directories": {"bin": "bin", "man": "man"}})),
        json!({"directories": {"bin": "bin"}})
    );
}

#[test]
fn invalid_binary_values_are_dropped_at_extraction() {
    let large = "x".repeat(2 * 1024 * 1024);
    let manifest = json!({
        "name": "tool",
        "bin": {
            "ok": "cli.js",
            "nested": {"payload": large},
            "list": [large],
            "../escape": "cli.js",
            "absolute": "/etc/passwd",
            "parent": "../outside.js",
        },
    });
    assert_eq!(bin_fields(&manifest), json!({"bin": {"ok": "cli.js"}}));
    assert_eq!(
        bin_fields(&json!({"name": "tool", "bin": "../outside.js"})),
        serde_json::Value::Null
    );
    assert_eq!(
        bin_fields(&json!({"bin": {"a": 1}, "directories": {"bin": "bin"}})),
        json!({"bin": {}}),
        "a bin object still wins over directories.bin, as in binary_entries"
    );
}
