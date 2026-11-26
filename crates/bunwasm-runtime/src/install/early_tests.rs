//! Packages installed while resolution waits: order, eligibility and reconciliation.
use std::{collections::BTreeMap, fs, path::Path, process::Command};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    Package, Resolver, early::Early, install_packages, installed_source_path, io,
    resolve::test_support::archive, trace,
};

fn package(name: &str, chain: &[&str], meta: Value) -> Package {
    let mut meta = meta;
    meta["name"] = name.into();
    meta["version"] = "1.0.0".into();
    Package {
        name: name.into(),
        version: "1.0.0".into(),
        chain: chain.iter().map(|part| (*part).into()).collect(),
        source_chain: None,
        meta,
        integrity: String::new(),
        tarball: format!("https://registry.invalid/{name}/-/{name}-1.0.0.tgz"),
        local: None,
        optional: false,
        explicit_tarball: false,
    }
}

fn plain(name: &str, chain: &[&str]) -> Package {
    package(name, chain, json!({}))
}

fn in_child(name: &str) {
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-early-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::early_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(&directory)
        .env("BUN_INSTALL_CACHE_DIR", directory.join("cache"))
        .env("BUN_WASM_INSTALL_TRACE", "1")
        .env("BUN_WASM_EARLY_CHILD", "1")
        .output();
    fs::remove_dir_all(&directory).unwrap();
    let output = output.unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child() -> bool {
    std::env::var_os("BUN_WASM_EARLY_CHILD").is_some()
}

fn seed(packages: &[&Package]) {
    fs::create_dir_all(io::cache_dir()).unwrap();
    for package in packages {
        let meta = json!({"name": package.name, "version": package.version});
        let cache =
            io::cache_dir().join(format!("{:x}", Sha256::digest(package.tarball.as_bytes())));
        fs::write(cache, archive(&meta)).unwrap();
    }
}

fn registry() -> io::Registry {
    io::Registry::new("http://registry.invalid").unwrap()
}

/// Runs early work until nothing is ready.
fn drain(early: &mut Early) -> usize {
    let mut metadata = io::Downloads::new(0);
    let mut count = 0;
    while early.work(&mut metadata, &registry()) {
        count += 1;
    }
    count
}

#[test]
fn nested_packages_wait_for_their_ancestors() {
    if !child() {
        return in_child("nested_packages_wait_for_their_ancestors");
    }
    let outer = plain("outer", &["outer"]);
    let nested = plain("inner", &["outer", "inner"]);
    let lone = plain("lone", &["missing", "lone"]);
    seed(&[&outer, &nested, &lone]);
    let mut early = Early::new(false);
    early.added(&outer, None, &registry());
    early.added(&nested, Some("outer"), &registry());
    early.added(&lone, Some("outer"), &registry());
    // Queued ahead of its parent, it must wait: installing the parent afterwards would
    // replace the directory it landed in.
    early.move_to_front("outer/inner");
    assert_eq!(drain(&mut early), 2);
    assert!(early.done.contains_key("outer") && early.done.contains_key("outer/inner"));
    assert!(
        !early.done.contains_key("missing/lone"),
        "its ancestor is not installed here"
    );
    assert!(nested.path().join("package.json").is_file());
}

#[test]
fn incompatible_and_large_packages_are_left_to_the_install_phase() {
    let registry = registry();
    let mut early = Early::new(false);
    let foreign = package("foreign", &["foreign"], json!({"os": ["darwin"]}));
    let below = plain("below", &["foreign", "below"]);
    let large = package("large", &["large"], json!({"dist": {"fileCount": 100_000}}));
    early.added(&foreign, None, &registry);
    early.added(&below, Some("foreign"), &registry);
    early.added(&large, None, &registry);
    assert_eq!(drain(&mut early), 0);
    assert!(early.done.is_empty());
}

#[test]
fn reconciliation_removes_what_the_final_graph_dropped_or_changed() {
    if !child() {
        return in_child("reconciliation_removes_what_the_final_graph_dropped_or_changed");
    }
    let kept = plain("kept", &["kept"]);
    let dropped = plain("dropped", &["dropped"]);
    let changed = plain("changed", &["changed"]);
    let inside = plain("inside", &["changed", "inside"]);
    seed(&[&kept, &dropped, &changed, &inside]);
    let mut early = Early::new(false);
    for (package, parent) in [
        (&kept, None),
        (&dropped, None),
        (&changed, None),
        (&inside, Some("changed")),
    ] {
        early.added(package, parent, &registry());
    }
    assert_eq!(drain(&mut early), 4);
    let mut replaced = changed.clone();
    replaced.tarball = "https://registry.invalid/changed/-/changed-2.0.0.tgz".into();
    let packages = BTreeMap::from([
        ("kept".to_owned(), kept.clone()),
        ("changed".to_owned(), replaced),
        ("changed/inside".to_owned(), inside.clone()),
    ]);
    early.reconcile(&packages).unwrap();
    assert_eq!(early.done.keys().collect::<Vec<_>>(), ["kept"]);
    assert!(kept.path().join("package.json").is_file());
    for gone in [&dropped, &changed, &inside] {
        assert!(!gone.path().exists(), "{} was left behind", gone.key());
        assert!(!installed_source_path(&gone.path()).exists());
    }
}

#[test]
fn the_install_phase_skips_early_installs_and_counts_them() {
    if !child() {
        return in_child("the_install_phase_skips_early_installs_and_counts_them");
    }
    let first = package("first", &["first"], json!({"bin": "cli.js"}));
    let second = plain("second", &["second"]);
    seed(&[&first, &second]);
    let mut resolver = Resolver::new(registry(), json!({}), false);
    let mut early = Early::new(false);
    early.added(&first, None, &registry());
    assert_eq!(drain(&mut early), 1);
    resolver.early = Some(early);
    for package in [&first, &second] {
        resolver.packages.insert(package.key(), package.clone());
    }
    trace::start();
    let (installed, manifests) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 2);
    assert_eq!(
        trace::calls("extract"),
        1,
        "only the second package is extracted now"
    );
    assert_eq!(manifests.keys().collect::<Vec<_>>(), ["first", "second"]);
    assert!(second.path().join("package.json").is_file());
}

fn versioned(name: &str, version: &str, chain: &[&str]) -> Package {
    let mut package = plain(name, chain);
    package.version = version.into();
    package.meta["version"] = version.into();
    package.tarball = format!("https://registry.invalid/{name}/-/{name}-{version}.tgz");
    package
}

fn installed_version(package: &Package) -> String {
    let manifest = fs::read(package.path().join("package.json")).unwrap();
    serde_json::from_slice::<Value>(&manifest).unwrap()["version"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn a_final_graph_that_hoists_differently_replaces_early_installs() {
    if !child() {
        return in_child("a_final_graph_that_hoists_differently_replaces_early_installs");
    }
    // Resolution first placed shared@1 at the root, but the final graph put shared@2 there
    // and moved shared@1 under `user`.
    let early_root = versioned("shared", "1.0.0", &["shared"]);
    let user = plain("user", &["user"]);
    let inside = versioned("shared", "1.0.0", &["user", "shared"]);
    let final_root = versioned("shared", "2.0.0", &["shared"]);
    seed(&[&early_root, &user, &final_root]);
    let mut early = Early::new(false);
    early.added(&early_root, None, &registry());
    early.added(&user, None, &registry());
    assert_eq!(drain(&mut early), 2);
    let mut resolver = Resolver::new(registry(), json!({}), false);
    resolver.early = Some(early);
    for package in [&final_root, &user, &inside] {
        resolver.packages.insert(package.key(), package.clone());
    }
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 3);
    assert_eq!(installed_version(&final_root), "2.0.0");
    assert_eq!(installed_version(&inside), "1.0.0");
    assert_eq!(
        fs::read(installed_source_path(&final_root.path())).unwrap(),
        super::installed_source(&final_root)
    );
}

#[test]
fn an_interrupted_early_install_leaves_only_complete_packages() {
    if !child() {
        return in_child("an_interrupted_early_install_leaves_only_complete_packages");
    }
    let done = plain("done", &["done"]);
    let cut = plain("cut", &["cut"]);
    seed(&[&done, &cut]);
    let mut early = Early::new(false);
    early.added(&done, None, &registry());
    assert_eq!(drain(&mut early), 1);
    // The run stops while `cut` is being extracted: its staging directory holds part of it,
    // and nothing exists at its final path.
    let staging = Path::new("node_modules/.cut.bun-wasm-tmp");
    fs::create_dir_all(staging).unwrap();
    fs::write(staging.join("partial.js"), b"half").unwrap();
    drop(early);
    assert!(
        !cut.path().exists(),
        "a package appears only by a complete rename"
    );

    // The next install sees node_modules and checks what is there.
    let mut resolver = Resolver::new(registry(), json!({}), false);
    for package in [&done, &cut] {
        resolver.packages.insert(package.key(), package.clone());
    }
    trace::start();
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 1, "the completed early install is kept");
    assert_eq!(trace::calls("extract"), 1);
    assert!(cut.path().join("package.json").is_file());
    assert!(!cut.path().join("partial.js").exists());
    assert!(!staging.exists());
}
