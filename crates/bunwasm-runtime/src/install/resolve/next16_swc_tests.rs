use super::super::*;

const BACKEND: &str = "@next/swc-wasm-nodejs";
const NATIVE: &str = "@next/swc-linux-x64-gnu";

fn fixture(locked: bool, optional: bool) -> (Resolver, Value) {
    let field = if optional {
        "optionalDependencies"
    } else {
        "dependencies"
    };
    let manifest = json!({field: {"next": "16.4.3"}});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({"packages": {}, "workspaces": {"": manifest}}),
        false,
    );
    let packages = [
        (
            "next",
            json!({"dependencies": {}, "optionalDependencies": {NATIVE: "16.4.3"}}),
        ),
        (NATIVE, json!({"os": ["linux"], "cpu": ["x64"]})),
        (BACKEND, json!({"main": "wasm.js"})),
    ];
    for (name, mut meta) in packages {
        meta["name"] = name.into();
        meta["version"] = "16.4.3".into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{name}.tgz")});
        if locked && name != BACKEND {
            resolver.locked["packages"][name] = json!([
                format!("{name}@16.4.3"),
                meta["dist"]["tarball"],
                lock_info(&meta),
                ""
            ]);
        }
        resolver
            .packuments
            .insert(name.into(), json!({"versions": {"16.4.3": meta}}));
    }
    (resolver, manifest)
}

#[test]
fn registry_and_old_lock_select_the_matching_wasm_backend() {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(locked, false);
        let original = resolver.locked.clone();
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(resolver.packages[BACKEND].version, "16.4.3");
        assert!(!resolver.packages[BACKEND].optional);
        assert!(!resolver.packages.contains_key(NATIVE));
        assert!(resolver.skipped.contains_key(NATIVE));
        assert_eq!(resolver.locked, original);
        let next = lock_info(&resolver.packages["next"].meta);
        assert_eq!(next["dependencies"][BACKEND], "16.4.3");
        assert_eq!(next["optionalDependencies"][NATIVE], "16.4.3");
    }
}

#[test]
fn optional_next_keeps_the_backend_optional() {
    let (mut resolver, manifest) = fixture(false, true);
    resolver.resolve(&manifest, true).unwrap();
    assert!(resolver.packages["next"].optional);
    assert!(resolver.packages[BACKEND].optional);
}

#[test]
fn a_different_root_backend_does_not_satisfy_next() {
    let (mut resolver, mut manifest) = fixture(false, false);
    manifest["dependencies"][BACKEND] = "16.4.4".into();
    resolver.packuments.get_mut(BACKEND).unwrap()["versions"]["16.4.4"] = json!({
        "name": BACKEND, "version": "16.4.4",
        "dist": {"tarball": "http://registry.invalid/swc-16.4.4.tgz"}
    });
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(resolver.packages[BACKEND].version, "16.4.4");
    let nested = format!("next/{BACKEND}");
    assert_eq!(resolver.packages[&nested].version, "16.4.3");
}

#[test]
fn selected_backend_and_metadata_survive_a_lock_round_trip() {
    let (mut resolver, manifest) = fixture(false, false);
    resolver.resolve(&manifest, false).unwrap();
    let mut locked = json!({"packages": {}, "workspaces": {"": manifest}});
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
    assert_eq!(replay.packages[BACKEND].version, "16.4.3");
    assert_eq!(
        lock_info(&replay.packages["next"].meta),
        lock_info(&resolver.packages["next"].meta)
    );
    assert!(replay.packuments.is_empty());
    assert_eq!(replay.locked, original);
}

#[test]
fn missing_matching_backend_is_an_install_error_not_an_optional_success() {
    let (mut resolver, manifest) = fixture(false, false);
    resolver.packuments.get_mut(BACKEND).unwrap()["versions"] = json!({});
    let error = resolver.resolve(&manifest, false).err().unwrap();
    assert!(error.contains("16.4.3"), "{error}");
    assert!(error.contains(BACKEND), "{error}");
}

#[test]
fn requires_matching_native_metadata_and_preserves_explicit_backends() {
    let (resolver, _) = fixture(false, false);
    let original = &resolver.packuments["next"]["versions"]["16.4.3"];
    let mut mismatched = original.clone();
    mismatched["optionalDependencies"][NATIVE] = "16.4.4".into();
    assert_unchanged(mismatched);
    let mut missing = original.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("optionalDependencies");
    assert_unchanged(missing);
    for field in ["dependencies", "optionalDependencies"] {
        let mut declared = original.clone();
        declared[field][BACKEND] = "16.4.4".into();
        assert_unchanged(declared);
    }
}

fn assert_unchanged(mut metadata: Value) {
    let original = metadata.clone();
    super::adapt(&mut metadata);
    assert_eq!(metadata, original);
}
