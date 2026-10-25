use super::*;

const BACKEND: &str = "@next/swc-wasm-nodejs";
const NATIVE: &str = "@next/swc-linux-x64-gnu";

fn fixture(locked: bool, optional: bool) -> (Resolver, Value) {
    let field = if optional {
        "optionalDependencies"
    } else {
        "dependencies"
    };
    let manifest = json!({field: {"next": "15.5.6"}});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({"packages": {}, "workspaces": {"": manifest}}),
        false,
    );
    let packages = [
        (
            "next",
            json!({"dependencies": {}, "optionalDependencies": {NATIVE: "15.5.6"}}),
        ),
        (NATIVE, json!({"os": ["linux"], "cpu": ["x64"]})),
        (BACKEND, json!({"main": "wasm.js"})),
    ];
    for (name, mut meta) in packages {
        meta["name"] = name.into();
        meta["version"] = "15.5.6".into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{name}.tgz")});
        if locked && name != BACKEND {
            resolver.locked["packages"][name] = json!([
                format!("{name}@15.5.6"),
                meta["dist"]["tarball"],
                lock_info(&meta),
                ""
            ]);
        }
        resolver
            .packuments
            .insert(name.into(), json!({"versions": {"15.5.6": meta}}));
    }
    (resolver, manifest)
}

#[test]
fn registry_and_old_lock_select_the_matching_wasm_backend() {
    for locked in [false, true] {
        let (mut resolver, manifest) = fixture(locked, false);
        let original = resolver.locked.clone();
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(resolver.packages[BACKEND].version, "15.5.6");
        assert!(!resolver.packages[BACKEND].optional);
        assert!(!resolver.packages.contains_key(NATIVE));
        assert!(resolver.skipped.contains_key(NATIVE));
        assert_eq!(resolver.locked, original);
        let next = lock_info(&resolver.packages["next"].meta);
        assert_eq!(next["dependencies"][BACKEND], "15.5.6");
        assert_eq!(next["optionalDependencies"][NATIVE], "15.5.6");
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
    manifest["dependencies"][BACKEND] = "15.5.7".into();
    resolver.packuments[BACKEND]["versions"]["15.5.7"] = json!({
        "name": BACKEND, "version": "15.5.7",
        "dist": {"tarball": "http://registry.invalid/swc-15.5.7.tgz"}
    });
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(resolver.packages[BACKEND].version, "15.5.7");
    let nested = format!("next/{BACKEND}");
    assert_eq!(resolver.packages[&nested].version, "15.5.6");
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
    assert_eq!(replay.packages[BACKEND].version, "15.5.6");
    assert_eq!(
        lock_info(&replay.packages["next"].meta),
        lock_info(&resolver.packages["next"].meta)
    );
    assert!(replay.packuments.is_empty());
    assert_eq!(replay.locked, original);
}
