//! Packages prepared while resolution waits: staging, eligibility, outcomes and publication.
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::{Value, json};

use super::{
    Package, Resolver,
    early::{self, Early, staging_parent},
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

/// A scratch directory holding `project` (the child's working directory), its install cache
/// and its temporary directory, side by side.
fn scratch(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-early-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(directory.join("project")).unwrap();
    directory
}

fn in_child(name: &str) {
    let directory = scratch(name);
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::early_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(directory.join("project"))
        .env("BUN_INSTALL_CACHE_DIR", directory.join("cache"))
        .env("BUN_WASM_INSTALL_TRACE", "1")
        .env("BUN_WASM_EARLY_CHILD", "1")
        .env("TMPDIR", directory.join("tmp"))
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

/// Early work for an install in the current directory, with its staging guard.
fn start() -> (Early, early::StagingGuard) {
    Early::start(&std::env::current_dir().unwrap(), false).unwrap()
}

/// The jobs staged under `early`'s staging directory.
fn staged(early: &Early) -> usize {
    fs::read_dir(early.root()).unwrap().count()
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
fn early_work_stages_outside_the_project() {
    if !child() {
        return in_child("early_work_stages_outside_the_project");
    }
    let outer = plain("outer", &["outer"]);
    let nested = plain("inner", &["outer", "inner"]);
    seed_cache(&[&outer, &nested]);
    let (mut early, _guard) = start();
    early.added(&outer, None, &registry());
    early.added(&nested, Some("outer"), &registry());
    assert_eq!(drain(&mut early), 2);
    assert_eq!(early.kinds(), ["staged", "staged"]);
    assert!(
        !Path::new("node_modules").exists(),
        "early work wrote into node_modules"
    );
    assert_eq!(staged(&early), 2);
    assert!(
        early.root().starts_with(std::env::var("TMPDIR").unwrap()),
        "staging is not under TMPDIR"
    );
    assert_eq!(
        fs::read_dir(".").unwrap().count(),
        0,
        "early work wrote into the project"
    );
    assert!(early.prepared(&outer) && early.prepared(&nested));
}

#[test]
fn incompatible_and_large_packages_are_left_to_the_install_phase() {
    let registry = registry();
    let (mut early, _guard) = start();
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
    let (mut early, _guard) = start();
    early.added(&first, None, &registry());
    assert_eq!(drain(&mut early), 1);
    let root = early.root().to_path_buf();
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
        fs::read_dir(root).unwrap().count(),
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
    let (mut early, _guard) = start();
    for package in [&kept, &dropped, &changed] {
        early.added(package, None, &registry());
    }
    assert_eq!(drain(&mut early), 3);
    let mut resolver = resolver_with(early, &[&kept, &replaced]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 2);
    assert!(!dropped.path().exists());
    assert_eq!(installed_version(&replaced), "2.0.0");
    let root = std::fs::read_dir(std::env::var("TMPDIR").unwrap())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    drop(_guard);
    assert!(!root.exists(), "the guard left staging behind");
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
    let (mut early, _guard) = start();
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
    let (mut early, _guard) = start();
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
fn staging_an_interrupted_run_left_is_never_published_or_deleted() {
    if !child() {
        return in_child("staging_an_interrupted_run_left_is_never_published_or_deleted");
    }
    // An earlier run was killed with `left` staged; the next run resolves a different graph.
    let left = plain("left", &["left"]);
    let other = plain("other", &["other"]);
    seed_cache(&[&left, &other]);
    let (mut killed, killed_guard) = start();
    killed.added(&left, None, &registry());
    assert_eq!(drain(&mut killed), 1);
    let abandoned = killed.root().to_path_buf();
    std::mem::forget(killed_guard);
    drop(killed);
    let (mut early, guard) = start();
    early.added(&other, None, &registry());
    assert_eq!(drain(&mut early), 1);
    let root = early.root().to_path_buf();
    let mut resolver = resolver_with(early, &[&other]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 1);
    assert!(!left.path().exists());
    drop(guard);
    assert!(!root.exists(), "the install left its own staging");
    // Whether the killed run is over is not this install's to judge.
    assert!(
        abandoned.exists(),
        "an install deleted staging it did not create"
    );
}

#[test]
fn projects_sharing_a_temporary_directory_never_touch_each_others_staging() {
    let directory = scratch("shared-temp");
    let temp = directory.join("tmp");
    let start = |project: &str| {
        let cwd = directory.join(project);
        fs::create_dir_all(&cwd).unwrap();
        Early::start_in(&cwd, Some(temp.as_os_str()), false).unwrap()
    };
    // Staging of another install whose state this one cannot know, named like its own.
    let stranger = temp.join(format!("{}0", early::STAGING));
    fs::create_dir_all(stranger.join("1")).unwrap();
    let (first, first_guard) = start("first");
    let (second, second_guard) = start("second");
    let (first_root, second_root) = (first.root().to_path_buf(), second.root().to_path_buf());
    assert_ne!(first_root, second_root);
    drop((first, first_guard));
    assert!(!first_root.exists(), "the first install left its staging");
    assert!(
        second_root.exists(),
        "the first install removed the second's staging"
    );
    assert!(
        stranger.join("1").exists(),
        "an install removed staging it did not create"
    );
    drop((second, second_guard));
    assert!(!second_root.exists());
    assert!(stranger.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_temporary_directory_in_the_project_turns_early_work_off() {
    let directory = scratch("temp-in-project");
    let project = directory.join("project");
    fs::create_dir_all(directory.join("outside")).unwrap();
    // A link outside the project that leads into it.
    std::os::unix::fs::symlink(&project, directory.join("outside/link")).unwrap();
    let absolute = project.join("tmp");
    let inside: [&OsStr; 6] = [
        OsStr::new("."),
        OsStr::new(""),
        OsStr::new("tmp"),
        OsStr::new("../project/./tmp"),
        absolute.as_os_str(),
        OsStr::new("../outside/link/tmp"),
    ];
    for tmpdir in inside {
        assert_eq!(staging_parent(&project, Some(tmpdir)), None, "{tmpdir:?}");
        assert!(
            Early::start_in(&project, Some(tmpdir), false).is_none(),
            "{tmpdir:?}"
        );
    }
    assert_eq!(
        fs::read_dir(&project).unwrap().count(),
        0,
        "a skipped early install touched the project"
    );
    // Outside the project, through `..` or a link, it stages there.
    fs::create_dir_all(directory.join("tmp")).unwrap();
    assert_eq!(
        staging_parent(&project, Some(OsStr::new("../tmp"))),
        Some(directory.join("tmp"))
    );
    std::os::unix::fs::symlink(directory.join("tmp"), project.join("temp-link")).unwrap();
    assert_eq!(
        staging_parent(&project, Some(OsStr::new("temp-link"))),
        Some(directory.join("tmp")),
        "a link out of the project resolves to its target"
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_staging_that_cannot_be_moved_is_extracted_again_from_its_archive() {
    if !child() {
        return in_child("a_staging_that_cannot_be_moved_is_extracted_again_from_its_archive");
    }
    let tool = plain("tool", &["tool"]);
    seed_cache(&[&tool]);
    let (mut early, _guard) = start();
    early.added(&tool, None, &registry());
    assert_eq!(drain(&mut early), 1);
    // As if the staging sat on a filesystem the project cannot be renamed into.
    fs::remove_dir_all(early.root().join("1")).unwrap();
    trace::start();
    let mut resolver = resolver_with(early, &[&tool]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 1);
    assert_eq!(trace::calls("extract"), 1, "the kept archive was extracted");
    assert_eq!(
        trace::calls("cache-read"),
        0,
        "the archive was fetched again"
    );
    assert!(tool.path().join("package.json").is_file());
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
    let (mut early, _guard) = start();
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
    let (mut early, _guard) = start();
    early.added(&parent, None, &registry());
    assert!(early.work(&mut io::Downloads::new(0), &registry(), &mut || true));
    assert!(early.kinds().is_empty(), "paused after the first entry");
    early.settle(&registry());
    assert_eq!(early.kinds(), ["staged"]);
    let mut resolver = resolver_with(early, &[&parent]);
    install_packages(&mut resolver).unwrap();
    assert_eq!(fs::read(parent.path().join("a.js")).unwrap(), b"a");
}
