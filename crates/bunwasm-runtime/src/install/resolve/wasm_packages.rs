use serde_json::Value;

pub(super) fn adapt(meta: &mut Value) {
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

fn binding(name: &str) -> Option<&'static str> {
    let backend = match name {
        "rolldown" => "@rolldown/binding-wasm32-wasi",
        "oxc-parser" => "@oxc-parser/binding-wasm32-wasi",
        "oxc-transform" => "@oxc-transform/binding-wasm32-wasi",
        _ => return None,
    };
    Some(backend)
}
