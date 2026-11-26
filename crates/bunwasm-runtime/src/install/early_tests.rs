//! Packages prepared while resolution waits: staging, eligibility, outcomes and publication.
use std::{fs, path::Path, process::Command};

use serde_json::{Value, json};

use super::{
    Package, Resolver,
    early::{self, Early},
    install_packages, installed_source_path, io,
    resolve::test_support::{archive_entries, cache_archive, seed_cache},
    trace,
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

fn registry() -> io::Registry {
    io::Registry::new("http://registry.invalid").unwrap()
}

/// Runs early work until nothing is ready.
fn drain(early: &mut Early) -> usize {
    let mut metadata = io::Downloads::new(0);
    let mut count = 0;
    while early.work(&mut metadata, &registry(), &mut || false) {
        count += 1;
    }
    count
}

#[test]
fn early_work_stages_outside_node_modules() {
    if !child() {
        return in_child("early_work_stages_outside_node_modules");
    }
    let outer = plain("outer", &["outer"]);
    let nested = plain("inner", &["outer", "inner"]);
    seed_cache(&[&outer, &nested]);
    let mut early = Early::new(false);
    early.added(&outer, None, &registry());
    early.added(&nested, Some("outer"), &registry());
    assert_eq!(drain(&mut early), 2);
    assert_eq!(early.kinds(), ["staged", "staged"]);
    assert!(
        !Path::new("node_modules").exists(),
        "early work wrote into node_modules"
    );
    assert_eq!(fs::read_dir(early::STAGING).unwrap().count(), 2);
    assert!(early.prepared(&outer) && early.prepared(&nested));
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
    assert!(early.kinds().is_empty());
}

fn resolver_with(early: Early, packages: &[&Package]) -> Resolver {
    let mut resolver = Resolver::new(registry(), json!({}), false);
    resolver.early = Some(early);
    for package in packages {
        resolver.packages.insert(package.key(), (*package).clone());
    }
    resolver
}

#[test]
fn the_install_phase_publishes_staged_packages_and_counts_them() {
    if !child() {
        return in_child("the_install_phase_publishes_staged_packages_and_counts_them");
    }
    let first = package("first", &["first"], json!({"bin": "cli.js"}));
    let second = plain("second", &["second"]);
    seed_cache(&[&first, &second]);
    let mut early = Early::new(false);
    early.added(&first, None, &registry());
    assert_eq!(drain(&mut early), 1);
    trace::start();
    let mut resolver = resolver_with(early, &[&first, &second]);
    let (installed, manifests) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 2);
    assert_eq!(
        trace::calls("extract"),
        1,
        "only the second package is extracted now"
    );
    assert_eq!(manifests.keys().collect::<Vec<_>>(), ["first", "second"]);
    for package in [&first, &second] {
        assert!(package.path().join("package.json").is_file());
        assert_eq!(
            fs::read(installed_source_path(&package.path())).unwrap(),
            super::installed_source(package)
        );
    }
    assert_eq!(
        fs::read_dir(early::STAGING).unwrap().count(),
        0,
        "staged packages were moved"
    );
}

#[test]
fn packages_the_final_graph_dropped_or_changed_are_never_published() {
    if !child() {
        return in_child("packages_the_final_graph_dropped_or_changed_are_never_published");
    }
    let kept = plain("kept", &["kept"]);
    let dropped = plain("dropped", &["dropped"]);
    let changed = versioned("changed", "1.0.0", &["changed"]);
    let replaced = versioned("changed", "2.0.0", &["changed"]);
    seed_cache(&[&kept, &dropped, &changed, &replaced]);
    let mut early = Early::new(false);
    for package in [&kept, &dropped, &changed] {
        early.added(package, None, &registry());
    }
    assert_eq!(drain(&mut early), 3);
    let mut resolver = resolver_with(early, &[&kept, &replaced]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 2);
    assert!(!dropped.path().exists());
    assert_eq!(installed_version(&replaced), "2.0.0");
    early::discard_staging();
    assert!(!Path::new(early::STAGING).exists());
}

#[test]
fn a_fetch_that_failed_early_is_the_package_result() {
    if !child() {
        return in_child("a_fetch_that_failed_early_is_the_package_result");
    }
    // Nothing is cached and the native test host has no network: the early fetch fails.
    let required = plain("required", &["required"]);
    let mut optional = plain("optional", &["optional"]);
    optional.optional = true;
    let mut early = Early::new(false);
    early.added(&required, None, &registry());
    early.added(&optional, None, &registry());
    assert_eq!(drain(&mut early), 2);
    assert_eq!(early.kinds(), ["failed", "failed"]);
    let mut resolver = resolver_with(early, &[&optional, &required]);
    let error = install_packages(&mut resolver).unwrap_err();
    assert!(error.starts_with("required@1.0.0: "), "{error}");
    assert!(error.contains("networking support"), "{error}");
    assert!(
        !resolver.packages.contains_key("optional"),
        "the optional failure was tolerated"
    );
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
fn a_final_graph_that_hoists_differently_still_uses_what_was_staged() {
    if !child() {
        return in_child("a_final_graph_that_hoists_differently_still_uses_what_was_staged");
    }
    // Resolution first placed shared@1 at the root, but the final graph put shared@2 there
    // and moved shared@1 under `user`.
    let early_root = versioned("shared", "1.0.0", &["shared"]);
    let user = plain("user", &["user"]);
    let inside = versioned("shared", "1.0.0", &["user", "shared"]);
    let final_root = versioned("shared", "2.0.0", &["shared"]);
    seed_cache(&[&early_root, &user, &final_root]);
    let mut early = Early::new(false);
    early.added(&early_root, None, &registry());
    early.added(&user, None, &registry());
    assert_eq!(drain(&mut early), 2);
    let mut resolver = Resolver::new(registry(), json!({}), false);
    resolver.early = Some(early);
    for package in [&final_root, &user, &inside] {
        resolver.packages.insert(package.key(), package.clone());
    }
    trace::start();
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 3);
    assert_eq!(
        trace::calls("extract"),
        1,
        "shared@1, staged for the root, is published nested"
    );
    assert_eq!(installed_version(&final_root), "2.0.0");
    assert_eq!(installed_version(&inside), "1.0.0");
    assert_eq!(
        fs::read(installed_source_path(&final_root.path())).unwrap(),
        super::installed_source(&final_root)
    );
}

#[test]
fn staging_an_interrupted_run_left_is_never_published() {
    if !child() {
        return in_child("staging_an_interrupted_run_left_is_never_published");
    }
    // An earlier run was killed with `left` staged; the next run resolves a different graph.
    let left = plain("left", &["left"]);
    let other = plain("other", &["other"]);
    seed_cache(&[&left, &other]);
    let mut killed = Early::new(false);
    killed.added(&left, None, &registry());
    assert_eq!(drain(&mut killed), 1);
    drop(killed);
    assert_eq!(fs::read_dir(early::STAGING).unwrap().count(), 1);
    early::discard_staging();
    let mut early = Early::new(false);
    early.added(&other, None, &registry());
    assert_eq!(drain(&mut early), 1);
    let mut resolver = resolver_with(early, &[&other]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 1);
    assert!(!left.path().exists());
    assert_eq!(
        fs::read_dir("node_modules").unwrap().count(),
        2,
        "only other and its record"
    );
}

#[test]
fn extraction_pauses_whenever_resolution_has_its_response() {
    if !child() {
        return in_child("extraction_pauses_whenever_resolution_has_its_response");
    }
    let parent = plain("parent", &["parent"]);
    let child = plain("child", &["parent", "child"]);
    // Four entries: the manifest and three files.
    let entries: Vec<(String, Vec<u8>)> = vec![
        (
            "package/package.json".into(),
            serde_json::to_vec(&json!({"name": "parent", "version": "1.0.0"})).unwrap(),
        ),
        ("package/a.js".into(), b"a".to_vec()),
        ("package/lib/b.js".into(), b"b".to_vec()),
        ("package/lib/c.js".into(), b"c".to_vec()),
    ];
    cache_archive(&parent.tarball, &archive_entries(&entries));
    seed_cache(&[&child]);
    let mut early = Early::new(false);
    early.added(&parent, None, &registry());
    early.added(&child, Some("parent"), &registry());
    let mut metadata = io::Downloads::new(0);
    // The awaited response is always there: every call writes one entry and yields.
    let mut slices = 0;
    while early.work(&mut metadata, &registry(), &mut || true) {
        slices += 1;
        assert!(slices < 20, "extraction never finished");
    }
    assert_eq!(
        slices, 5,
        "four entries of the parent, then the child in one entry"
    );
    assert_eq!(early.kinds(), ["staged", "staged"]);
    let mut resolver = resolver_with(early, &[&parent, &child]);
    install_packages(&mut resolver).unwrap();
    assert_eq!(fs::read(parent.path().join("lib/c.js")).unwrap(), b"c");
    assert!(child.path().join("package.json").is_file());
}

#[test]
fn settling_finishes_a_paused_extraction() {
    if !child() {
        return in_child("settling_finishes_a_paused_extraction");
    }
    let parent = plain("parent", &["parent"]);
    let entries: Vec<(String, Vec<u8>)> = vec![
        (
            "package/package.json".into(),
            serde_json::to_vec(&json!({"name": "parent", "version": "1.0.0"})).unwrap(),
        ),
        ("package/a.js".into(), b"a".to_vec()),
    ];
    cache_archive(&parent.tarball, &archive_entries(&entries));
    let mut early = Early::new(false);
    early.added(&parent, None, &registry());
    assert!(early.work(&mut io::Downloads::new(0), &registry(), &mut || true));
    assert!(early.kinds().is_empty(), "paused after the first entry");
    early.settle(&registry());
    assert_eq!(early.kinds(), ["staged"]);
    let mut resolver = resolver_with(early, &[&parent]);
    install_packages(&mut resolver).unwrap();
    assert_eq!(fs::read(parent.path().join("a.js")).unwrap(), b"a");
}
