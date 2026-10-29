use super::*;

fn fixture(name: &str, backend: &str, version: &str) -> (Resolver, Value) {
    let manifest = json!({"dependencies": {name: version}});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({"workspaces": {"": manifest}, "packages": {}}),
        false,
    );
    let native = format!("@{name}/binding-linux-x64-gnu");
    let metadata = [
        (
            name,
            json!({"dependencies": {}, "optionalDependencies": {native.clone(): version}}),
        ),
        (backend, json!({"main": "official-loader.cjs"})),
        (&native, json!({"os": ["linux"], "cpu": ["x64"]})),
    ];
    for (package, mut meta) in metadata {
        meta["name"] = package.into();
        meta["version"] = version.into();
        meta["dist"] =
            json!({"tarball": format!("http://registry.invalid/{package}-{version}.tgz")});
        resolver
            .packuments
            .insert(package.into(), json!({"versions": {version: meta}}));
    }
    (resolver, manifest)
}

#[test]
fn vite_wasm_packages_lightningcss_selects_same_version_distribution() {
    let (mut resolver, manifest) = fixture("lightningcss", "lightningcss-wasm", "1.33.0");
    resolver.resolve(&manifest, false).unwrap();
    let package = &resolver.packages["lightningcss"];
    assert_eq!(package.name, "lightningcss-wasm");
    assert_eq!(package.version, "1.33.0");
    assert!(package.tarball.ends_with("lightningcss-wasm-1.33.0.tgz"));
    assert_eq!(package.path(), PathBuf::from("node_modules/lightningcss"));
}

#[test]
fn vite_wasm_packages_official_bindings_are_required_and_same_version() {
    for (name, backend, version) in [
        ("rolldown", "@rolldown/binding-wasm32-wasi", "1.2.15"),
        ("oxc-parser", "@oxc-parser/binding-wasm32-wasi", "0.156.0"),
        (
            "oxc-transform",
            "@oxc-transform/binding-wasm32-wasi",
            "0.156.0",
        ),
    ] {
        let (mut resolver, manifest) = fixture(name, backend, version);
        resolver.resolve(&manifest, false).unwrap();
        let package = resolver
            .packages
            .get(backend)
            .expect("official Wasm binding must be installed");
        assert_eq!(package.version, version);
        assert!(!package.optional);
        assert_eq!(resolver.packages[name].name, name);
        assert_eq!(
            resolver.packages[name].meta["dependencies"][backend],
            version
        );
    }
}

#[test]
fn vite_wasm_packages_lock_replays_without_registry_or_wrong_archive_identity() {
    for (name, backend, version) in [
        ("lightningcss", "lightningcss-wasm", "1.33.0"),
        ("rolldown", "@rolldown/binding-wasm32-wasi", "1.2.15"),
        (
            "oxc-transform",
            "@oxc-transform/binding-wasm32-wasi",
            "0.156.0",
        ),
    ] {
        let (mut resolver, manifest) = fixture(name, backend, version);
        resolver.resolve(&manifest, false).unwrap();
        let mut locked = json!({"workspaces": {"": manifest}, "packages": {}});
        for (key, package) in resolver.packages.iter().chain(&resolver.skipped) {
            locked["packages"][key] = json!([
                format!("{}@{}", package.name, package.version),
                package.tarball,
                lock_info(&package.meta),
                package.integrity
            ]);
        }
        let original = locked.clone();
        let mut replay = Resolver::new(resolver.registry.clone(), locked, false);
        replay.resolve(&manifest, false).unwrap();
        assert_eq!(replay.packages[name].name, resolver.packages[name].name);
        assert_eq!(
            replay.packages[name].tarball,
            resolver.packages[name].tarball
        );
        assert_eq!(replay.packages.len(), resolver.packages.len());
        assert!(replay.packuments.is_empty());
        assert_eq!(replay.locked, original);
    }
}

#[test]
fn vite_wasm_packages_missing_same_version_fails_without_another_version_fallback() {
    let backend = "@rolldown/binding-wasm32-wasi";
    let (mut resolver, manifest) = fixture("rolldown", backend, "1.2.15");
    resolver.packuments.get_mut(backend).unwrap()["versions"] = json!({"1.2.16": {
        "name": backend, "version": "1.2.16", "dist": {"tarball": "http://registry.invalid/newer.tgz"}
    }});
    let error = resolver.resolve(&manifest, false).unwrap_err();
    assert!(error.contains("1.2.15"), "{error}");
    assert!(error.contains(backend), "{error}");
}

#[test]
fn vite_wasm_packages_optional_backend_becomes_required_at_the_compiler_version() {
    let backend = "@oxc-parser/binding-wasm32-wasi";
    let (mut resolver, manifest) = fixture("oxc-parser", backend, "0.156.0");
    resolver.packuments.get_mut("oxc-parser").unwrap()["versions"]["0.156.0"]["optionalDependencies"]
        [backend] = "0.156.0".into();
    resolver.resolve(&manifest, false).unwrap();
    assert!(!resolver.packages[backend].optional);
    assert!(
        resolver.packages["oxc-parser"].meta["optionalDependencies"]
            .get(backend)
            .is_none()
    );
}

#[test]
fn vite_wasm_packages_native_lightningcss_lock_cannot_supply_wasm_archive_or_integrity() {
    let (mut resolver, manifest) = fixture("lightningcss", "lightningcss-wasm", "1.33.0");
    resolver.locked["packages"]["lightningcss"] = json!([
        "lightningcss@1.33.0",
        "http://registry.invalid/native.tgz",
        {},
        "native-integrity"
    ]);
    resolver.packuments.get_mut("lightningcss-wasm").unwrap()["versions"]["1.33.0"]["dist"]["integrity"] =
        "sha512-OLAtqEyInBSVWjPrTjpLzcZUMUHO0q+2PFBXKr86nxZOu0P38givj/ZMtRaZ0d38pMTb9wQx+LtaLtHclv+sEA==".into();
    resolver.resolve(&manifest, false).unwrap();
    let selected = &resolver.packages["lightningcss"];
    assert_eq!(selected.name, "lightningcss-wasm");
    assert_eq!(
        selected.integrity,
        "sha512-OLAtqEyInBSVWjPrTjpLzcZUMUHO0q+2PFBXKr86nxZOu0P38givj/ZMtRaZ0d38pMTb9wQx+LtaLtHclv+sEA=="
    );
    assert!(selected.tarball.ends_with("lightningcss-wasm-1.33.0.tgz"));
}

#[test]
fn vite_wasm_packages_archive_extraction_uses_selected_package_identity() {
    if std::env::var_os("BUN_WASM_VITE_PACKAGES_CHILD").is_some() {
        extract_selected_archives();
        return;
    }
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-vite-packages-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "install::resolve::wasm_packages_tests::vite_wasm_packages_archive_extraction_uses_selected_package_identity", "--nocapture"])
        .current_dir(&directory)
        .env("BUN_INSTALL_CACHE_DIR", directory.join("cache"))
        .env("BUN_WASM_VITE_PACKAGES_CHILD", "1")
        .output();
    std::fs::remove_dir_all(&directory).unwrap();
    let output = output.unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
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

fn seed_archives(resolver: &Resolver, version: &str) {
    use sha2::{Digest, Sha256};
    std::fs::create_dir_all(io::cache_dir()).unwrap();
    for packument in resolver.packuments.values() {
        let meta = &packument["versions"][version];
        let url = meta["dist"]["tarball"].as_str().unwrap();
        let cache = io::cache_dir().join(format!("{:x}", Sha256::digest(url.as_bytes())));
        std::fs::write(cache, archive(meta)).unwrap();
    }
}

fn extract_selected_archives() {
    use super::super::install_packages;
    for (name, backend, version) in [
        ("lightningcss", "lightningcss-wasm", "1.33.0"),
        ("rolldown", "@rolldown/binding-wasm32-wasi", "1.2.15"),
        (
            "oxc-transform",
            "@oxc-transform/binding-wasm32-wasi",
            "0.156.0",
        ),
    ] {
        let (mut resolver, manifest) = fixture(name, backend, version);
        seed_archives(&resolver, version);
        resolver.resolve(&manifest, false).unwrap();
        install_packages(&mut resolver).unwrap();
        let installed = std::fs::read(format!("node_modules/{backend}/package.json"));
        let installed = if name == "lightningcss" {
            std::fs::read("node_modules/lightningcss/package.json").unwrap()
        } else {
            installed.unwrap()
        };
        let meta: Value = serde_json::from_slice(&installed).unwrap();
        assert_eq!(meta["name"], backend);
        assert_eq!(meta["version"], version);
        assert!(!PathBuf::from(format!("node_modules/@{name}/binding-linux-x64-gnu")).exists());
    }
}

#[test]
fn vite_wasm_packages_existing_rolldown_lock_adds_the_missing_required_backend() {
    let backend = "@rolldown/binding-wasm32-wasi";
    let (mut resolver, manifest) = fixture("rolldown", backend, "1.2.15");
    let meta = &resolver.packuments["rolldown"]["versions"]["1.2.15"];
    resolver.locked["packages"]["rolldown"] = json!([
        "rolldown@1.2.15",
        meta["dist"]["tarball"],
        lock_info(meta),
        ""
    ]);
    resolver.packuments.remove("rolldown");
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(resolver.packages[backend].version, "1.2.15");
    assert!(!resolver.packages[backend].optional);
}

#[test]
fn vite_wasm_packages_optional_compiler_keeps_its_backend_optional() {
    let backend = "@rolldown/binding-wasm32-wasi";
    let (mut resolver, _) = fixture("rolldown", backend, "1.2.15");
    resolver
        .resolve(
            &json!({"optionalDependencies": {"rolldown": "1.2.15"}}),
            false,
        )
        .unwrap();
    assert!(resolver.packages[backend].optional);
}
