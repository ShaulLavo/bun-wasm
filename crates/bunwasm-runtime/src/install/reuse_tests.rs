//! Cold installs read each shared archive once.
use std::{fs, path::Path, process::Command};

use serde_json::json;
use sha2::Digest;

use super::{
    Archives, Package, Resolver, install_packages, installed_source_path, io,
    resolve::test_support::{cache_file, seed_cache},
    trace,
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
    in_child_with(name, &[(variable, "1")]);
}

fn in_child_with(name: &str, variables: &[(&str, &str)]) {
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
        .envs(variables.iter().copied())
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
fn a_shared_archive_that_overgrew_while_downloading_is_kept_for_its_second_use() {
    // Two aliases of one 17 MiB archive. Its download grew past 32 MiB of capacity, which
    // depends on how its chunks arrived; counted as is, the second alias fetched it again.
    let (first, second) = (package("big", &["a-first"]), package("big", &["a-second"]));
    let overgrown = || {
        let mut bytes = Vec::with_capacity((32 << 20) + 1);
        bytes.resize(17 << 20, 7);
        bytes
    };
    let mut archives = Archives::new([&first, &second]);
    archives.release(&first.tarball, overgrown());
    assert!(
        !archives.holds(&first.tarball),
        "the budget counts the whole allocation"
    );
    let mut archives = Archives::new([&first, &second]);
    archives.release(&first.tarball, io::finished_body(overgrown()));
    assert!(
        archives.holds(&first.tarball),
        "a finished download is budgeted by its size"
    );
    assert_eq!(
        archives.take(&second.tarball).map(|bytes| bytes.len()),
        Some(17 << 20)
    );
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

    // Past the memory budget, a later use fetches again. The budget counts allocations.
    let mut archives = Archives::new([&first, &second]);
    archives.release(&first.tarball, vec![0; super::SHARED_ARCHIVES + 1]);
    assert!(!archives.holds(&first.tarball));
    let mut spare = Vec::with_capacity(super::SHARED_ARCHIVES + 1);
    spare.push(1u8);
    let mut archives = Archives::new([&first, &second]);
    archives.release(&first.tarball, spare);
    assert!(
        !archives.holds(&first.tarball),
        "one used byte, but the whole allocation counts"
    );
}

#[test]
fn the_cache_writer_recreates_a_removed_directory() {
    if std::env::var_os("BUN_WASM_CACHE_WRITER_CHILD").is_none() {
        return in_child(
            "the_cache_writer_recreates_a_removed_directory",
            "BUN_WASM_CACHE_WRITER_CHILD",
        );
    }
    let mut writer = io::CacheWriter::default();
    let first = "https://registry.invalid/a/-/a-1.0.0.tgz";
    let second = "https://registry.invalid/b/-/b-1.0.0.tgz";
    writer.store(first, b"a");
    assert_eq!(fs::read_dir(io::cache_dir()).unwrap().count(), 1);
    // Another process clears the cache between two writes.
    fs::remove_dir_all(io::cache_dir()).unwrap();
    writer.store(second, b"b");
    assert_eq!(
        fs::read_dir(io::cache_dir()).unwrap().count(),
        1,
        "the second write recreated it"
    );

    // A permission error is not retried, while the directory is there or after it vanished.
    let third = "https://registry.invalid/c/-/c-1.0.0.tgz";
    let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    let mut calls = 0;
    writer.store_with(third, b"c", |_, _| {
        calls += 1;
        Err(denied())
    });
    assert_eq!(calls, 1, "a permission error is not retried");
    let mut calls = 0;
    writer.store_with(third, b"c", |_, _| {
        calls += 1;
        // The directory disappears between the failed write and any check.
        let _ = fs::remove_dir_all(io::cache_dir());
        Err(denied())
    });
    assert_eq!(
        calls, 1,
        "a permission error is not retried after the directory vanished"
    );
    assert!(!io::cache_dir().exists());
    // A write that finds no directory is retried once, and the entry is written.
    let mut calls = 0;
    writer.store_with(third, b"c", |path, bytes| {
        calls += 1;
        io::write_atomically(path, bytes)
    });
    assert_eq!(calls, 2);
    assert_eq!(fs::read_dir(io::cache_dir()).unwrap().count(), 1);
}

fn integrity(bytes: &[u8]) -> String {
    use sha2::Sha512;
    format!(
        "sha512-{}",
        crate::encoding::base64_encode(&Sha512::digest(bytes), false)
    )
}

#[test]
fn an_archive_that_failed_is_not_reused() {
    if std::env::var_os("BUN_WASM_FAILED_REUSE_CHILD").is_none() {
        return in_child(
            "an_archive_that_failed_is_not_reused",
            "BUN_WASM_FAILED_REUSE_CHILD",
        );
    }
    // Two aliases of one archive: the optional one expects other bytes and fails, the
    // required one after it must read the archive again and install.
    let mut optional = package("tool", &["a-optional"]);
    let mut required = package("tool", &["b-required"]);
    seed_cache(&[&required]);
    let bytes = fs::read(cache_file(&required.tarball)).unwrap();
    optional.optional = true;
    optional.integrity = integrity(b"other bytes");
    required.integrity = integrity(&bytes);
    trace::start();
    let mut resolver = resolver(&[&optional, &required]);
    let (installed, _) = install_packages(&mut resolver).unwrap();
    assert_eq!(installed, 1);
    assert_eq!(
        trace::calls("cache-read"),
        2,
        "the failed bytes were not kept for the next alias"
    );
    assert!(required.path().join("package.json").is_file());
    assert!(!resolver.packages.contains_key("a-optional"));
}

#[test]
fn a_manifest_that_cannot_be_read_back_still_fails_validation() {
    if std::env::var_os("BUN_WASM_UNREADABLE_CHILD").is_none() {
        return in_child(
            "a_manifest_that_cannot_be_read_back_still_fails_validation",
            "BUN_WASM_UNREADABLE_CHILD",
        );
    }
    // A default ACL gives new files write access without read access.
    fs::create_dir("node_modules").unwrap();
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            // Lets the parent remove the tree: unreadable directories cannot be listed.
            let _ = Command::new("setfacl")
                .args(["-R", "-b", "node_modules"])
                .status();
            let _ = Command::new("chmod")
                .args(["-R", "u+rwX", "node_modules"])
                .status();
        }
    }
    let _restore = Restore;
    let acl = Command::new("setfacl")
        .args(["-d", "-m", "u::-wx,g::---,o::---", "node_modules"])
        .status();
    if !acl.is_ok_and(|status| status.success()) {
        println!("setfacl is unavailable; skipped");
        return;
    }
    fs::write("node_modules/probe", b"x").unwrap();
    if fs::read("node_modules/probe").is_ok() {
        println!("this filesystem grants read access anyway; skipped");
        return;
    }
    fs::remove_file("node_modules/probe").unwrap();
    let tool = package("tool", &["tool"]);
    seed_cache(&[&tool]);
    let error = install_packages(&mut resolver(&[&tool])).unwrap_err();
    assert!(error.contains("Tarball has no package.json"), "{error}");
}

#[test]
fn a_host_without_an_install_cache_reads_and_writes_none() {
    if std::env::var_os("BUN_WASM_CACHE_OFF_CHILD").is_none() {
        return in_child_with(
            "a_host_without_an_install_cache_reads_and_writes_none",
            &[
                ("BUN_WASM_CACHE_OFF_CHILD", "1"),
                ("BUN_WASM_INSTALL_CACHE", "off"),
            ],
        );
    }
    // The archive is in the cache, but the host turned the cache off: the install must ask
    // the network (which a native test does not have) and write nothing.
    let tool = package("tool", &["tool"]);
    seed_cache(&[&tool]);
    let error = install_packages(&mut resolver(&[&tool])).unwrap_err();
    assert!(error.contains("networking support"), "{error}");
    assert_eq!(trace::calls("cache-read"), 0);
    let mut writer = io::CacheWriter::default();
    assert!(!writer.enabled());
    writer.store("https://registry.invalid/other.tgz", b"x");
    assert_eq!(
        fs::read_dir(io::cache_dir()).unwrap().count(),
        1,
        "nothing new is written"
    );
}
