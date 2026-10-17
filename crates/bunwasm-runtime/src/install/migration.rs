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

pub fn read(manifest: &Value, parser: &dyn Transpiler, registry: &str) -> Result<Option<Value>> {
    if !["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]
        .iter()
        .any(|name| Path::new(name).exists())
    {
        return Ok(None);
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let members = local::workspaces(&cwd, manifest, parser)?;
    let mut workspaces = json!({"": workspace_meta(manifest, true)});
    let mut packages = BTreeMap::new();
    let mut roots = vec![(Vec::new(), manifest.clone())];
    for (name, member) in &members {
        let path = member
            .path
            .strip_prefix(&cwd)
            .map_err(|e| e.to_string())?
            .to_string_lossy();
        workspaces[path.as_ref()] = workspace_meta(&member.meta, false);
        packages.insert(name.clone(), json!([format!("{name}@workspace:{path}")]));
        roots.push((vec![name.clone()], member.meta.clone()));
    }
    for (_, meta) in &roots {
        validate_ranges(meta, true)?;
    }
    let source = if Path::new("package-lock.json").exists() {
        npm(
            &io::read(Path::new("package-lock.json"), "JSON", parser)?,
            &mut packages,
        )?;
        "package-lock.json"
    } else if Path::new("yarn.lock").exists() {
        yarn(&roots, parser, &mut packages)?;
        "yarn.lock"
    } else if Path::new("pnpm-lock.yaml").exists() {
        pnpm(
            &roots,
            &members,
            &io::read(Path::new("pnpm-lock.yaml"), "YAML", parser)?,
            registry,
            &mut packages,
        )?;
        "pnpm-lock.yaml"
    } else {
        return Ok(None);
    };
    if source != "package-lock.json" {
        hydrate_metadata(&mut packages, registry);
    }
    eprintln!("migrated lockfile from {source}");
    Ok(Some(
        json!({"lockfileVersion": 2, "configVersion": 1, "workspaces": workspaces, "packages": packages}),
    ))
}

pub fn workspace_meta(manifest: &Value, root: bool) -> Value {
    let mut meta = local::lock_meta(manifest);
    if root {
        meta.as_object_mut().unwrap().shift_remove("version");
    }
    let info = resolve::lock_info(manifest);
    if !info["optionalPeers"].is_null() {
        meta["optionalPeers"] = info["optionalPeers"].clone();
    }
    normalize_peers(&mut meta);
    for field in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if let Some(deps) = meta[field].as_object() {
            meta[field] = serde_json::to_value(deps.iter().collect::<BTreeMap<_, _>>()).unwrap();
        }
    }
    meta
}

fn record(name: &str, meta: &Value) -> Result<Value> {
    validate_ranges(meta, false)?;
    let name = meta["name"].as_str().unwrap_or(name);
    resolve::valid_name(name)?;
    let version = meta["version"]
        .as_str()
        .ok_or("Migrated package has no version")?;
    if version.contains(':') || version.contains('/') {
        return Err(format!("Unsupported migrated resolution: {name}@{version}"));
    }
    let resolved = meta["resolved"].as_str().unwrap_or("");
    let (tarball, fragment) = resolved.split_once('#').unwrap_or((resolved, ""));
    let tarball = if tarball.starts_with("git+") || tarball.starts_with("github:") {
        resolved
    } else {
        tarball
    };
    let standard = tarball.is_empty()
        || [
            "https://registry.npmjs.org/",
            "https://registry.yarnpkg.com/",
        ]
        .iter()
        .any(|origin| {
            tarball.strip_prefix(origin).is_some_and(|path| {
                path == format!(
                    "{name}/-/{}-{version}.tgz",
                    name.rsplit('/').next().unwrap()
                )
            })
        });
    if !standard && !tarball.starts_with("https://") && !tarball.starts_with("http://") {
        return Err(format!("Unsupported migrated resolution: {resolved}"));
    }
    let integrity = match meta["integrity"].as_str() {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ if fragment.len() == 40 && fragment.bytes().all(|c| c.is_ascii_hexdigit()) => {
            let bytes = (0..40)
                .step_by(2)
                .map(|i| u8::from_str_radix(&fragment[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>();
            format!("sha1-{}", crate::encoding::base64_encode(&bytes, false))
        }
        _ => String::new(),
    };
    let info = package_meta(meta);
    Ok(json!([
        format!("{name}@{version}"),
        if standard { "" } else { tarball },
        info,
        integrity
    ]))
}

fn npm_row(path: &str, meta: &Value, packages: &mut BTreeMap<String, Value>) -> Result<()> {
    if meta["link"] == true {
        return Ok(());
    }
    let Some(path) = path.strip_prefix("node_modules/") else {
        return Ok(());
    };
    let name = path.rsplit("node_modules/").next().unwrap();
    packages.insert(
        path.replace("/node_modules/", "/"),
        record(name, &npm_bin(name, meta))?,
    );
    Ok(())
}

fn npm_tree_meta(meta: &Value) -> Value {
    let mut value = meta.clone();
    if meta["requires"].is_object() {
        value["dependencies"] = meta["requires"].clone();
    }
    value
}

fn npm_bin(name: &str, meta: &Value) -> Value {
    let mut meta = meta.clone();
    let name = meta["name"].as_str().unwrap_or(name);
    let bin = meta["bin"]
        .as_object()
        .filter(|bins| bins.len() == 1)
        .and_then(|bins| bins.get(name.rsplit('/').next().unwrap()))
        .cloned();
    if let Some(bin) = bin {
        meta["bin"] = bin;
    }
    meta
}

fn npm(source: &Value, packages: &mut BTreeMap<String, Value>) -> Result<()> {
    if let Some(rows) = source["packages"].as_object() {
        for (path, meta) in rows {
            npm_row(path, meta, packages)?;
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
            packages.insert(
                key.clone(),
                record(name, &npm_bin(name, &npm_tree_meta(meta)))?,
            );
            pending.push_back((key, &meta["dependencies"]));
        }
    }
    Ok(())
}

fn npm_range(range: &str) -> String {
    let Some(target) = range.strip_prefix("npm:") else {
        return range.into();
    };
    if target.rfind('@').is_some_and(|at| at > 0) || target.starts_with('@') {
        return range.into();
    }
    target.into()
}

fn yarn_record(selector: &str, value: &Value) -> Result<Option<(String, Value)>> {
    let (name, range) = resolve::spec(selector)?;
    if range.starts_with("workspace:") {
        return Ok(None);
    }
    let logical = selector
        .split_once("@npm:")
        .map_or_else(|| name.clone(), |(name, _)| name.to_owned());
    let mut meta = value.clone();
    let resolution = meta["resolution"].as_str().map(str::to_owned);
    if let Some(resolution) = resolution {
        let (target, version) = resolution
            .split_once("@npm:")
            .ok_or_else(|| format!("Unsupported migrated resolution: {resolution}"))?;
        meta["name"] = target.into();
        meta["version"] = version.into();
    } else if let Some(alias) = range.strip_prefix("npm:") {
        meta["name"] = resolve::spec(alias)?.0.into();
    }
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        normalize_yarn_dependencies(&mut meta[field]);
    }
    Ok(Some((format!("{logical}@{}", npm_range(&range)), meta)))
}

fn yarn(
    roots: &[(Vec<String>, Value)],
    parser: &dyn Transpiler,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let text = fs::read_to_string("yarn.lock").map_err(|e| e.to_string())?;
    let source = if text.contains("__metadata:") {
        io::parsed(text.as_bytes(), "YAML", parser)?
    } else {
        classic(&text, parser)?
    };
    let mut records = BTreeMap::new();
    for (selectors, value) in source.as_object().ok_or("Invalid yarn.lock")? {
        if selectors == "__metadata" {
            continue;
        }
        for selector in selectors.split(", ") {
            records.extend(yarn_record(selector, value)?);
        }
    }
    graph(roots, &records, packages)
}

fn normalize_yarn_dependencies(value: &mut Value) {
    let Some(deps) = value.as_object_mut() else {
        return;
    };
    for range in deps.values_mut() {
        if let Some(value) = range.as_str() {
            *range = npm_range(value).into();
        }
    }
}

fn classic_line(line: &str) -> String {
    if !line.starts_with(' ') {
        return format!("{}:\n", json!(line.trim_end_matches(':').replace('"', "")));
    }
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    match trimmed.split_once(' ') {
        Some((key, value)) if !key.ends_with(':') => {
            format!("{indent}{key}: {}\n", json!(value.trim_matches('"')))
        }
        _ => format!("{line}\n"),
    }
}

fn classic(text: &str, parser: &dyn Transpiler) -> Result<Value> {
    let mut yaml = String::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        yaml.push_str(&classic_line(line));
    }
    io::parsed(yaml.as_bytes(), "YAML", parser)
}

fn pnpm_reference(name: &str, value: &str) -> String {
    let bare = value.split('(').next().unwrap();
    if bare.rfind('@').is_some_and(|at| at > 0) && !bare.starts_with(&format!("{name}@")) {
        return format!("npm:{value}");
    }
    value
        .strip_prefix(&format!("{name}@"))
        .unwrap_or(value)
        .into()
}

fn pnpm_row(key: &str, value: &Value, snapshot: Option<&Value>, registry: &str) -> Result<Value> {
    let bare = key.trim_start_matches('/').split('(').next().unwrap();
    let (name, version) = bare
        .rsplit_once('@')
        .filter(|(name, _)| !name.is_empty())
        .or_else(|| bare.rsplit_once('/'))
        .ok_or("Invalid pnpm package key")?;
    let mut meta = value.clone();
    meta["name"] = name.into();
    meta["version"] = version.into();
    meta["integrity"] = value["resolution"]["integrity"].clone();
    let conventional = format!(
        "{registry}/{name}/-/{}-{version}.tgz",
        name.rsplit('/').next().unwrap()
    );
    let source = value["resolution"]["tarball"]
        .as_str()
        .unwrap_or(&conventional);
    if !value["resolution"]["repo"].is_null()
        || version.contains(':')
        || (!source.starts_with("https://") && !source.starts_with("http://"))
    {
        return Err(format!("Unsupported migrated resolution: {key}"));
    }
    meta["resolved"] = source.into();
    meta["_references"] = json!({});
    for field in ["dependencies", "optionalDependencies"] {
        let deps = snapshot
            .filter(|row| row[field].is_object())
            .map_or(&value[field], |row| &row[field]);
        snapshot_field(&mut meta, field, deps)?;
    }
    Ok(meta)
}

fn snapshot_field(meta: &mut Value, field: &str, value: &Value) -> Result<()> {
    let Some(deps) = value.as_object() else {
        return Ok(());
    };
    for (child, reference) in deps {
        let range = pnpm_reference(
            child,
            reference
                .as_str()
                .ok_or("Invalid pnpm dependency reference")?,
        );
        meta["_references"][child] = range.clone().into();
        if meta["peerDependencies"].get(child).is_some() {
            continue;
        }
        meta[field][child] = range.split('(').next().unwrap().into();
    }
    Ok(())
}

fn pnpm_importer(manifest: &Value, importer: &Value) -> Result<Value> {
    let mut meta = manifest.clone();
    for field in ["dependencies", "devDependencies", "optionalDependencies"] {
        let Some(deps) = importer[field].as_object() else {
            continue;
        };
        for (name, value) in deps {
            let reference = value["version"]
                .as_str()
                .or_else(|| value.as_str())
                .ok_or("Invalid pnpm dependency version")?;
            meta[field][name] = pnpm_reference(name, reference).into();
        }
    }
    Ok(meta)
}

fn pnpm(
    roots: &[(Vec<String>, Value)],
    members: &BTreeMap<String, local::Local>,
    source: &Value,
    registry: &str,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let mut records = BTreeMap::new();
    if let Some(rows) = source["packages"].as_object() {
        for (key, value) in rows {
            let meta = pnpm_row(key, value, None, registry)?;
            records.insert(
                format!(
                    "{}@{}",
                    meta["name"].as_str().unwrap(),
                    meta["version"].as_str().unwrap()
                ),
                meta,
            );
        }
    }
    if let Some(snapshots) = source["snapshots"].as_object() {
        for (key, snapshot) in snapshots {
            let base = key.split('(').next().unwrap();
            let value = source["packages"]
                .get(base)
                .ok_or_else(|| format!("Missing pnpm package: {base}"))?;
            records.insert(key.clone(), pnpm_row(key, value, Some(snapshot), registry)?);
        }
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut selected = Vec::new();
    for (parent, manifest) in roots {
        let importer = match parent.first().and_then(|name| members.get(name)) {
            Some(member) => member
                .path
                .strip_prefix(&cwd)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            None => ".".into(),
        };
        let importer = source["importers"].get(&importer).unwrap_or(source);
        selected.push((parent.clone(), pnpm_importer(manifest, importer)?));
    }
    graph(&selected, &records, packages)
}

fn find_record<'a>(
    records: &'a BTreeMap<String, Value>,
    name: &str,
    range: &str,
) -> Option<&'a Value> {
    let key = range
        .strip_prefix("npm:")
        .map_or_else(|| format!("{name}@{range}"), str::to_owned);
    records
        .get(&format!("{name}@{range}"))
        .or_else(|| records.get(&key))
        .or_else(|| {
            records.iter().find_map(|(key, value)| {
                let (candidate, _) = key.split('(').next()?.rsplit_once('@')?;
                ((candidate == name || value["name"].as_str() == Some(name))
                    && resolve::matches(value["version"].as_str()?, range))
                .then_some(value)
            })
        })
}

fn graph(
    roots: &[(Vec<String>, Value)],
    records: &BTreeMap<String, Value>,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let mut pending = VecDeque::new();
    for (parent, manifest) in roots {
        for (name, (range, _, peer)) in resolve::dependencies(manifest, false, true) {
            pending.push_back((name, range.clone(), parent.clone(), peer.then_some(range)));
        }
    }
    let mut count = 0;
    while let Some((name, range, parent, peer)) = pending.pop_front() {
        count += 1;
        if count > 10000 {
            return Err("Migrated dependency graph exceeds install limit".into());
        }
        if range.starts_with("workspace:") || range.starts_with("link:") {
            continue;
        }
        let meta = find_record(records, &name, &range)
            .ok_or_else(|| format!("Missing migrated resolution for {name}@{range}"))?;
        let row = record(&name, meta)?;
        if peer_satisfied(packages, &name, peer.as_deref()) {
            continue;
        }
        let mut chain = parent;
        chain.push(name.clone());
        let key = if packages.get(&name).is_none_or(|old| old == &row) {
            name.clone()
        } else {
            chain.join("/")
        };
        if packages.get(&key) == Some(&row) {
            continue;
        }
        packages.insert(key.clone(), row);
        let children = graph_children(meta)?;
        for (child, (range, _, peer)) in children {
            let requirement = peer.then(|| {
                meta["peerDependencies"][&child]
                    .as_str()
                    .unwrap_or(&range)
                    .to_owned()
            });
            pending.push_back((child, range, vec![key.clone()], requirement));
        }
    }
    Ok(())
}

pub fn write(lock: &Value) -> String {
    super::write_lock(lock)
}

pub fn package_meta(meta: &Value) -> Value {
    let mut info = resolve::lock_info(meta);
    normalize_peers(&mut info);
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        if let Some(deps) = info[field].as_object() {
            info[field] = serde_json::to_value(deps.iter().collect::<BTreeMap<_, _>>()).unwrap();
        }
    }
    info
}

fn normalize_peers(meta: &mut Value) {
    let Some(peers) = meta["optionalPeers"].as_array() else {
        return;
    };
    let mut peers: Vec<_> = peers
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    peers.sort();
    peers.dedup();
    for peer in &peers {
        if meta["peerDependencies"].get(peer).is_none() {
            meta["peerDependencies"][peer] = "*".into();
        }
    }
    meta["optionalPeers"] = json!(peers);
}

fn validate_ranges(meta: &Value, include_dev: bool) -> Result<()> {
    for (name, (range, _, _)) in resolve::dependencies(meta, false, include_dev) {
        if range.starts_with("workspace:") {
            continue;
        }
        let version = if let Some(alias) = range.strip_prefix("npm:") {
            resolve::spec(alias)?.1
        } else {
            range.clone()
        };
        if version.contains(':') || version.contains('/') {
            return Err(format!("Unsupported migrated resolution: {name}@{range}"));
        }
    }
    Ok(())
}

fn peer_satisfied(packages: &BTreeMap<String, Value>, name: &str, range: Option<&str>) -> bool {
    let Some(range) = range else {
        return false;
    };
    packages
        .get(name)
        .and_then(|row| row[0].as_str())
        .and_then(|id| id.rsplit_once('@'))
        .is_some_and(|(_, version)| resolve::matches(version, range))
}

fn graph_children(meta: &Value) -> Result<BTreeMap<String, (String, bool, bool)>> {
    let mut children = resolve::dependencies(meta, false, false);
    if let Some(references) = meta["_references"].as_object() {
        for (child, range) in references {
            children.insert(
                child.clone(),
                (
                    range.as_str().ok_or("Invalid snapshot reference")?.into(),
                    false,
                    meta["peerDependencies"].get(child).is_some(),
                ),
            );
        }
    }
    Ok(children)
}

fn hydrate_metadata(packages: &mut BTreeMap<String, Value>, registry: &str) {
    let mut cache: BTreeMap<String, Option<Value>> = BTreeMap::new();
    for row in packages.values_mut() {
        let Some((name, version)) = row[0].as_str().and_then(|id| id.rsplit_once('@')) else {
            continue;
        };
        if row.as_array().is_none_or(|row| row.len() != 4) {
            continue;
        }
        let name = name.to_owned();
        let version = version.to_owned();
        let manifest = cache
            .entry(name.clone())
            .or_insert_with(|| registry_metadata(&name, registry));
        if let Some(manifest) = manifest {
            hydrate_row(row, &manifest["versions"][&version]);
        }
    }
}

fn hydrate_row(row: &mut Value, meta: &Value) {
    let info = resolve::lock_info(meta);
    for field in ["bin", "hasInstallScript", "os", "cpu"] {
        if row[2][field].is_null() && !info[field].is_null() {
            row[2][field] = info[field].clone();
        }
    }
    if row[3] == "" && meta["dist"]["integrity"].is_string() {
        row[3] = meta["dist"]["integrity"].clone();
    }
}

fn registry_metadata(name: &str, registry: &str) -> Option<Value> {
    let url = format!("{registry}/{}", name.replace('/', "%2f"));
    let result = io::fetch(&url, false, false)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()));
    if result.is_err() {
        eprintln!("warn: registry metadata unavailable while migrating {name}");
    }
    result.ok()
}
