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
