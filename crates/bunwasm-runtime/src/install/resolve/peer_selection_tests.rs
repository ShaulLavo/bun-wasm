use super::*;

fn packument(name: &str, versions: &[(&str, Value)]) -> Value {
    let mut entries = serde_json::Map::new();
    for (version, metadata) in versions {
        let mut metadata = metadata.clone();
        metadata["name"] = name.into();
        metadata["version"] = (*version).into();
        metadata["dist"] =
            json!({"tarball": format!("http://registry.invalid/{name}-{version}.tgz")});
        entries.insert((*version).into(), metadata);
    }
    json!({"versions": entries})
}

#[test]
fn published_oxc_fallback_graph_selects_native_buns_release_peers() {
    let binding = "@oxc-parser/binding-wasm32-wasi";
    let runtime = "@napi-rs/wasm-runtime";
    let range = "^1.7.1 || ^2.0.0-alpha.4";
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({}),
        false,
    );
    resolver.packuments.insert(
        binding.into(),
        packument(
            binding,
            &[(
                "0.94.0",
                json!({"cpu": ["wasm32"], "dependencies": {runtime: "^1.0.6"}}),
            )],
        ),
    );
    resolver.packuments.insert(
        runtime.into(),
        packument(
            runtime,
            &[(
                "1.2.5",
                json!({"peerDependencies": {"@emnapi/core": range, "@emnapi/runtime": range}}),
            )],
        ),
    );
    resolver.packuments.insert(
        "@emnapi/core".into(),
        packument(
            "@emnapi/core",
            &[
                (
                    "1.11.3",
                    json!({"dependencies": {"@emnapi/wasi-threads": "1.2.3"}}),
                ),
                (
                    "2.0.0-beta.2",
                    json!({"dependencies": {"@emnapi/wasi-threads": "2.2.0"}}),
                ),
            ],
        ),
    );
    resolver.packuments.insert(
        "@emnapi/runtime".into(),
        packument(
            "@emnapi/runtime",
            &[("1.11.3", json!({})), ("2.0.0-beta.2", json!({}))],
        ),
    );
    resolver.packuments.insert(
        "@emnapi/wasi-threads".into(),
        packument(
            "@emnapi/wasi-threads",
            &[("1.2.3", json!({})), ("2.2.0", json!({}))],
        ),
    );
    resolver
        .resolve(&json!({"dependencies": {binding: "0.94.0"}}), false)
        .unwrap();
    assert_eq!(resolver.packages[runtime].version, "1.2.5");
    assert_eq!(resolver.packages["@emnapi/core"].version, "1.11.3");
    assert_eq!(resolver.packages["@emnapi/runtime"].version, "1.11.3");
    assert_eq!(resolver.packages["@emnapi/wasi-threads"].version, "1.2.3");
}

fn placement_resolver(early: Value, later: Value) -> Resolver {
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        json!({}),
        false,
    );
    for (name, metadata) in [("early-consumer", early), ("later-consumer", later)] {
        resolver
            .packuments
            .insert(name.into(), packument(name, &[("1.0.0", metadata)]));
    }
    resolver.packuments.insert(
        "shared-lib".into(),
        packument("shared-lib", &[("1.0.0", json!({})), ("2.0.0", json!({}))]),
    );
    resolver
}

fn placement_root() -> Value {
    json!({"dependencies": {"early-consumer": "1.0.0", "later-consumer": "1.0.0"}})
}

#[test]
fn required_dependency_is_shared_with_an_earlier_broad_peer() {
    let mut resolver = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}}),
        json!({"dependencies": {"shared-lib": "^1.0.0"}}),
    );
    resolver.resolve(&placement_root(), false).unwrap();
    assert_eq!(resolver.packages["shared-lib"].version, "1.0.0");
    assert!(!resolver.packages.contains_key("later-consumer/shared-lib"));
}

#[test]
fn peer_only_graph_still_installs_the_highest_satisfying_version() {
    let mut resolver = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}}),
        json!({}),
    );
    resolver.resolve(&placement_root(), false).unwrap();
    assert_eq!(resolver.packages["shared-lib"].version, "2.0.0");
}

#[test]
fn optional_peer_is_not_auto_installed() {
    let mut resolver = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}, "peerDependenciesMeta": {"shared-lib": {"optional": true}}}),
        json!({}),
    );
    resolver.resolve(&placement_root(), false).unwrap();
    assert!(!resolver.packages.contains_key("shared-lib"));
}

#[test]
fn conflicting_required_versions_keep_their_nested_dependency() {
    let mut resolver = placement_resolver(
        json!({"dependencies": {"shared-lib": "^2.0.0"}}),
        json!({"dependencies": {"shared-lib": "^1.0.0"}}),
    );
    resolver.resolve(&placement_root(), false).unwrap();
    assert_eq!(resolver.packages["shared-lib"].version, "2.0.0");
    assert_eq!(
        resolver.packages["later-consumer/shared-lib"].version,
        "1.0.0"
    );
}

#[test]
fn explicit_root_dependency_keeps_priority_over_required_and_peer_edges() {
    let mut resolver = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}}),
        json!({"dependencies": {"shared-lib": "^1.0.0"}}),
    );
    let mut root = placement_root();
    root["dependencies"]["shared-lib"] = "2.0.0".into();
    resolver.resolve(&root, false).unwrap();
    assert_eq!(resolver.packages["shared-lib"].version, "2.0.0");
    assert_eq!(
        resolver.packages["later-consumer/shared-lib"].version,
        "1.0.0"
    );
}

#[test]
fn deferred_peers_preserve_cycles_and_required_children_of_auto_peers() {
    let mut resolver = placement_resolver(
        json!({"dependencies": {"later-consumer": "1.0.0"}, "peerDependencies": {"shared-lib": "^1.0.0"}}),
        json!({"dependencies": {"early-consumer": "1.0.0"}}),
    );
    resolver.packuments.insert(
        "shared-lib".into(),
        packument(
            "shared-lib",
            &[(
                "1.0.0",
                json!({"dependencies": {"early-consumer": "1.0.0", "peer-child": "1.0.0"}}),
            )],
        ),
    );
    resolver.packuments.insert(
        "peer-child".into(),
        packument("peer-child", &[("1.0.0", json!({}))]),
    );
    resolver.resolve(&placement_root(), false).unwrap();
    assert_eq!(resolver.packages.len(), 4);
    assert_eq!(resolver.packages["shared-lib"].version, "1.0.0");
    assert_eq!(resolver.packages["peer-child"].version, "1.0.0");
}

#[test]
fn deferred_peer_placement_does_not_depend_on_root_manifest_key_order() {
    let mut first = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}}),
        json!({"dependencies": {"shared-lib": "^1.0.0"}}),
    );
    let mut second = placement_resolver(
        json!({"peerDependencies": {"shared-lib": ">=1.0.0"}}),
        json!({"dependencies": {"shared-lib": "^1.0.0"}}),
    );
    first.resolve(&placement_root(), false).unwrap();
    second
        .resolve(
            &json!({"dependencies": {"later-consumer": "1.0.0", "early-consumer": "1.0.0"}}),
            false,
        )
        .unwrap();
    let first: Vec<_> = first
        .packages
        .into_iter()
        .map(|(key, package)| (key, package.version))
        .collect();
    let second: Vec<_> = second
        .packages
        .into_iter()
        .map(|(key, package)| (key, package.version))
        .collect();
    assert_eq!(first, second);
}
