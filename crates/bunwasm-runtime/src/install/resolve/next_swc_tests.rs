use super::*;

const BACKEND: &str = "@next/swc-wasm-nodejs";
const NATIVE: &str = "@next/swc-linux-x64-gnu";

pub(super) fn fixture(version: &str, locked: bool, optional: bool) -> (Resolver, Value) {
    let field = if optional {
        "optionalDependencies"
    } else {
        "dependencies"
    };
    let manifest = json!({field: {"next": version}});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({"packages": {}, "workspaces": {"": manifest}}),
        false,
    );
    let packages = [
        (
            "next",
            json!({"dependencies": {}, "optionalDependencies": {NATIVE: version}}),
        ),
        (NATIVE, json!({"os": ["linux"], "cpu": ["x64"]})),
        (BACKEND, json!({"main": "wasm.js"})),
    ];
    for (name, mut meta) in packages {
        meta["name"] = name.into();
        meta["version"] = version.into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{name}.tgz")});
        if locked && name != BACKEND {
            resolver.locked["packages"][name] = json!([
                format!("{name}@{version}"),
                meta["dist"]["tarball"],
                lock_info(&meta),
                ""
            ]);
        }
        resolver
            .packuments
            .insert(name.into(), json!({"versions": {version: meta}}));
    }
    (resolver, manifest)
}

#[test]
fn registry_and_old_lock_select_the_matching_wasm_backend() {
    assert_matching_backend("15.5.6");
}

pub(super) fn assert_matching_backend(version: &str) {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(version, locked, false);
        let original = resolver.locked.clone();
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(resolver.packages[BACKEND].version, version);
        assert!(!resolver.packages[BACKEND].optional);
        assert!(!resolver.packages.contains_key(NATIVE));
        assert!(resolver.skipped.contains_key(NATIVE));
        assert_eq!(resolver.locked, original);
        let next = lock_info(&resolver.packages["next"].meta);
        assert_eq!(next["dependencies"][BACKEND], version);
        assert_eq!(next["optionalDependencies"][NATIVE], version);
    }
}

#[test]
fn optional_next_keeps_the_backend_optional() {
    assert_optional_backend("15.5.6");
}

pub(super) fn assert_optional_backend(version: &str) {
    let (mut resolver, manifest) = fixture(version, false, true);
    resolver.resolve(&manifest, true).unwrap();
    assert!(resolver.packages["next"].optional);
    assert!(resolver.packages[BACKEND].optional);
}

#[test]
fn a_different_root_backend_does_not_satisfy_next() {
    assert_nested_backend("15.5.6", "15.5.7");
}

pub(super) fn assert_nested_backend(version: &str, different: &str) {
    let (mut resolver, mut manifest) = fixture(version, false, false);
    manifest["dependencies"][BACKEND] = different.into();
    resolver.packuments.get_mut(BACKEND).unwrap()["versions"][different] = json!({
        "name": BACKEND, "version": different,
        "dist": {"tarball": format!("http://registry.invalid/swc-{different}.tgz")}
    });
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(resolver.packages[BACKEND].version, different);
    let nested = format!("next/{BACKEND}");
    assert_eq!(resolver.packages[&nested].version, version);
}

#[test]
fn selected_backend_and_metadata_survive_a_lock_round_trip() {
    assert_lock_round_trip("15.5.6");
}

pub(super) fn assert_lock_round_trip(version: &str) {
    let (mut resolver, manifest) = fixture(version, false, false);
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
    assert_eq!(replay.packages[BACKEND].version, version);
    assert_eq!(
        lock_info(&replay.packages["next"].meta),
        lock_info(&resolver.packages["next"].meta)
    );
    assert!(replay.packuments.is_empty());
    assert_eq!(replay.locked, original);
}
