mod next_swc;
mod selection;

pub use selection::matches;
pub(super) use selection::order;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
};

use bun_semver::{SlicedString, Version};
use serde_json::{Value, json};

use super::{
    io::{self, Result},
    local::Local,
    overrides::Overrides,
};

#[derive(Clone)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub chain: Vec<String>,
    pub source_chain: Option<Vec<String>>,
    pub meta: Value,
    pub integrity: String,
    pub tarball: String,
    pub local: Option<Local>,
    pub optional: bool,
}

impl Package {
    pub fn key(&self) -> String {
        self.chain.join("/")
    }
    pub fn path(&self) -> PathBuf {
        path(&self.chain)
    }
}

pub fn path(chain: &[String]) -> PathBuf {
    chain
        .iter()
        .fold(PathBuf::new(), |p, name| p.join("node_modules").join(name))
}

pub fn valid_name(name: &str) -> Result<()> {
    let bare = name.strip_prefix('@').unwrap_or(name);
    let segments: Vec<_> = bare.split('/').collect();
    let count = if name.starts_with('@') { 2 } else { 1 };
    if segments.len() != count
        || segments
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return Err(format!("Invalid package name: {name}"));
    }
    if !bare
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b))
    {
        return Err(format!("Invalid package name: {name}"));
    }
    Ok(())
}

pub fn spec(input: &str) -> Result<(String, String)> {
    let split = input
        .char_indices()
        .find_map(|(i, ch)| (i > 0 && ch == '@').then_some(i));
    let (name, range) = split.map_or((input, "latest"), |i| (&input[..i], &input[i + 1..]));
    valid_name(name)?;
    if range.is_empty() {
        return Err(format!("Missing version for {name}"));
    }
    Ok((name.into(), range.into()))
}

pub fn dependencies(
    meta: &Value,
    production: bool,
    root: bool,
) -> BTreeMap<String, (String, bool, bool)> {
    let mut result = BTreeMap::new();
    add_dependencies(&mut result, meta, "dependencies", false, false);
    if root && !production {
        add_dependencies(&mut result, meta, "devDependencies", false, false);
    }
    add_dependencies(&mut result, meta, "optionalDependencies", true, false);
    add_dependencies(&mut result, meta, "peerDependencies", false, true);
    result.retain(|name, (_, _, peer)| {
        !*peer
            || meta["peerDependenciesMeta"][name]["optional"] != true
                && !meta["optionalPeers"]
                    .as_array()
                    .is_some_and(|peers| peers.iter().any(|p| p == name))
    });
    result
}

fn add_dependencies(
    out: &mut BTreeMap<String, (String, bool, bool)>,
    meta: &Value,
    field: &str,
    optional: bool,
    peer: bool,
) {
    let Some(deps) = meta[field].as_object() else {
        return;
    };
    for (name, range) in deps {
        let Some(range) = range.as_str() else {
            continue;
        };
        if optional {
            out.insert(name.clone(), (range.into(), true, peer));
            continue;
        }
        out.entry(name.clone())
            .or_insert((range.into(), false, peer));
    }
}

pub struct MemberUpdate {
    pub member: String,
    pub dependencies: BTreeSet<String>,
}

#[derive(Clone, Copy)]
enum LockLookup {
    Use,
    Skip,
}

pub struct Resolver {
    pub packages: BTreeMap<String, Package>,
    pub skipped: BTreeMap<String, Package>,
    pub registry: io::Registry,
    pub locked: Value,
    pub refresh: bool,
    #[cfg(test)]
    packuments: BTreeMap<String, Value>,
    responses: BTreeMap<String, Vec<u8>>,
    pending: VecDeque<String>,
    pub workspaces: BTreeMap<String, Local>,
    production: bool,
    pub member_update: Option<MemberUpdate>,
    pub(super) overrides: Overrides,
}

impl Resolver {
    pub fn new(registry: io::Registry, locked: Value, refresh: bool) -> Self {
        Self {
            packages: BTreeMap::new(),
            skipped: BTreeMap::new(),
            registry,
            locked,
            refresh,
            #[cfg(test)]
            packuments: BTreeMap::new(),
            responses: BTreeMap::new(),
            pending: VecDeque::new(),
            workspaces: BTreeMap::new(),
            production: false,
            member_update: None,
            overrides: Overrides::default(),
        }
    }

    pub fn resolve(&mut self, manifest: &Value, production: bool) -> Result<()> {
        self.production = production;
        self.overrides = Overrides::new(manifest, &self.locked)?;
        let members: Vec<_> = self.workspaces.keys().cloned().collect();
        for name in members {
            self.add(&name, "workspace:*", vec![name.clone()], false)?;
        }
        for (name, (range, optional, _)) in dependencies(manifest, production, true) {
            let range = self.overrides.target(&name, &range).to_owned();
            self.add(&name, &range, vec![name.clone()], optional)?;
        }
        let mut pending_peers = VecDeque::new();
        loop {
            while let Some(key) = self.pending.pop_front() {
                let package = self.packages[&key].clone();
                self.children(&package, false)?;
                pending_peers.push_back(key);
            }
            let Some(key) = pending_peers.pop_front() else {
                break;
            };
            let package = self.packages[&key].clone();
            self.children(&package, true)?;
        }
        self.select_platform(manifest)?;
        self.responses.clear();
        #[cfg(test)]
        self.packuments.clear();
        Ok(())
    }

    fn select_platform(&mut self, manifest: &Value) -> Result<()> {
        let mut pending: VecDeque<_> = dependencies(manifest, self.production, true)
            .into_keys()
            .chain(self.workspaces.keys().cloned())
            .collect();
        let mut active = BTreeSet::new();
        while let Some(key) = pending.pop_front() {
            if active.contains(&key) {
                continue;
            }
            let Some(children) = self.platform_children(&key)? else {
                continue;
            };
            active.insert(key);
            pending.extend(children);
        }
        let (packages, skipped) = std::mem::take(&mut self.packages)
            .into_iter()
            .partition(|(key, _)| active.contains(key));
        self.packages = packages;
        self.skipped = skipped;
        Ok(())
    }

    fn platform_children(&mut self, key: &str) -> Result<Option<Vec<String>>> {
        let Some(package) = self.packages.get(key).cloned() else {
            return Ok(None);
        };
        let compatible = match self.package_compatible(&package) {
            Ok(compatible) => compatible,
            Err(error) if package.optional => {
                eprintln!(
                    "warn: optional dependency {}: {}",
                    package.name,
                    self.registry.redact(&error)
                );
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        if !compatible {
            if package.optional {
                return Ok(None);
            }
            return Err(format!(
                "{}@{} is not compatible with linux/wasm32",
                package.name, package.version
            ));
        }
        let workspace = package.local.as_ref().is_some_and(|local| local.workspace);
        Ok(Some(
            dependencies(&package.meta, self.production, workspace)
                .into_keys()
                .filter_map(|name| self.dependency_key(&package, &name))
                .collect(),
        ))
    }

    fn package_compatible(&mut self, package: &Package) -> Result<bool> {
        let meta = &package.meta;
        if package.source_chain.is_none() {
            return Ok(compatible(meta));
        }
        for (field, target) in [("os", "linux"), ("cpu", "wasm32")] {
            if meta[field] != "none" && !compatible_field(&meta[field], target) {
                return Ok(false);
            }
        }
        if meta["os"] != "none" && meta["cpu"] != "none" {
            return Ok(true);
        }
        let packument = self.packument(&package.name)?;
        let metadata = packument["versions"]
            .get(&package.version)
            .filter(|meta| meta.is_object())
            .ok_or("Locked version is missing from registry metadata")?;
        Ok(compatible(metadata))
    }

    fn dependency_key(&self, parent: &Package, name: &str) -> Option<String> {
        for level in (0..=parent.chain.len()).rev() {
            let mut chain = parent.chain[..level].to_vec();
            chain.push(name.into());
            let key = chain.join("/");
            if self.packages.contains_key(&key) {
                return Some(key);
            }
        }
        None
    }

    fn children(&mut self, parent: &Package, peers: bool) -> Result<()> {
        for (name, (range, optional, peer)) in dependencies(
            &parent.meta,
            self.production,
            parent.local.as_ref().is_some_and(|p| p.workspace),
        ) {
            if peer != peers {
                continue;
            }
            let range = self
                .overrides
                .replacement(&name, &range)
                .map(str::to_owned)
                .unwrap_or_else(|| declared_local_target(parent, range));
            let Some(target) = self.target(parent, &name, &range, optional || parent.optional)?
            else {
                continue;
            };
            let chain = self.placement(parent, &name, &target, peer, optional || parent.optional);
            let Some(chain) = chain else {
                continue;
            };
            self.add(&name, &target, chain, optional || parent.optional)?;
        }
        Ok(())
    }

    fn target(
        &mut self,
        parent: &Package,
        name: &str,
        range: &str,
        optional: bool,
    ) -> Result<Option<String>> {
        if self.local_package(name, range)?.is_some() {
            return Ok(Some(range.into()));
        }
        if self.member_update.as_ref().is_some_and(|update| {
            update.member == parent.name && update.dependencies.contains(name)
        }) {
            return self.resolved_target(name, range, optional, LockLookup::Skip);
        }
        if let Some(version) = self.locked_child(parent, name, range) {
            return Ok(Some(version));
        }
        if (!is_tag(range) && !range.starts_with("npm:")) || self.workspaces.contains_key(name) {
            return Ok(Some(range.into()));
        }
        let lookup = if self.overrides.changed.contains(name) {
            LockLookup::Skip
        } else {
            LockLookup::Use
        };
        self.resolved_target(name, range, optional, lookup)
    }

    fn resolved_target(
        &mut self,
        name: &str,
        range: &str,
        optional: bool,
        lookup: LockLookup,
    ) -> Result<Option<String>> {
        match self.package(name, range, vec![name.into()], optional, lookup) {
            Ok(package) => Ok(Some(if range.starts_with("npm:") {
                format!("npm:{}@{}", package.name, package.version)
            } else {
                package.version
            })),
            Err(_) if optional => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn locked_child(&self, parent: &Package, name: &str, range: &str) -> Option<String> {
        if self.overrides.changed.contains(name) {
            return None;
        }
        let source_chain = parent.source_chain.as_deref()?;
        let row = &self.locked["packages"][source_chain.join("/")];
        if row[0] != format!("{}@{}", parent.name, parent.version)
            || !declared_effective(&row[2], name, range, &self.overrides)
        {
            return None;
        }
        let alias = range.strip_prefix("npm:").map(spec).transpose().ok()?;
        let (target_name, target_range) = alias.as_ref().map_or((name, range), |(name, range)| {
            (name.as_str(), range.as_str())
        });
        for level in (0..=source_chain.len()).rev() {
            let mut candidate = source_chain[..level].to_vec();
            candidate.push(name.into());
            let row = &self.locked["packages"][candidate.join("/")];
            let Some(version) = locked_version(row, target_name) else {
                continue;
            };
            if !matches(version, target_range) && !is_tag(target_range) {
                return None;
            }
            return Some(alias.as_ref().map_or_else(
                || version.into(),
                |_| format!("npm:{target_name}@{version}"),
            ));
        }
        None
    }

    fn placement(
        &mut self,
        parent: &Package,
        name: &str,
        range: &str,
        peer: bool,
        optional: bool,
    ) -> Option<Vec<String>> {
        let target = self.local_package(name, range).ok().flatten();
        let alias = range
            .strip_prefix("npm:")
            .and_then(|alias| spec(alias).ok());
        for level in (0..=parent.chain.len()).rev() {
            let mut candidate = parent.chain[..level].to_vec();
            candidate.push(name.into());
            let key = candidate.join("/");
            let Some(found) = self.packages.get_mut(&key) else {
                continue;
            };
            let satisfies = if let Some(target) = &target {
                found
                    .local
                    .as_ref()
                    .is_some_and(|local| local.path == target.path)
            } else if let Some((name, range)) = &alias {
                found.name == *name && matches(&found.version, range)
            } else {
                matches(&found.version, range)
            };
            if satisfies {
                self.require(&key, optional);
                return None;
            }
            if peer {
                eprintln!(
                    "warn: incorrect peer dependency \"{}\"",
                    io::redact(&format!("{name}@{range}"))
                );
                return None;
            }
            break;
        }
        if !self.packages.contains_key(name) {
            return Some(vec![name.into()]);
        }
        let mut chain = parent.chain.clone();
        chain.push(name.into());
        Some(chain)
    }

    fn require(&mut self, key: &str, optional: bool) {
        if optional {
            return;
        }
        let Some(package) = self.packages.get_mut(key) else {
            return;
        };
        if !package.optional {
            return;
        }
        package.optional = false;
        self.pending.push_back(key.into());
    }

    fn add(&mut self, name: &str, range: &str, chain: Vec<String>, optional: bool) -> Result<()> {
        if chain.len() > 128 || self.packages.len() >= 10000 {
            return Err("Dependency graph exceeds install limit".into());
        }
        valid_name(name)?;
        let lookup = if self.overrides.changed.contains(name) {
            LockLookup::Skip
        } else {
            LockLookup::Use
        };
        let result = self.package(name, range, chain, optional, lookup);
        let package = match result {
            Ok(package) => package,
            Err(error) if optional => {
                eprintln!(
                    "warn: optional dependency {name}: {}",
                    self.registry.redact(&error)
                );
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let key = package.key();
        self.packages.insert(key.clone(), package);
        self.pending.push_back(key);
        Ok(())
    }

    fn package(
        &mut self,
        name: &str,
        range: &str,
        chain: Vec<String>,
        optional: bool,
        lookup: LockLookup,
    ) -> Result<Package> {
        if let Some(alias) = range.strip_prefix("npm:") {
            let (target, version) = spec(alias)?;
            return self.package(&target, &version, chain, optional, lookup);
        }
        if let Some(local) = self.local_package(name, range)? {
            return Ok(Package {
                name: local.meta["name"].as_str().unwrap_or(name).into(),
                version: local.meta["version"].as_str().unwrap_or("0.0.0").into(),
                chain,
                source_chain: None,
                meta: local.meta.clone(),
                integrity: String::new(),
                tarball: String::new(),
                optional,
                local: Some(local),
            });
        }
        if matches!(lookup, LockLookup::Use)
            && let Some(package) = self.resolve_from_lock(name, range, &chain, optional)
        {
            return Ok(package);
        }
        let packument = self.packument(name)?;
        let range = packument["dist-tags"][range].as_str().unwrap_or(range);
        let versions = packument["versions"]
            .as_object()
            .ok_or_else(|| format!("No versions found for {name}"))?;
        let version = selection::select(versions, range)
            .ok_or_else(|| {
                format!("No version matching \"{range}\" found for specifier \"{name}\" (but package exists)")
            })?;
        let replacement = platform_package(name, version);
        if replacement != name {
            let version = version.to_owned();
            return self.package(replacement, &version, chain, optional, lookup);
        }
        let mut meta = versions[version].clone();
        next_swc::adapt(&mut meta);
        let tarball = io::source_url(
            meta["dist"]["tarball"]
                .as_str()
                .ok_or("Missing package tarball URL")?,
        )?;
        let integrity = package_integrity(&meta)?;
        Ok(Package {
            name: name.into(),
            version: version.into(),
            chain,
            source_chain: None,
            meta,
            tarball,
            local: None,
            integrity,
            optional,
        })
    }

    fn packument(&mut self, name: &str) -> Result<Value> {
        self.load_packument(name)?;
        #[cfg(test)]
        if let Some(meta) = self.packuments.get(name) {
            return Ok(meta.clone());
        }
        let parsed = serde_json::from_slice(&self.responses[name])
            .map_err(|e| format!("Invalid registry response for {name}: {e}"));
        if parsed.is_err() {
            self.responses.remove(name);
        }
        parsed
    }

    fn load_packument(&mut self, name: &str) -> Result<()> {
        #[cfg(test)]
        if self.packuments.contains_key(name) {
            return Ok(());
        }
        if !self.responses.contains_key(name) {
            let encoded = name.replace('/', "%2f");
            let bytes = io::fetch(
                &format!("{}/{encoded}", self.registry.url),
                false,
                self.refresh,
                &self.registry,
            )?;
            self.responses.insert(name.into(), bytes);
        }
        Ok(())
    }

    fn local_package(&self, name: &str, range: &str) -> Result<Option<Local>> {
        if let Some(local) = self.workspaces.get(name) {
            let version = local.meta["version"].as_str().unwrap_or("0.0.0");
            if range.starts_with("workspace:") || range == "*" || matches(version, range) {
                let requested = range.strip_prefix("workspace:").unwrap_or("*");
                if !["*", "^", "~"].contains(&requested) && !matches(version, requested) {
                    return Err(format!(
                        "Workspace {name}@{version} does not satisfy {range}"
                    ));
                }
                return Ok(Some(local.clone()));
            }
        }
        if range.starts_with("workspace:") {
            return Err(format!("Workspace dependency not found: {name}@{range}"));
        }
        let Some(path) = range
            .strip_prefix("link:")
            .or_else(|| range.strip_prefix("file:"))
        else {
            return Ok(None);
        };
        let path = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path);
        let path = PathBuf::from(crate::resolve::normalize(&path.to_string_lossy()));
        if !path.is_dir() {
            return Err(format!(
                "Local dependency is not a directory: {}",
                path.display()
            ));
        }
        let file = path.join("package.json");
        let meta = if file.exists() {
            serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            json!({"name": name})
        };
        Ok(Some(Local {
            path,
            meta,
            workspace: false,
        }))
    }

    fn resolve_from_lock(
        &self,
        name: &str,
        range: &str,
        chain: &[String],
        optional: bool,
    ) -> Option<Package> {
        let row = &self.locked["packages"][chain.join("/")];
        if let Some(package) = self.locked_row(row, name, range, chain, optional) {
            return Some(package);
        }
        Version::parse_exact(SlicedString::init(range.as_bytes(), range.as_bytes()))?;
        self.locked["packages"]
            .as_object()?
            .iter()
            .find_map(|(key, row)| {
                let mut package = self.locked_row(row, name, range, chain, optional)?;
                package.source_chain = Some(super::chain_from_lock(key, row).ok()?);
                Some(package)
            })
    }

    fn locked_row(
        &self,
        row: &Value,
        name: &str,
        range: &str,
        chain: &[String],
        optional: bool,
    ) -> Option<Package> {
        let version = locked_version(row, name)?;
        let resolved_name = platform_package(name, version);
        let root_tag = chain.len() == 1
            && is_tag(range)
            && declared_root(
                &self.locked["workspaces"][""],
                &chain[0],
                name,
                range,
                &self.overrides,
            );
        if !matches(version, range) && !root_tag {
            return None;
        }
        let source = row[1].as_str()?;
        let tarball = if source.is_empty() {
            format!(
                "{}/{resolved_name}/-/{}-{version}.tgz",
                self.registry.url,
                resolved_name.rsplit('/').next()?
            )
        } else {
            source.into()
        };
        if !row[2].is_object() {
            return None;
        }
        let mut meta = row[2].clone();
        meta["name"] = resolved_name.into();
        meta["version"] = version.into();
        next_swc::adapt(&mut meta);
        Some(Package {
            name: resolved_name.into(),
            version: version.into(),
            chain: chain.to_vec(),
            source_chain: Some(chain.to_vec()),
            meta,
            tarball,
            local: None,
            integrity: row[3].as_str()?.into(),
            optional,
        })
    }
}

fn declared_local_target(parent: &Package, range: String) -> String {
    let Some(local) = &parent.local else {
        return range;
    };
    let Some(path) = range
        .strip_prefix("link:")
        .or_else(|| range.strip_prefix("file:"))
    else {
        return range;
    };
    format!("link:{}", local.path.join(path).display())
}

fn platform_package<'a>(name: &'a str, version: &str) -> &'a str {
    if name == "esbuild" {
        return "esbuild-wasm";
    }
    if name == "rollup" && version.starts_with("4.") {
        return "@rollup/wasm-node";
    }
    name
}

fn locked_version<'a>(row: &'a Value, name: &str) -> Option<&'a str> {
    let (resolved_name, version) = row[0].as_str()?.rsplit_once('@')?;
    (resolved_name == platform_package(name, version)).then_some(version)
}

fn is_tag(range: &str) -> bool {
    range
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && range
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}

fn declared_effective(meta: &Value, name: &str, range: &str, overrides: &Overrides) -> bool {
    [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ]
    .iter()
    .filter_map(|field| meta[*field][name].as_str())
    .any(|declared| overrides.target(name, declared) == range)
}

fn declared_root(
    meta: &Value,
    logical_name: &str,
    resolved_name: &str,
    range: &str,
    overrides: &Overrides,
) -> bool {
    if logical_name == resolved_name && declared_effective(meta, logical_name, range, overrides) {
        return true;
    }
    [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ]
    .iter()
    .filter_map(|field| meta[*field][logical_name].as_str())
    .map(|value| overrides.target(logical_name, value))
    .filter_map(|value| value.strip_prefix("npm:"))
    .filter_map(|alias| spec(alias).ok())
    .any(|(name, target)| name == resolved_name && target == range)
}

fn package_integrity(meta: &Value) -> Result<String> {
    if let Some(sri) = meta["dist"]["integrity"].as_str() {
        return io::normalized_integrity(sri)
            .ok_or_else(|| "Missing or unsupported package integrity".into());
    }
    let Some(shasum) = meta["dist"]["shasum"].as_str() else {
        return Ok(String::new());
    };
    let bytes: Option<Vec<u8>> = (0..shasum.len())
        .step_by(2)
        .map(|i| {
            shasum
                .get(i..i + 2)
                .and_then(|s| u8::from_str_radix(s, 16).ok())
        })
        .collect();
    Ok(format!(
        "sha1-{}",
        crate::encoding::base64_encode(&bytes.ok_or("Invalid package shasum")?, false)
    ))
}

fn compatible(meta: &Value) -> bool {
    compatible_field(&meta["os"], "linux") && compatible_field(&meta["cpu"], "wasm32")
}

fn compatible_field(field: &Value, value: &str) -> bool {
    if let Some(rule) = field.as_str() {
        return rule == "any"
            || rule
                .strip_prefix('!')
                .map_or(rule == value, |deny| deny != value);
    }
    let Some(values) = field.as_array() else {
        return true;
    };
    if values.len() == 1 && values[0] == "any" {
        return true;
    }
    let mut positive = false;
    let mut matched = false;
    for rule in values.iter().filter_map(Value::as_str) {
        if rule.strip_prefix('!') == Some(value) {
            return false;
        }
        if rule.starts_with('!') {
            continue;
        }
        positive = true;
        matched |= rule == value;
    }
    !positive || matched
}

pub fn lock_info(meta: &Value) -> Value {
    let mut info = json!({});
    if meta["hasInstallScript"] == true {
        info["hasInstallScript"] = true.into();
    }
    for field in [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "bin",
        "os",
        "cpu",
    ] {
        if !meta[field].is_null() {
            info[field] = meta[field].clone();
        }
    }
    if let Some(peers) = meta.get("optionalPeers") {
        info["optionalPeers"] = peers.clone();
    }
    let peers: Vec<_> = meta["peerDependenciesMeta"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, v)| v["optional"] == true)
        .map(|(name, _)| Value::String(name.clone()))
        .collect();
    if !peers.is_empty() {
        info["optionalPeers"] = peers.into();
    }
    if meta["scripts"].as_object().is_some_and(|m| {
        ["preinstall", "install", "postinstall"]
            .iter()
            .any(|k| m.contains_key(*k))
    }) {
        info["hasInstallScript"] = true.into();
    }
    info
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod platform_tests;

#[cfg(test)]
mod override_tests;

#[cfg(test)]
mod next_swc_tests;

#[cfg(test)]
mod peer_selection_tests;
