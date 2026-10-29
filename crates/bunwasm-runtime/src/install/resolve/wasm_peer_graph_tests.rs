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
    let mut locked = test_support::lock_snapshot(manifest, resolver);
    if resolver
        .overrides
        .metadata
        .as_object()
        .is_some_and(|rules| !rules.is_empty())
    {
        locked["overrides"] = resolver.overrides.metadata.clone();
    }
    locked
}

fn version_selector(resolver: Resolver, mut manifest: Value) -> (Resolver, Value) {
    manifest["overrides"] = json!({format!("{RUNTIME}@1.2.6"): "1.2.6"});
    (resolver, manifest)
}

fn assert_selected_override(resolver: &Resolver) {
    let binding = &resolver.packages[BINDING];
    let key = resolver.dependency_key(binding, RUNTIME).unwrap();
    assert_eq!(resolver.packages[&key].version, "1.2.6");
    assert_eq!(binding.meta["dependencies"][RUNTIME], "~1.2.5");
}

#[test]
fn version_selector_matches_the_original_published_edge() {
    let (resolver, manifest) = fixture();
    let (mut resolver, manifest) = version_selector(resolver, manifest);
    let rules = Overrides::new(&manifest, &json!({})).unwrap();
    assert_eq!(rules.target(RUNTIME, "~1.2.5"), "1.2.6");
    resolver.resolve(&manifest, false).unwrap();
    assert_selected_override(&resolver);
}

#[test]
fn version_selector_replays_its_selected_runtime_without_registry() {
    let (resolver, manifest) = fixture();
    let (mut resolver, manifest) = version_selector(resolver, manifest);
    resolver.resolve(&manifest, false).unwrap();
    let locked = lock(&resolver, &manifest);
    let mut replay = Resolver::new(resolver.registry, locked.clone(), false);
    replay.resolve(&manifest, false).unwrap();
    assert_selected_override(&replay);
    assert!(replay.overrides.changed.is_empty());
    assert_eq!(lock(&replay, &manifest), locked);
    assert!(replay.packuments.is_empty());
}

#[test]
fn added_version_selector_matches_a_previously_corrected_lock() {
    let (mut resolver, manifest) = fixture();
    resolver.resolve(&manifest, false).unwrap();
    let locked = lock(&resolver, &manifest);
    assert_eq!(
        locked["packages"][BINDING][2]["dependencies"][RUNTIME],
        "1.2.5"
    );
    let (resolver, manifest) = fixture();
    let (mut resolver, manifest) = version_selector(resolver, manifest);
    resolver.locked = locked;
    resolver.resolve(&manifest, false).unwrap();
    assert_selected_override(&resolver);
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
