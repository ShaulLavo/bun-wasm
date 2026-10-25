use serde_json::Value;

const BACKEND: &str = "@next/swc-wasm-nodejs";

pub(super) fn adapt(meta: &mut Value) {
    if meta["name"] != "next" {
        return;
    }
    let Some(version) = meta["version"].as_str().filter(|v| v.starts_with("15.")) else {
        return;
    };
    if meta["dependencies"].get(BACKEND).is_some()
        || meta["optionalDependencies"].get(BACKEND).is_some()
    {
        return;
    }
    let Some(optional) = meta["optionalDependencies"].as_object() else {
        return;
    };
    let mut native = optional
        .iter()
        .filter(|(name, _)| name.starts_with("@next/swc-") && !name.starts_with("@next/swc-wasm-"))
        .peekable();
    if native.peek().is_none() || !native.all(|(_, value)| value.as_str() == Some(version)) {
        return;
    }
    let version = Value::String(version.into());
    if let Some(dependencies) = meta["dependencies"].as_object_mut() {
        dependencies.insert(BACKEND.into(), version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn next(version: &str) -> Value {
        json!({
            "name": "next", "version": version,
            "dependencies": {"@next/env": version, "@swc/helpers": "0.5.15"},
            "optionalDependencies": {"@next/swc-linux-x64-gnu": version, "@next/swc-darwin-arm64": version},
            "peerDependencies": {"react": "^19.0.0"},
            "dist": {"tarball": format!("https://registry.npmjs.org/next/-/next-{version}.tgz")}
        })
    }

    #[test]
    fn adds_exact_official_backend_for_next15() {
        let mut meta = next("15.5.6");
        let original = meta.clone();
        adapt(&mut meta);
        assert_eq!(meta["dependencies"][BACKEND], "15.5.6");
        meta["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove(BACKEND);
        assert_eq!(meta, original);
    }

    #[test]
    fn follows_the_resolved_next_patch_version() {
        let mut meta = next("15.5.7");
        adapt(&mut meta);
        assert_eq!(meta["dependencies"][BACKEND], "15.5.7");
    }

    #[test]
    fn leaves_other_packages_and_unqualified_next_majors_unchanged() {
        let mut other = next("15.5.6");
        other["name"] = "not-next".into();
        for mut meta in [other, next("14.2.33"), next("16.4.3")] {
            let original = meta.clone();
            adapt(&mut meta);
            assert_eq!(meta, original);
        }
    }

    #[test]
    fn requires_matching_native_backend_metadata() {
        let mut missing = next("15.5.6");
        missing
            .as_object_mut()
            .unwrap()
            .remove("optionalDependencies");
        let mut mismatched = next("15.5.6");
        mismatched["optionalDependencies"]["@next/swc-linux-x64-gnu"] = "14.2.33".into();
        for mut meta in [missing, mismatched, json!({"name":"next"})] {
            let original = meta.clone();
            adapt(&mut meta);
            assert_eq!(meta, original);
        }
    }

    #[test]
    fn preserves_already_declared_wasm_backends_and_optionality() {
        for field in ["dependencies", "optionalDependencies"] {
            let mut meta = next("15.5.6");
            meta[field][BACKEND] = "15.5.6".into();
            let original = meta.clone();
            adapt(&mut meta);
            assert_eq!(meta, original);
        }
    }

    #[test]
    fn adaptation_is_idempotent() {
        let mut meta = next("15.5.6");
        adapt(&mut meta);
        let once = meta.clone();
        adapt(&mut meta);
        assert_eq!(meta, once);
    }
}
