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
        (name, json!({"dependencies": {}, "optionalDependencies": {native.clone(): version}})),
        (backend, json!({"main": "official-loader.cjs"})),
        (&native, json!({"os": ["linux"], "cpu": ["x64"]})),
    ];
    for (package, mut meta) in metadata {
        meta["name"] = package.into();
        meta["version"] = version.into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{package}-{version}.tgz")});
        resolver.packuments.insert(package.into(), json!({"versions": {version: meta}}));
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
        ("oxc-transform", "@oxc-transform/binding-wasm32-wasi", "0.156.0"),
    ] {
        let (mut resolver, manifest) = fixture(name, backend, version);
        resolver.resolve(&manifest, false).unwrap();
        let package = resolver.packages.get(backend).expect("official Wasm binding must be installed");
        assert_eq!(package.version, version);
        assert!(!package.optional);
        assert_eq!(resolver.packages[name].name, name);
        assert_eq!(resolver.packages[name].meta["dependencies"][backend], version);
    }
}

#[test]
fn vite_wasm_packages_lock_replays_without_registry_or_wrong_archive_identity() {
    for (name, backend, version) in [
        ("lightningcss", "lightningcss-wasm", "1.33.0"),
        ("rolldown", "@rolldown/binding-wasm32-wasi", "1.2.15"),
        ("oxc-transform", "@oxc-transform/binding-wasm32-wasi", "0.156.0"),
    ] {
        let (mut resolver, manifest) = fixture(name, backend, version);
        resolver.resolve(&manifest, false).unwrap();
        let mut locked = json!({"workspaces": {"": manifest}, "packages": {}});
        for (key, package) in resolver.packages.iter().chain(&resolver.skipped) {
            locked["packages"][key] = json!([
                format!("{}@{}", package.name, package.version), package.tarball,
                lock_info(&package.meta), package.integrity
            ]);
        }
        let original = locked.clone();
        let mut replay = Resolver::new(resolver.registry.clone(), locked, false);
        replay.resolve(&manifest, false).unwrap();
        assert_eq!(replay.packages[name].name, resolver.packages[name].name);
        assert_eq!(replay.packages[name].tarball, resolver.packages[name].tarball);
        assert_eq!(replay.packages.len(), resolver.packages.len());
        assert!(replay.packuments.is_empty());
        assert_eq!(replay.locked, original);
    }
}
