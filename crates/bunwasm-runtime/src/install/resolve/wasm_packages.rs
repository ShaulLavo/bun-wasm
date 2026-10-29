use serde_json::Value;

use super::Overrides;

pub(super) fn adapt(meta: &mut Value, overrides: &Overrides) {
    rolldown_runtime(meta, overrides);
    let name = meta["name"].as_str().unwrap_or_default();
    let Some(backend) = binding(name) else {
        return;
    };
    let Some(version) = meta["version"].as_str() else {
        return;
    };
    let Some(optional) = meta["optionalDependencies"].as_object() else {
        return;
    };
    let prefix = format!("@{name}/binding-");
    let wasm_prefix = format!("{prefix}wasm32-");
    let mut native = optional
        .iter()
        .filter(|(name, _)| name.starts_with(&prefix) && !name.starts_with(&wasm_prefix))
        .peekable();
    if native.peek().is_none() || !native.all(|(_, value)| value.as_str() == Some(version)) {
        return;
    }
    let version = Value::String(version.into());
    meta["dependencies"][backend] = version;
    meta["optionalDependencies"]
        .as_object_mut()
        .unwrap()
        .remove(backend);
}

fn rolldown_runtime(meta: &mut Value, overrides: &Overrides) {
    if meta["name"] != "@rolldown/binding-wasm32-wasi"
        || meta["version"] != "1.2.15"
        || !matches!(
            meta["dependencies"]["@napi-rs/wasm-runtime"].as_str(),
            Some("~1.2.5" | "1.2.5")
        )
        || meta["dependencies"]["@emnapi/core"] != "2.0.0-alpha.5"
        || meta["dependencies"]["@emnapi/runtime"] != "2.0.0-alpha.5"
    {
        return;
    }
    let range = if overrides
        .replacement("@napi-rs/wasm-runtime", "~1.2.5")
        .is_some()
    {
        "~1.2.5"
    } else {
        "1.2.5"
    };
    meta["dependencies"]["@napi-rs/wasm-runtime"] = range.into();
}

fn binding(name: &str) -> Option<&'static str> {
    let backend = match name {
        "rolldown" => "@rolldown/binding-wasm32-wasi",
        "oxc-parser" => "@oxc-parser/binding-wasm32-wasi",
        "oxc-transform" => "@oxc-transform/binding-wasm32-wasi",
        _ => return None,
    };
    Some(backend)
}
