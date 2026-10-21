use super::super::{lockfile, migration};
use super::*;

fn fixture(locked: bool, required: bool) -> (Resolver, Value) {
    let manifest = if required {
        json!({"dependencies": {"foreign": "1.0.0"}})
    } else {
        json!({"dependencies": {"neutral": "1.0.0", "compatible": "1.0.0"},
            "optionalDependencies": {"foreign": "1.0.0"}})
    };
    let metadata = [
        (
            "foreign",
            json!({"os": ["darwin"], "cpu": ["arm64"],
            "dependencies": {"foreign-child": "1.0.0", "neutral": "1.0.0"}}),
        ),
        ("foreign-child", json!({})),
        ("neutral", json!({})),
        ("compatible", json!({"os": ["linux"], "cpu": ["wasm32"]})),
    ];
    let mut lock = json!({"lockfileVersion": 2, "configVersion": 1,
        "workspaces": {"": migration::workspace_meta(&manifest, true)}, "packages": {}});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({}),
        false,
    );
    for (name, mut meta) in metadata {
        meta["name"] = name.into();
        meta["version"] = "1.0.0".into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{name}.tgz")});
        lock["packages"][name] = json!([
            format!("{name}@1.0.0"),
            meta["dist"]["tarball"],
            lock_info(&meta),
            ""
        ]);
        resolver
            .packuments
            .insert(name.into(), json!({"versions": {"1.0.0": meta}}));
    }
    if locked {
        resolver.locked = lock;
    }
    (resolver, manifest)
}

#[test]
fn locked_optional_platform_graph() {
    let (mut resolver, manifest) = fixture(true, false);
    resolver.packuments.clear();
    resolver.resolve(&manifest, false).unwrap();
    let install: Vec<_> = resolver.packages.keys().cloned().collect();
    println!("locked archive candidates: {install:?}");
    assert_eq!(install, ["compatible", "neutral"]);
    let text = lockfile(&manifest, &resolver).unwrap();
    for name in ["foreign", "foreign-child", "compatible", "neutral"] {
        assert!(
            text.contains(&format!("{name}@1.0.0")),
            "lost locked package {name}"
        );
    }
}

#[test]
fn unlocked_optional_platform_graph() {
    let (mut resolver, manifest) = fixture(false, false);
    resolver.resolve(&manifest, false).unwrap();
    let install: Vec<_> = resolver.packages.keys().cloned().collect();
    println!("unlocked archive candidates: {install:?}");
    assert_eq!(install, ["compatible", "neutral"]);
    let text = lockfile(&manifest, &resolver).unwrap();
    assert!(text.contains("foreign@1.0.0"));
    assert!(text.contains("foreign-child@1.0.0"));
}

#[test]
fn required_platform_mismatch_errors() {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(locked, true);
        let error = resolver.resolve(&manifest, false).unwrap_err();
        assert!(
            error.contains("foreign@1.0.0") && error.contains("not compatible"),
            "{error}"
        );
    }
}

#[test]
fn platform_rules_match_the_advertised_guest() {
    for meta in [
        json!({}),
        json!({"os": []}),
        json!({"os": "linux", "cpu": "wasm32"}),
        json!({"os": "!darwin", "cpu": "!x64"}),
        json!({"os": ["!darwin"], "cpu": ["!x64"]}),
        json!({"os": ["linux", "!darwin"], "cpu": ["wasm32"]}),
        json!({"os": ["any"], "cpu": ["any"]}),
    ] {
        assert!(compatible(&meta), "compatible metadata rejected: {meta}");
    }
    for meta in [
        json!({"os": ["darwin"]}),
        json!({"cpu": ["arm64"]}),
        json!({"os": ["!linux"]}),
        json!({"cpu": ["!wasm32"]}),
        json!({"os": ["linux", "!linux"]}),
        json!({"os": ["wasi"]}),
        json!({"os": "!linux"}),
        json!({"cpu": "x64"}),
        json!({"cpu": "none"}),
        json!({"os": ["any", "!linux"]}),
    ] {
        assert!(!compatible(&meta), "foreign metadata accepted: {meta}");
    }
}

#[test]
fn platform_archive_extraction() {
    if std::env::var_os("BUN_WASM_PLATFORM_ARCHIVE_CHILD").is_some() {
        extract_platform_archives();
        return;
    }
    let directory = std::env::temp_dir().join(format!("bun-wasm-platform-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "install::resolve::platform_tests::platform_archive_extraction",
            "--nocapture",
        ])
        .current_dir(&directory)
        .env("BUN_INSTALL_CACHE_DIR", directory.join("cache"))
        .env("BUN_WASM_PLATFORM_ARCHIVE_CHILD", "1")
        .output();
    std::fs::remove_dir_all(&directory).unwrap();
    let output = output.unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn archive(meta: &Value) -> Vec<u8> {
    let compressor = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(compressor);
    let bytes = serde_json::to_vec(meta).unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "package/package.json", bytes.as_slice())
        .unwrap();
    archive.into_inner().unwrap().finish().unwrap()
}

fn extract_platform_archives() {
    use super::super::{install_packages, write_lock};
    use sha2::{Digest, Sha256};
    std::fs::create_dir_all(io::cache_dir()).unwrap();
    for locked in [true, false] {
        let (mut resolver, manifest) = fixture(locked, false);
        for packument in resolver.packuments.values() {
            let meta = &packument["versions"]["1.0.0"];
            let url = meta["dist"]["tarball"].as_str().unwrap();
            let cache = io::cache_dir().join(format!("{:x}", Sha256::digest(url.as_bytes())));
            std::fs::write(cache, archive(meta)).unwrap();
        }
        resolver.resolve(&manifest, false).unwrap();
        if locked {
            assert_eq!(
                lockfile(&manifest, &resolver).unwrap(),
                write_lock(&resolver.locked, &resolver.registry).unwrap()
            );
        }
        let installed = install_packages(&mut resolver).unwrap();
        let mut extracted: Vec<_> = std::fs::read_dir("node_modules")
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        extracted.sort();
        println!("locked={locked}: extracted={extracted:?}, count={installed}");
        assert_eq!(extracted, ["compatible", "neutral"]);
        assert_eq!(installed, 2);
        std::fs::remove_dir_all("node_modules").unwrap();
    }
}

#[test]
fn optional_transitive_platform_mismatch() {
    for locked in [false, true] {
        let (mut resolver, mut manifest) = fixture(locked, false);
        manifest["dependencies"] = json!({"neutral": "1.0.0"});
        manifest["optionalDependencies"] = json!({});
        let optional = json!({"foreign": "1.0.0", "compatible": "1.0.0"});
        resolver.packuments.get_mut("neutral").unwrap()["versions"]["1.0.0"]["optionalDependencies"] =
            optional.clone();
        if locked {
            resolver.locked["packages"]["neutral"][2]["optionalDependencies"] = optional;
        }
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(
            resolver.packages.keys().cloned().collect::<Vec<_>>(),
            ["compatible", "neutral"]
        );
    }
}

#[test]
fn required_consumers_override_optional_hoisting() {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(locked, false);
        let required = json!({"foreign": "1.0.0"});
        resolver.packuments.get_mut("neutral").unwrap()["versions"]["1.0.0"]["dependencies"] =
            required.clone();
        if locked {
            resolver.locked["packages"]["neutral"][2]["dependencies"] = required;
        }
        let error = resolver.resolve(&manifest, false).unwrap_err();
        assert!(
            error.contains("foreign@1.0.0") && error.contains("not compatible"),
            "{error}"
        );
    }
}

#[test]
fn compatible_optional_parent_installs_neutral_required_children() {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(locked, false);
        resolver.packuments.get_mut("foreign").unwrap()["versions"]["1.0.0"]["os"] =
            json!(["linux"]);
        resolver.packuments.get_mut("foreign").unwrap()["versions"]["1.0.0"]["cpu"] =
            json!(["wasm32"]);
        if locked {
            resolver.locked["packages"]["foreign"][2]["os"] = json!(["linux"]);
            resolver.locked["packages"]["foreign"][2]["cpu"] = json!(["wasm32"]);
        }
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(
            resolver.packages.keys().cloned().collect::<Vec<_>>(),
            ["compatible", "foreign", "foreign-child", "neutral"]
        );
    }
}

#[test]
fn lossy_lock_platforms_use_exact_registry_metadata_without_rewriting_lock() {
    let (mut resolver, manifest) = fixture(true, false);
    resolver.locked["packages"]["compatible"][2] = json!({"os": "linux", "cpu": "none"});
    resolver.locked["packages"]["foreign"][2]["os"] = "linux".into();
    resolver.locked["packages"]["foreign"][2]["cpu"] = "none".into();
    resolver.packuments.get_mut("foreign").unwrap()["versions"]["1.0.0"]["os"] = json!(["linux"]);
    resolver.packuments.get_mut("foreign").unwrap()["versions"]["1.0.0"]["cpu"] =
        json!(["riscv64"]);
    resolver.packuments.get_mut("compatible").unwrap()["dist-tags"] = json!({"latest": "2.0.0"});
    resolver.packuments.get_mut("compatible").unwrap()["versions"]["2.0.0"] =
        json!({"os": ["darwin"], "cpu": ["arm64"]});
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(
        resolver.packages.keys().cloned().collect::<Vec<_>>(),
        ["compatible", "neutral"]
    );
    assert_eq!(
        lockfile(&manifest, &resolver).unwrap(),
        super::super::write_lock(&resolver.locked, &resolver.registry).unwrap()
    );
}

fn lossy_optional_lock() -> (Resolver, Value) {
    let (mut resolver, manifest) = fixture(true, false);
    resolver.registry =
        io::Registry::new("http://registry.invalid/platform-recovery-unavailable").unwrap();
    resolver.locked["packages"]["foreign"][2]["os"] = "linux".into();
    resolver.locked["packages"]["foreign"][2]["cpu"] = "none".into();
    resolver.locked["packages"]["foreign-child"][2]["cpu"] = "none".into();
    resolver.packuments.remove("foreign");
    resolver.packuments.remove("foreign-child");
    (resolver, manifest)
}

fn assert_optional_lock_preserved(mut resolver: Resolver, manifest: &Value) {
    let expected = super::super::write_lock(&resolver.locked, &resolver.registry).unwrap();
    resolver.resolve(manifest, false).unwrap();
    assert_eq!(lockfile(manifest, &resolver).unwrap(), expected);
    assert_eq!(
        resolver.packages.keys().cloned().collect::<Vec<_>>(),
        ["compatible", "neutral"]
    );
    assert_eq!(
        resolver.skipped.keys().cloned().collect::<Vec<_>>(),
        ["foreign", "foreign-child"]
    );
}

#[test]
fn unavailable_optional_platform_metadata_preserves_lock_graph() {
    for os in ["darwin", "linux"] {
        let (mut resolver, manifest) = lossy_optional_lock();
        resolver.locked["packages"]["foreign"][2]["os"] = os.into();
        assert_optional_lock_preserved(resolver, &manifest);
    }
}

#[test]
fn missing_optional_pinned_metadata_preserves_lock_graph() {
    let (mut resolver, manifest) = lossy_optional_lock();
    let latest = json!({"dist-tags": {"latest": "2.0.0"}, "versions": {"2.0.0": {}}});
    resolver.packuments.insert("foreign".into(), latest.clone());
    resolver.packuments.insert("foreign-child".into(), latest);
    assert_optional_lock_preserved(resolver, &manifest);
}

#[test]
fn required_unresolved_platform_metadata_still_errors() {
    for missing_version in [false, true] {
        let (mut resolver, manifest) = lossy_optional_lock();
        let manifest = json!({"dependencies": manifest["optionalDependencies"]});
        if missing_version {
            resolver.packuments.insert(
                "foreign".into(),
                json!({"dist-tags": {"latest": "2.0.0"}, "versions": {"2.0.0": {}}}),
            );
        }
        let error = resolver.resolve(&manifest, false).unwrap_err();
        let expected = if missing_version {
            "Locked version is missing from registry metadata"
        } else {
            "Package installation needs a host with networking support"
        };
        assert_eq!(error, expected);
    }
}
