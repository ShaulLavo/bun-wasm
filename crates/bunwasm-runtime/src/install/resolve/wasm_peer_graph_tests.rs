use super::*;

const BINDING: &str = "@rolldown/binding-wasm32-wasi";
const RUNTIME: &str = "@napi-rs/wasm-runtime";
const CORE: &str = "@emnapi/core";
const EMNAPI: &str = "@emnapi/runtime";

fn binding_meta() -> Value {
    json!({"name": BINDING, "version": "1.2.15", "dependencies": {
        RUNTIME: "~1.2.5", CORE: "2.0.0-alpha.5", EMNAPI: "2.0.0-alpha.5"
    }})
}

fn fixture() -> (Resolver, Value) {
    let manifest = json!({"dependencies": {
        BINDING: "1.2.15", RUNTIME: "1.2.6", CORE: "1.11.3", EMNAPI: "1.11.3"
    }});
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({}),
        false,
    );
    let peer = |range: &str| json!({"peerDependencies": {CORE: range, EMNAPI: range}});
    let packages = [
        (BINDING, "1.2.15", binding_meta()),
        (RUNTIME, "1.2.5", peer("^1.7.1 || ^2.0.0-alpha.4")),
        (RUNTIME, "1.2.6", peer("^1.7.1 || 2.0.0-beta.2")),
        (CORE, "1.11.3", json!({})),
        (CORE, "2.0.0-alpha.5", json!({})),
        (EMNAPI, "1.11.3", json!({})),
        (EMNAPI, "2.0.0-alpha.5", json!({})),
    ];
    for (name, version, mut meta) in packages {
        meta["name"] = name.into();
        meta["version"] = version.into();
        meta["dist"] = json!({"tarball": format!("http://registry.invalid/{name}-{version}.tgz")});
        resolver
            .packuments
            .entry(name.into())
            .or_insert(json!({"versions": {}}))["versions"][version] = meta;
    }
    (resolver, manifest)
}

fn assert_graph(resolver: &Resolver) {
    assert_eq!(resolver.packages[RUNTIME].version, "1.2.6");
    assert_eq!(resolver.packages[CORE].version, "1.11.3");
    assert_eq!(resolver.packages[EMNAPI].version, "1.11.3");
    let nested = format!("{BINDING}/{RUNTIME}");
    assert_eq!(resolver.packages[&nested].version, "1.2.5");
    let runtime = &resolver.packages[&nested];
    for peer in [CORE, EMNAPI] {
        let key = resolver.dependency_key(runtime, peer).unwrap();
        assert_eq!(key, format!("{BINDING}/{peer}"));
        assert_eq!(resolver.packages[&key].version, "2.0.0-alpha.5");
        assert!(matches(
            &resolver.packages[&key].version,
            runtime.meta["peerDependencies"][peer].as_str().unwrap()
        ));
    }
}

fn lock(resolver: &Resolver, manifest: &Value) -> Value {
    let mut locked = json!({"workspaces": {"": manifest}, "packages": {}});
    for (key, package) in &resolver.packages {
        locked["packages"][key] = json!([
            format!("{}@{}", package.name, package.version),
            package.tarball,
            lock_info(&package.meta),
            package.integrity
        ]);
    }
    locked
}

#[test]
fn exact_rolldown_binding_keeps_its_compatible_runtime_context() {
    let (mut resolver, manifest) = fixture();
    resolver.resolve(&manifest, false).unwrap();
    assert_graph(&resolver);
    assert_eq!(
        resolver.packages[BINDING].meta["dependencies"][RUNTIME],
        "1.2.5"
    );
    assert_eq!(resolver.packages[BINDING].version, "1.2.15");
}

#[test]
fn compatible_runtime_context_replays_without_registry_or_lock_mutation() {
    let (mut resolver, manifest) = fixture();
    resolver.resolve(&manifest, false).unwrap();
    let locked = lock(&resolver, &manifest);
    let mut replay = Resolver::new(resolver.registry, locked.clone(), false);
    replay.resolve(&manifest, false).unwrap();
    assert_graph(&replay);
    assert_eq!(replay.locked, locked);
    assert_eq!(lock(&replay, &manifest), locked);
    assert!(replay.packuments.is_empty());
}

#[test]
fn broken_existing_lock_resolves_the_exact_compatible_runtime() {
    let (mut resolver, manifest) = fixture();
    resolver.resolve(&manifest, false).unwrap();
    resolver.locked = lock(&resolver, &manifest);
    resolver.locked["packages"][BINDING][2]["dependencies"][RUNTIME] = "~1.2.5".into();
    resolver.locked["packages"]
        .as_object_mut()
        .unwrap()
        .remove(&format!("{BINDING}/{RUNTIME}"));
    let original = resolver.locked.clone();
    let (mut repaired, _) = fixture();
    repaired.locked = original.clone();
    repaired.resolve(&manifest, false).unwrap();
    assert_graph(&repaired);
    assert_eq!(repaired.locked, original);
}

#[test]
fn metadata_correction_is_exact_and_idempotent() {
    let mut meta = binding_meta();
    let mut expected = meta.clone();
    expected["dependencies"][RUNTIME] = "1.2.5".into();
    wasm_packages::adapt(&mut meta);
    assert_eq!(meta, expected);
    wasm_packages::adapt(&mut meta);
    assert_eq!(meta, expected);
    for (field, value) in [
        ("name", "@other/binding-wasm32-wasi"),
        ("version", "1.2.14"),
        ("version", "1.2.16"),
    ] {
        let mut untouched = binding_meta();
        untouched[field] = value.into();
        let original = untouched.clone();
        wasm_packages::adapt(&mut untouched);
        assert_eq!(untouched, original);
    }
}

#[test]
fn different_dependency_metadata_and_explicit_overrides_stay_authoritative() {
    for (name, value) in [
        (RUNTIME, "~1.2.6"),
        (CORE, "2.0.0-beta.2"),
        (EMNAPI, "2.0.0-beta.2"),
    ] {
        let mut meta = binding_meta();
        meta["dependencies"][name] = value.into();
        let original = meta.clone();
        wasm_packages::adapt(&mut meta);
        assert_eq!(meta, original);
    }
    let (mut resolver, mut manifest) = fixture();
    manifest["overrides"] = json!({RUNTIME: "1.2.6", "unrelated": "2.0.0"});
    resolver.resolve(&manifest, false).unwrap();
    assert_eq!(resolver.packages[RUNTIME].version, "1.2.6");
    assert!(
        !resolver
            .packages
            .contains_key(&format!("{BINDING}/{RUNTIME}"))
    );
    assert_eq!(resolver.overrides.metadata, manifest["overrides"]);
}
