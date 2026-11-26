//! Cold installs read each archive once and skip checks that cannot find anything.
use std::{fs, path::Path, process::Command};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    Archives, Package, Resolver, install_packages, installed_source_path, io,
    resolve::test_support::archive, trace,
};

fn package(name: &str, chain: &[&str]) -> Package {
    Package {
        name: name.into(),
        version: "1.0.0".into(),
        chain: chain.iter().map(|part| (*part).into()).collect(),
        source_chain: None,
        meta: json!({}),
        integrity: String::new(),
        tarball: format!("https://registry.invalid/{name}/-/{name}-1.0.0.tgz"),
        local: None,
        optional: false,
        explicit_tarball: false,
    }
}

/// Runs `test` in a child process inside a fresh directory with its own install cache.
fn in_child(name: &str, variable: &str) {
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-reuse-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir(&directory).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::reuse_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(&directory)
        .env("BUN_INSTALL_CACHE_DIR", directory.join("cache"))
        .env("BUN_WASM_INSTALL_TRACE", "1")
        .env(variable, "1")
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

fn seed_cache(packages: &[&Package]) {
    fs::create_dir_all(io::cache_dir()).unwrap();
    for package in packages {
        let meta = json!({"name": package.name, "version": package.version});
        let cache =
            io::cache_dir().join(format!("{:x}", Sha256::digest(package.tarball.as_bytes())));
        fs::write(cache, archive(&meta)).unwrap();
    }
}

fn resolver(packages: &[&Package]) -> Resolver {
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({}),
        false,
    );
    for package in packages {
        resolver.packages.insert(package.key(), (*package).clone());
    }
    resolver
}

#[test]
fn a_shared_archive_is_read_once_per_install() {
    if std::env::var_os("BUN_WASM_REUSE_CHILD").is_none() {
        return in_child(
            "a_shared_archive_is_read_once_per_install",
            "BUN_WASM_REUSE_CHILD",
        );
    }
    // The same `shared` version sits at the root and nested under `outer`.
    let (root, outer, nested) = (
        package("shared", &["shared"]),
        package("outer", &["outer"]),
        package("shared", &["outer", "shared"]),
    );
    seed_cache(&[&root, &outer]);
    let all = [&root, &outer, &nested];
    trace::start();
    let (installed, _) = install_packages(&mut resolver(&all)).unwrap();
    assert_eq!(installed, 3);
    assert_eq!(trace::calls("cache-read"), 2, "each archive is read once");
    assert_eq!(
        trace::calls("present-check"),
        0,
        "nothing is installed without node_modules"
    );
    for package in all {
        let manifest = fs::read(package.path().join("package.json")).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&manifest).unwrap()["name"],
            package.name
        );
        assert!(installed_source_path(&package.path()).is_file());
    }

    // A warm tree checks what is present and installs only what is missing, from the cache.
    fs::remove_dir_all(nested.path()).unwrap();
    trace::start();
    let (installed, _) = install_packages(&mut resolver(&all)).unwrap();
    assert_eq!(installed, 1);
    assert_eq!(trace::calls("cache-read"), 1);
    assert!(trace::calls("present-check") >= 3);
    assert!(Path::new(&nested.path()).join("package.json").is_file());
}

#[test]
fn kept_archives_follow_their_remaining_uses() {
    let (first, second, other) = (
        package("shared", &["shared"]),
        package("shared", &["outer", "shared"]),
        package("other", &["other"]),
    );
    let mut archives = Archives::new([&first, &second, &other]);
    assert!(archives.take(&first.tarball).is_none());
    archives.release(&first.tarball, vec![1, 2, 3]);
    assert!(
        archives.holds(&first.tarball),
        "a second package still needs it"
    );
    archives.release(&other.tarball, vec![4]);
    assert!(
        !archives.holds(&other.tarball),
        "single-use archives are not kept"
    );
    assert_eq!(archives.take(&second.tarball), Some(vec![1, 2, 3]));
    archives.release(&second.tarball, vec![1, 2, 3]);
    assert!(!archives.holds(&second.tarball), "the last use frees it");

    // A package found installed still counts as a use.
    let mut archives = Archives::new([&first, &second]);
    archives.skip(&first);
    archives.release(&second.tarball, vec![1]);
    assert!(!archives.holds(&second.tarball));

    // Past the memory budget, a later use fetches again.
    let mut archives = Archives::new([&first, &second]);
    archives.release(&first.tarball, vec![0; super::SHARED_ARCHIVES + 1]);
    assert!(!archives.holds(&first.tarball));
}

#[test]
fn the_cache_listing_answers_for_missing_files() {
    if std::env::var_os("BUN_WASM_CACHE_LISTING_CHILD").is_none() {
        return in_child(
            "the_cache_listing_answers_for_missing_files",
            "BUN_WASM_CACHE_LISTING_CHILD",
        );
    }
    let url = "https://registry.invalid/tool/-/tool-1.0.0.tgz";
    let mut index = io::CacheIndex::listed();
    assert!(!index.may_hold(url), "no cache directory yet");
    index.store(url, b"archive");
    assert!(index.may_hold(url), "entries written later are known");
    assert!(io::CacheIndex::listed().may_hold(url));
    assert!(!io::CacheIndex::listed().may_hold("https://registry.invalid/other.tgz"));
}
