use super::{
    io::{self, Result},
    local, resolve,
};
use crate::Transpiler;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::Path,
};

pub fn read(manifest: &Value, parser: &dyn Transpiler) -> Result<Option<Value>> {
    let mut lock = json!({"lockfileVersion": 2, "configVersion": 1, "workspaces": {"": local::lock_meta(manifest)}, "packages": {}});
    let name = if Path::new("package-lock.json").exists() {
        npm(&io::read(Path::new("package-lock.json"), "JSON", parser)?, &mut lock)?;
        "package-lock.json"
    } else if Path::new("yarn.lock").exists() {
        yarn(manifest, parser, &mut lock)?;
        "yarn.lock"
    } else if Path::new("pnpm-lock.yaml").exists() {
        let source = io::read(Path::new("pnpm-lock.yaml"), "YAML", parser)?;
        let version = source["lockfileVersion"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| source["lockfileVersion"].to_string());
        if version.starts_with("5.") {
            eprintln!(
                "warn: pnpm-lock.yaml is lockfileVersion {version}, which bun cannot migrate; resolving from package.json instead\nnote: pnpm install --lockfile-only"
            );
            return Ok(None);
        }
        pnpm(manifest, &source, &mut lock)?;
        "pnpm-lock.yaml"
    } else {
        return Ok(None);
    };
    eprintln!("migrated lockfile from {name}");
    Ok(Some(lock))
}

fn npm(source: &Value, lock: &mut Value) -> Result<()> {
    if let Some(packages) = source["packages"].as_object() {
        for (path, meta) in packages {
            if path.is_empty() || meta["link"] == true {
                continue;
            }
            let Some(path) = path.strip_prefix("node_modules/") else {
                continue;
            };
            let key = path.replace("/node_modules/", "/");
            let name = path.rsplit("node_modules/").next().unwrap();
            add(lock, &key, name, meta)?;
        }
        return Ok(());
    }
    let mut pending = VecDeque::from([(String::new(), &source["dependencies"])]);
    while let Some((parent, deps)) = pending.pop_front() {
        let Some(deps) = deps.as_object() else {
            continue;
        };
        for (name, meta) in deps {
            let key = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            let mut meta = meta.clone();
            if meta["requires"].is_object() {
                meta["dependencies"] = meta["requires"].clone();
            }
            add(lock, &key, name, &meta)?;
            pending.push_back((key, &deps[name]["dependencies"]));
        }
    }
    Ok(())
}

fn add(lock: &mut Value, key: &str, name: &str, meta: &Value) -> Result<()> {
    resolve::valid_name(name)?;
    let version = meta["version"].as_str().ok_or("Migrated package has no version")?;
    let name = meta["name"].as_str().unwrap_or(name);
    resolve::valid_name(name)?;
    let info = resolve::lock_info(meta);
    let tarball = meta["resolved"].as_str().unwrap_or("").split('#').next().unwrap_or("");
    lock["packages"][key] = json!([
        format!("{name}@{version}"),
        tarball,
        info,
        meta["integrity"].as_str().unwrap_or("")
    ]);
    Ok(())
}

fn yarn(manifest: &Value, parser: &dyn Transpiler, lock: &mut Value) -> Result<()> {
    let text = fs::read_to_string("yarn.lock").map_err(|e| e.to_string())?;
    let source = if text.contains("__metadata:") {
        io::parsed(text.as_bytes(), "YAML", parser)?
    } else {
        classic(&text, parser)?
    };
    let mut records = BTreeMap::new();
    for (selectors, meta) in source.as_object().ok_or("Invalid yarn.lock")? {
        if selectors == "__metadata" {
            continue;
        }
        for selector in selectors.split(", ") {
            let mut meta = meta.clone();
            if let Some((name, _)) = meta["resolution"].as_str().and_then(|s| s.split_once("@npm:")) {
                meta["name"] = name.into();
            } else if let Some((_, target)) = selector.split_once("@npm:") {
                if let Ok((name, _)) = resolve::spec(target) {
                    meta["name"] = name.into();
                }
            }
            records.insert(selector.replace("@npm:", "@"), meta);
        }
    }
    graph(manifest, &records, lock)
}

fn classic(text: &str, parser: &dyn Transpiler) -> Result<Value> {
    let mut yaml = String::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            let key = line.trim_end_matches(':').replace('"', "");
            yaml.push_str(&format!("{}:\n", json!(key)));
            continue;
        }
        let trimmed = line.trim_start();
        let indentation = &line[..line.len() - trimmed.len()];
        let Some((key, value)) = trimmed.split_once(' ') else {
            yaml.push_str(line);
            yaml.push('\n');
            continue;
        };
        if key.ends_with(':') {
            yaml.push_str(line);
        } else {
            yaml.push_str(&format!("{indentation}{key}: {}", json!(value.trim_matches('"'))));
        }
        yaml.push('\n');
    }
    io::parsed(yaml.as_bytes(), "YAML", parser)
}

fn pnpm(manifest: &Value, source: &Value, lock: &mut Value) -> Result<()> {
    let mut records = BTreeMap::new();
    let packages = source["packages"]
        .as_object()
        .ok_or("pnpm-lock.yaml missing packages")?;
    for (key, meta) in packages {
        let key = key.trim_start_matches('/');
        let key = key.split('(').next().unwrap_or(key);
        let (name, version) = if let Some((name, version)) = key.rsplit_once('@').filter(|(n, _)| !n.is_empty()) {
            (name.to_owned(), version.to_owned())
        } else {
            let (name, version) = key.rsplit_once('/').ok_or("Invalid pnpm package key")?;
            (name.to_owned(), version.to_owned())
        };
        let mut row = meta.clone();
        row["version"] = version.clone().into();
        row["integrity"] = meta["resolution"]["integrity"].clone();
        row["resolved"] = meta["resolution"]["tarball"].clone();
        if let Some(snapshot) = source["snapshots"].get(format!("{name}@{version}")) {
            for field in ["dependencies", "optionalDependencies"] {
                if snapshot[field].is_object() {
                    row[field] = snapshot[field].clone();
                }
            }
        }
        records.insert(format!("{name}@{version}"), row);
    }
    let importer = source["importers"].get(".").unwrap_or(source);
    let mut root = manifest.clone();
    for field in ["dependencies", "devDependencies", "optionalDependencies"] {
        let Some(deps) = importer[field].as_object() else {
            continue;
        };
        for (name, value) in deps {
            let version = value["version"]
                .as_str()
                .or_else(|| value.as_str())
                .ok_or("Invalid pnpm dependency version")?;
            root[field][name] = version.split('(').next().unwrap_or(version).into();
        }
    }
    graph(&root, &records, lock)
}

fn graph(manifest: &Value, records: &BTreeMap<String, Value>, lock: &mut Value) -> Result<()> {
    let mut pending = VecDeque::new();
    for (name, (range, _, _)) in resolve::dependencies(manifest, false, true) {
        pending.push_back((name, range, Vec::<String>::new()));
    }
    let mut count = 0;
    while let Some((name, range, parent)) = pending.pop_front() {
        count += 1;
        if count > 10000 {
            return Err("Migrated dependency graph exceeds install limit".into());
        }
        let range = range.strip_prefix("npm:").unwrap_or(&range);
        let range = range.split('(').next().unwrap_or(range);
        if range.starts_with("workspace:") || range.starts_with("link:") {
            continue;
        }
        let Some(meta) = records.get(&format!("{name}@{range}")) else {
            return Err(format!("Missing migrated resolution for {name}@{range}"));
        };
        let mut chain = parent;
        chain.push(name.clone());
        let key = if lock["packages"][&name].is_null()
            || lock["packages"][&name][0] == format!("{}@{}", name, meta["version"].as_str().unwrap_or(""))
        {
            name.clone()
        } else {
            chain.join("/")
        };
        if !lock["packages"][&key].is_null() {
            continue;
        }
        add(lock, &key, &name, meta)?;
        for (child, (range, _, _)) in resolve::dependencies(meta, false, false) {
            pending.push_back((child, range, vec![key.clone()]));
        }
    }
    Ok(())
}
