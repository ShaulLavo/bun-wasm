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

pub fn read(
    manifest: &Value,
    parser: &dyn Transpiler,
    config: &io::Registry,
) -> Result<Option<Value>> {
    if !["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]
        .iter()
        .any(|name| Path::new(name).exists())
    {
        return Ok(None);
    }
    reject_selection_config(manifest)?;
    let registry = clean_registry(&config.url)?;
    let registry = registry.as_str();
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
            &members,
            registry,
            &mut packages,
        )?;
        "package-lock.json"
    } else if Path::new("yarn.lock").exists() {
        yarn(&roots, parser, registry, &mut packages)?;
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
        hydrate_metadata(&mut packages, config)?;
    }
    eprintln!("migrated lockfile from {source}");
    Ok(Some(
        json!({"lockfileVersion": 2, "configVersion": if source == "pnpm-lock.yaml" { 1 } else { 0 }, "workspaces": workspaces, "packages": packages}),
    ))
}

pub fn workspace_meta(manifest: &Value, root: bool) -> Value {
    let mut meta = json!({});
    for field in [
        "name",
        "version",
        "bin",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if !manifest[field].is_null() {
            meta[field] = manifest[field].clone();
        }
    }
    if root {
        meta.as_object_mut().unwrap().shift_remove("version");
    }
    remove_optional_duplicates(&mut meta);
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

fn record(name: &str, meta: &Value, registry: &str) -> Result<Value> {
    validate_ranges(meta, false)?;
    let name = meta["name"].as_str().unwrap_or(name);
    resolve::valid_name(name).map_err(|_| "Invalid migrated package name")?;
    let version = meta["version"]
        .as_str()
        .ok_or("Migrated package has no version")?;
    if !exact_version(version) {
        return Err("Invalid migrated package version".into());
    }
    if !meta["resolved"].is_null() && !meta["resolved"].is_string()
        || !meta["integrity"].is_null() && !meta["integrity"].is_string()
    {
        return Err("Invalid migrated source metadata".into());
    }
    let resolved = meta["resolved"].as_str().unwrap_or("");
    let (tarball, fragment) = resolved.split_once('#').unwrap_or((resolved, ""));
    let tarball = if tarball.starts_with("git+") || tarball.starts_with("github:") {
        resolved
    } else {
        tarball
    };
    let tarball = clean_transport(tarball)?;
    let standard = transport(name, version, &tarball)?.is_empty();
    let integrity = match meta["integrity"].as_str() {
        Some(value) if !value.is_empty() => io::normalized_integrity(value)
            .ok_or("InvalidNPMLockfile: invalid package integrity")?,
        _ if fragment.len() == 40 && fragment.bytes().all(|c| c.is_ascii_hexdigit()) => {
            let bytes = (0..40)
                .step_by(2)
                .map(|i| u8::from_str_radix(&fragment[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>();
            format!("sha1-{}", crate::encoding::base64_encode(&bytes, false))
        }
        _ => String::new(),
    };
    if !supported_integrity(&integrity)
        && !tarball.is_empty()
        && !under_registry(&tarball, registry)
        && !under_registry(&tarball, "https://registry.npmjs.org")
        && !under_registry(&tarball, "https://registry.yarnpkg.com")
    {
        return Err("InvalidNPMLockfile".into());
    }
    let info = package_meta(meta);
    Ok(json!([
        format!("{name}@{version}"),
        if standard { "" } else { &tarball },
        info,
        integrity
    ]))
}

fn npm_row(
    path: &str,
    meta: &Value,
    workspace_paths: &BTreeMap<String, String>,
    registry: &str,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    if !meta.is_object() {
        return Err("InvalidNPMLockfile".into());
    }
    for field in [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ] {
        validate_dependency_map(&meta[field], false).map_err(|_| "InvalidNPMLockfile")?;
    }
    if meta["link"] == true {
        let target = meta["resolved"].as_str().ok_or("InvalidNPMLockfile")?;
        if !workspace_paths.contains_key(target) {
            return Err("Unsupported migrated npm link target".into());
        }
        return Ok(());
    }
    if path.is_empty() || workspace_paths.contains_key(path) {
        return Ok(());
    }
    let (prefix, path) = match path.strip_prefix("node_modules/") {
        Some(path) => (String::new(), path),
        None => {
            let (workspace, tail) = path
                .split_once("/node_modules/")
                .ok_or("InvalidNPMLockfile")?;
            let name = workspace_paths.get(workspace).ok_or("InvalidNPMLockfile")?;
            (format!("{name}/"), tail)
        }
    };
    let name = path.rsplit("node_modules/").next().unwrap();
    let key = format!("{prefix}{}", path.replace("/node_modules/", "/"));
    packages.insert(
        key,
        record(name, &npm_bin(name, meta), registry).map_err(|error| {
            if error == "Invalid migrated package version" {
                "InvalidNPMLockfile".into()
            } else {
                error
            }
        })?,
    );
    Ok(())
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

fn npm(
    source: &Value,
    members: &BTreeMap<String, local::Local>,
    registry: &str,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let version = source["lockfileVersion"]
        .as_u64()
        .ok_or("InvalidNPMLockfile")?;
    if !(2..=4).contains(&version) {
        return Err(format!(
            "package-lock.json is lockfileVersion {version}, which bun cannot migrate\nnote: npm install --package-lock-only --lockfile-version=3"
        ));
    }
    let rows = source["packages"].as_object().ok_or("InvalidNPMLockfile")?;
    if !rows.get("").is_some_and(Value::is_object) {
        return Err("InvalidNPMLockfile".into());
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let paths = members
        .iter()
        .map(|(name, member)| {
            (
                member
                    .path
                    .strip_prefix(&cwd)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                name.clone(),
            )
        })
        .collect();
    for (path, meta) in rows {
        npm_row(path, meta, &paths, registry, packages)?;
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

fn yarn_record(selector: &str, value: &Value, registry: &str) -> Result<Option<(String, Value)>> {
    let (name, range) = resolve::spec(selector).map_err(|_| "Invalid yarn.lock descriptor")?;
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        validate_dependency_map(&value[field], false)?;
    }
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
            .ok_or("Unsupported migrated resolution")?;
        if !exact_version(version) {
            return Err("yarn.lock entry has an invalid version".into());
        }
        meta["name"] = target.into();
        meta["version"] = version.into();
        meta["resolved"] = format!(
            "{registry}/{target}/-/{}-{version}.tgz",
            target.rsplit('/').next().unwrap()
        )
        .into();
    } else if let Some(alias) = range.strip_prefix("npm:") {
        meta["name"] = resolve::spec(alias)
            .map_err(|_| "Unsupported migrated resolution")?
            .0
            .into();
    }
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        normalize_yarn_dependencies(&mut meta[field]);
    }
    let optional: Vec<_> = meta["dependenciesMeta"]
        .as_object()
        .into_iter()
        .flat_map(|deps| deps.iter())
        .filter(|(_, info)| info["optional"] == true)
        .map(|(name, _)| name.clone())
        .collect();
    for name in optional {
        let Some(range) = meta["dependencies"].get(&name).cloned() else {
            continue;
        };
        meta["optionalDependencies"][&name] = range;
        meta["dependencies"]
            .as_object_mut()
            .unwrap()
            .shift_remove(&name);
    }
    if meta["dependencies"]
        .as_object()
        .is_some_and(|deps| deps.is_empty())
    {
        meta.as_object_mut().unwrap().shift_remove("dependencies");
    }
    Ok(Some((format!("{logical}@{}", npm_range(&range)), meta)))
}

fn yarn(
    roots: &[(Vec<String>, Value)],
    parser: &dyn Transpiler,
    registry: &str,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let text = fs::read_to_string("yarn.lock").map_err(|e| e.to_string())?;
    let berry = text.starts_with("__metadata:") || text.contains("\n__metadata:");
    let config = yarn_config(parser)?;
    let source = if berry {
        let source = io::parsed(text.as_bytes(), "YAML", parser)?;
        let version = source["__metadata"]["version"]
            .as_u64()
            .or_else(|| source["__metadata"]["version"].as_str()?.parse().ok());
        if !version.is_some_and(|version| (4..=10).contains(&version)) {
            return Err("yarn.lock version is not supported".into());
        }
        let rows = source
            .as_object()
            .ok_or("yarn.lock must be a YAML mapping")?;
        if !rows.values().any(|row| {
            row["resolution"]
                .as_str()
                .is_some_and(|value| value.ends_with("@workspace:."))
        }) {
            return Err("yarn.lock has no root workspace entry (\"@workspace:.\")".into());
        }
        source
    } else {
        if !text.contains("# yarn lockfile v1") {
            return Err("UnsupportedYarnLockfileVersion".into());
        }
        classic(&text, parser)?
    };
    let mut records = BTreeMap::new();
    for (selectors, value) in source.as_object().ok_or("Invalid yarn.lock")? {
        if selectors == "__metadata" {
            continue;
        }
        if !value.is_object() || berry && !value["resolution"].is_string() {
            return Err("Invalid yarn.lock entry mapping or resolution".into());
        }
        for selector in selectors.split(", ") {
            let (name, range) =
                resolve::spec(selector).map_err(|_| "Invalid yarn.lock descriptor")?;
            let registry = if berry && !range.starts_with("workspace:") {
                yarn_registry(&config, &name, registry)?
            } else {
                registry.to_owned()
            };
            records.extend(yarn_record(selector, value, &registry)?);
        }
    }
    graph(
        roots,
        &records,
        packages,
        registry,
        config["enableTransparentWorkspaces"] != false,
    )
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
    if yaml.is_empty() {
        return Ok(json!({}));
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
    if !value.is_object() || !value["resolution"].is_object() || !exact_version(version) {
        return Err("InvalidPnpmLockfile".into());
    }
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
        return Err("Unsupported migrated resolution".into());
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
    if value.is_null() {
        return Ok(());
    }
    let deps = value.as_object().ok_or("Invalid pnpm dependency mapping")?;
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
    let mut normalized = manifest.clone();
    remove_optional_duplicates(&mut normalized);
    let mut meta = normalized.clone();
    for field in ["dependencies", "devDependencies", "optionalDependencies"] {
        pnpm_importer_field(&mut meta, &normalized, importer, field)?;
    }
    Ok(meta)
}

fn pnpm_importer_field(
    meta: &mut Value,
    manifest: &Value,
    importer: &Value,
    field: &str,
) -> Result<()> {
    if importer[field].is_null() && manifest[field].is_null() {
        return Ok(());
    }
    let deps = importer[field]
        .as_object()
        .ok_or("Invalid pnpm importer dependency mapping")?;
    if manifest[field]
        .as_object()
        .is_some_and(|expected| expected.keys().any(|name| !deps.contains_key(name)))
    {
        return Err("pnpm-lock.yaml importer specifier does not match package.json".into());
    }
    for (name, value) in deps {
        let specifier = value["specifier"]
            .as_str()
            .or_else(|| importer["specifiers"][name].as_str());
        let requested = manifest[field][name].as_str().or_else(|| {
            (field == "dependencies")
                .then(|| manifest["peerDependencies"][name].as_str())
                .flatten()
        });
        if specifier != requested {
            return Err("pnpm-lock.yaml importer specifier does not match package.json".into());
        }
        let reference = value["version"]
            .as_str()
            .or_else(|| value.as_str())
            .ok_or("Invalid pnpm dependency version")?;
        validate_pnpm_selection(
            name,
            requested.ok_or("Invalid pnpm importer specifier")?,
            reference,
        )?;
        meta[field][name] = pnpm_reference(name, reference).into();
    }
    Ok(())
}

fn pnpm(
    roots: &[(Vec<String>, Value)],
    members: &BTreeMap<String, local::Local>,
    source: &Value,
    registry: &str,
    packages: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let version = source["lockfileVersion"]
        .as_f64()
        .or_else(|| source["lockfileVersion"].as_str()?.parse().ok())
        .ok_or("pnpm-lock.yaml missing or invalid 'lockfileVersion' field")?;
    if version < 7.0 {
        return Err(format!(
            "pnpm-lock.yaml is lockfileVersion {version}, which bun cannot migrate"
        ));
    }
    reject_selection_config(source)?;
    if !source["importers"].is_object()
        || (!source["packages"].is_null() && !source["packages"].is_object())
        || (!source["snapshots"].is_null() && !source["snapshots"].is_object())
    {
        return Err("InvalidPnpmLockfile".into());
    }
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
            if !snapshot.is_object() {
                return Err("InvalidPnpmLockfile".into());
            }
            let base = key.split('(').next().unwrap();
            let value = source["packages"]
                .get(base)
                .ok_or("Missing pnpm package entry")?;
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
        let source_importer = source["importers"]
            .get(&importer)
            .ok_or("Missing pnpm importer")?;
        let mut meta = pnpm_importer(manifest, source_importer)?;
        validate_pnpm_links(&mut meta, manifest, &cwd.join(&importer), members)?;
        selected.push((parent.clone(), meta));
    }
    graph(&selected, &records, packages, registry, true)
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
}

fn graph(
    roots: &[(Vec<String>, Value)],
    records: &BTreeMap<String, Value>,
    packages: &mut BTreeMap<String, Value>,
    registry: &str,
    transparent_workspaces: bool,
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
        if workspace_selected(roots, &name, &range, transparent_workspaces)? {
            continue;
        }
        if peer_satisfied(packages, &name, peer.as_deref()) {
            continue;
        }
        let meta = peer
            .as_ref()
            .and_then(|range| peer_record(records, &name, range))
            .or_else(|| find_record(records, &name, &range))
            .ok_or_else(|| format!("Missing migrated resolution for {name}"))?;
        let row = record(&name, meta, registry)?;
        if parent.is_empty()
            && packages
                .get(&name)
                .is_some_and(|row| row.as_array().is_some_and(|row| row.len() == 1))
        {
            return Err(
                "Registry selection replacing a root workspace is not supported during migration"
                    .into(),
            );
        }
        if visible_row(packages, &parent, &name) == Some(&row) {
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
        let placed_chain = super::chain_from_lock(&key, &row)?;
        packages.insert(key, row);
        let children = graph_children(meta)?;
        for (child, (range, _, peer)) in children {
            let requirement = peer.then(|| {
                meta["peerDependencies"][&child]
                    .as_str()
                    .unwrap_or(&range)
                    .to_owned()
            });
            pending.push_back((child, range, placed_chain.clone(), requirement));
        }
    }
    Ok(())
}

pub fn write(lock: &Value, registry: &io::Registry) -> Result<String> {
    super::write_lock(lock, registry)
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
    for field in [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ] {
        validate_dependency_map(&meta[field], field == "devDependencies" && !include_dev)?;
    }
    for (name, (range, _, _)) in resolve::dependencies(meta, false, include_dev) {
        if let Some(reference) = range
            .strip_prefix("workspace:")
            .or_else(|| range.strip_prefix("link:"))
        {
            if reference.contains(':')
                || reference.contains('@')
                || reference.contains('?')
                || reference.contains('#')
            {
                return Err(format!("Unsupported migrated resolution for {name}"));
            }
            continue;
        }
        let version = if let Some(alias) = range.strip_prefix("npm:") {
            resolve::spec(alias)
                .map_err(|_| "Unsupported migrated resolution")?
                .1
        } else {
            range.clone()
        };
        if version.contains(':') || version.contains('/') {
            return Err(format!("Unsupported migrated resolution for {name}"));
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
                    meta["optionalDependencies"].get(child).is_some(),
                    meta["peerDependencies"].get(child).is_some(),
                ),
            );
        }
    }
    Ok(children)
}

fn hydrate_metadata(packages: &mut BTreeMap<String, Value>, registry: &io::Registry) -> Result<()> {
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
            hydrate_row(row, &manifest["versions"][&version])?;
        }
    }
    Ok(())
}

fn hydrate_row(row: &mut Value, meta: &Value) -> Result<()> {
    let info = resolve::lock_info(meta);
    for field in ["bin", "hasInstallScript", "os", "cpu"] {
        if row[2][field].is_null() && !info[field].is_null() {
            row[2][field] = info[field].clone();
        }
    }
    if row[3] == "" && meta["dist"]["integrity"].is_string() {
        row[3] = io::normalized_integrity(meta["dist"]["integrity"].as_str().unwrap())
            .ok_or("InvalidNPMLockfile: invalid package integrity")?
            .into();
    }
    Ok(())
}

fn registry_metadata(name: &str, registry: &io::Registry) -> Option<Value> {
    let url = format!("{}/{}", registry.url, name.replace('/', "%2f"));
    let result = io::fetch(&url, false, false, registry)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()));
    if result.is_err() {
        eprintln!("warn: registry metadata unavailable while migrating {name}");
    }
    result.ok()
}

fn remove_optional_duplicates(meta: &mut Value) {
    let names: Vec<_> = meta["optionalDependencies"]
        .as_object()
        .into_iter()
        .flat_map(|deps| deps.keys().cloned())
        .collect();
    for field in ["dependencies", "devDependencies"] {
        let Some(deps) = meta.get_mut(field).and_then(Value::as_object_mut) else {
            continue;
        };
        for name in &names {
            deps.shift_remove(name);
        }
        if deps.is_empty() {
            meta.as_object_mut().unwrap().shift_remove(field);
        }
    }
}

fn peer_record<'a>(
    records: &'a BTreeMap<String, Value>,
    name: &str,
    range: &str,
) -> Option<&'a Value> {
    records
        .iter()
        .filter_map(|(key, value)| {
            let (logical, _) = key.split('(').next()?.rsplit_once('@')?;
            let version = value["version"].as_str()?;
            ((logical == name || value["name"].as_str() == Some(name))
                && resolve::matches(version, range))
            .then_some((version, value))
        })
        .max_by(|(left, _), (right, _)| resolve::order(left, right))
        .map(|(_, value)| value)
}

fn exact_version(version: &str) -> bool {
    let bytes = version.as_bytes();
    bun_semver::Version::parse_exact(bun_semver::SlicedString::init(bytes, bytes)).is_some()
}

fn validate_dependency_map(value: &Value, skip: bool) -> Result<()> {
    if skip || value.is_null() {
        return Ok(());
    }
    let deps = value
        .as_object()
        .ok_or("Invalid dependency mapping in migrated lockfile")?;
    for (name, range) in deps {
        resolve::valid_name(name).map_err(|_| "Invalid migrated dependency name")?;
        if !range.is_string() {
            return Err("Invalid dependency value in migrated lockfile".into());
        }
    }
    Ok(())
}

fn reject_selection_config(value: &Value) -> Result<()> {
    for field in [
        "overrides",
        "resolutions",
        "patchedDependencies",
        "packageExtensions",
    ] {
        if value[field]
            .as_object()
            .is_some_and(|rules| rules.is_empty())
            || value[field].is_null()
        {
            continue;
        }
        return Err(format!("Migration of {field} is not supported"));
    }
    if !value["pnpm"].is_null() {
        reject_selection_config(&value["pnpm"])?;
    }
    Ok(())
}

fn clean_registry(registry: &str) -> Result<String> {
    let url = clean_transport(registry)?;
    if url.contains('?') || url.contains('#') {
        return Err("Invalid registry URL".into());
    }
    if url.is_empty() {
        return Err("Invalid registry URL".into());
    }
    Ok(url.trim_end_matches('/').into())
}

fn clean_transport(value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    io::source_url(value)
}

pub(super) fn transport(name: &str, version: &str, value: &str) -> Result<String> {
    let clean = clean_transport(value)?;
    let suffix = format!(
        "{name}/-/{}-{version}.tgz",
        name.rsplit('/').next().unwrap()
    );
    if [
        "https://registry.npmjs.org/",
        "https://registry.yarnpkg.com/",
    ]
    .iter()
    .any(|origin| clean.strip_prefix(origin) == Some(suffix.as_str()))
    {
        return Ok(String::new());
    }
    Ok(clean)
}

fn under_registry(value: &str, registry: &str) -> bool {
    let Ok(value) = url::Url::parse(value) else {
        return false;
    };
    let Ok(registry) = url::Url::parse(registry) else {
        return false;
    };
    value.origin() == registry.origin()
        && value
            .path()
            .starts_with(&format!("{}/", registry.path().trim_end_matches('/')))
}

fn visible_row<'a>(
    packages: &'a BTreeMap<String, Value>,
    parent: &[String],
    name: &str,
) -> Option<&'a Value> {
    for level in (0..=parent.len()).rev() {
        let mut chain = parent[..level].to_vec();
        chain.push(name.into());
        if let Some(row) = packages.get(&chain.join("/")) {
            return Some(row);
        }
    }
    None
}

fn workspace_selected(
    roots: &[(Vec<String>, Value)],
    name: &str,
    range: &str,
    transparent: bool,
) -> Result<bool> {
    let workspace = roots
        .iter()
        .find(|(chain, _)| chain.first().is_some_and(|value| value == name));
    let explicit = range.strip_prefix("workspace:");
    let Some((_, manifest)) = workspace else {
        return if explicit.is_some() || range.starts_with("link:") {
            Err("Workspace link dependencies to non-existent folders aren't supported yet in pnpm-lock.yaml migration".into())
        } else {
            Ok(false)
        };
    };
    let version = manifest["version"].as_str().unwrap_or("0.0.0");
    let requested = explicit.unwrap_or(range);
    let matches = ["*", "^", "~"].contains(&requested) || resolve::matches(version, requested);
    if explicit.is_some() && !matches {
        return Err(format!(
            "Workspace {name} does not satisfy the migrated reference"
        ));
    }
    Ok(matches && (explicit.is_some() || transparent))
}

fn validate_pnpm_links(
    meta: &mut Value,
    manifest: &Value,
    importer: &Path,
    members: &BTreeMap<String, local::Local>,
) -> Result<()> {
    for field in ["dependencies", "devDependencies", "optionalDependencies"] {
        let Some(deps) = meta[field].as_object_mut() else {
            continue;
        };
        for (name, range) in deps {
            *range = pnpm_link_reference(name, range, &manifest[field][name], importer, members)?;
        }
    }
    Ok(())
}

fn pnpm_link_reference(
    name: &str,
    range: &Value,
    requested: &Value,
    importer: &Path,
    members: &BTreeMap<String, local::Local>,
) -> Result<Value> {
    let Some(link) = range.as_str().and_then(|range| range.strip_prefix("link:")) else {
        return Ok(range.clone());
    };
    let target = local::physical(&importer.join(link))?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let importer = local::relative(importer, &cwd);
    let missing = || {
        format!(
            "pnpm-lock.yaml has no package entry for dependency '{name}' of importer '{}'",
            importer.display()
        )
    };
    if !target.is_dir() {
        return Err(missing());
    }
    let member = members
        .get(name)
        .filter(|member| member.path == target)
        .ok_or_else(missing)?;
    let version = member.meta["version"].as_str().unwrap_or("0.0.0");
    let requested = requested.as_str().unwrap_or("*");
    let requested = requested.strip_prefix("workspace:").unwrap_or(requested);
    if !["*", "^", "~"].contains(&requested)
        && !requested.starts_with("link:")
        && !resolve::matches(version, requested)
    {
        return Err(
            "pnpm workspace selected version does not satisfy package.json specifier".into(),
        );
    }
    Ok(format!("workspace:{version}").into())
}

fn yarn_config(parser: &dyn Transpiler) -> Result<Value> {
    let mut config = json!({});
    if let Ok(value) = std::env::var("YARN_NPM_REGISTRY_SERVER")
        && !value.is_empty()
    {
        config["npmRegistryServer"] = value.into();
    }
    if let Ok(value) = std::env::var("YARN_ENABLE_TRANSPARENT_WORKSPACES") {
        config["enableTransparentWorkspaces"] = (!["false", "0"].contains(&value.as_str())).into();
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let filename = std::env::var("YARN_RC_FILENAME").unwrap_or_else(|_| ".yarnrc.yml".into());
    for directory in cwd.ancestors() {
        merge_yarn_config(&mut config, &directory.join(&filename), parser)?;
    }
    if let Ok(home) = std::env::var("HOME") {
        merge_yarn_config(&mut config, &Path::new(&home).join(filename), parser)?;
    }
    Ok(config)
}

fn merge_yarn_config(config: &mut Value, path: &Path, parser: &dyn Transpiler) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let source = io::read(path, "YAML", parser).map_err(|_| "Invalid .yarnrc.yml")?;
    reject_selection_config(&source)?;
    for field in ["npmRegistryServer", "enableTransparentWorkspaces"] {
        if config[field].is_null() && !source[field].is_null() {
            config[field] = source[field].clone();
        }
    }
    let Some(scopes) = source["npmScopes"].as_object() else {
        return Ok(());
    };
    for (name, scope) in scopes {
        if config["npmScopes"][name].is_null() {
            config["npmScopes"][name] = scope.clone();
        }
    }
    Ok(())
}

fn yarn_registry(config: &Value, name: &str, registry: &str) -> Result<String> {
    let scope = name
        .strip_prefix('@')
        .and_then(|name| name.split('/').next());
    let from_yarn = scope
        .and_then(|scope| config["npmScopes"][scope]["npmRegistryServer"].as_str())
        .or_else(|| (scope == Some("jsr")).then_some("https://npm.jsr.io"))
        .or_else(|| config["npmRegistryServer"].as_str());
    let Some(from_yarn) = from_yarn else {
        return Ok(registry.into());
    };
    if from_yarn.contains("${") {
        return Err(format!(
            "yarn's registry for \"{name}\" uses an environment variable; bun cannot tell if it is the registry bun is configured with"
        ));
    }
    let configured = clean_registry(registry)?;
    let source = clean_registry(from_yarn)?;
    let canonical = |url: &str| {
        if url == "https://registry.yarnpkg.com" {
            "https://registry.npmjs.org".to_owned()
        } else {
            url.to_owned()
        }
    };
    if canonical(&configured) != canonical(&source) {
        return Err(format!(
            "yarn fetches \"{name}\" from {source} and bun is configured to fetch it from {configured}; add the registry to bunfig.toml or .npmrc"
        ));
    }
    Ok(configured)
}

fn supported_integrity(integrity: &str) -> bool {
    io::normalized_integrity(integrity).is_some()
}

fn validate_pnpm_selection(name: &str, requested: &str, reference: &str) -> Result<()> {
    if reference.starts_with("link:") || requested.starts_with("workspace:") {
        return Ok(());
    }
    let selected = pnpm_reference(name, reference);
    let selected = selected.split('(').next().unwrap();
    let version = selected
        .strip_prefix("npm:")
        .and_then(|value| value.rsplit_once('@').map(|(_, version)| version))
        .unwrap_or(selected);
    let range = match requested.strip_prefix("npm:") {
        Some(alias) => {
            resolve::spec(alias)
                .map_err(|_| "Invalid pnpm importer specifier")?
                .1
        }
        None => requested.to_owned(),
    };
    let tag = range
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
        && range
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic);
    if !exact_version(version) || !tag && !resolve::matches(version, &range) {
        return Err(
            "pnpm-lock.yaml selected version does not satisfy package.json specifier".into(),
        );
    }
    Ok(())
}
