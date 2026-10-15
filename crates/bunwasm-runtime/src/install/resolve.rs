use std::{
    cmp::Ordering,
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
};

use bun_semver::{SlicedString, Version, query};
use serde_json::{Value, json};

use super::io::{self, Result};

#[derive(Clone)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub chain: Vec<String>,
    pub source_chain: Option<Vec<String>>,
    pub meta: Value,
    pub integrity: String,
    pub tarball: String,
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
    if segments.len() != count || segments.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Err(format!("Invalid package name: {name}"));
    }
    if !bare.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b)) {
        return Err(format!("Invalid package name: {name}"));
    }
    Ok(())
}

pub fn spec(input: &str) -> Result<(String, String)> {
    let split = input.rfind('@').filter(|i| *i > 0);
    let (name, range) = split.map_or((input, "latest"), |i| (&input[..i], &input[i + 1..]));
    valid_name(name)?;
    if range.is_empty() {
        return Err(format!("Missing version for {name}"));
    }
    Ok((name.into(), range.into()))
}

pub fn matches(version: &str, range: &str) -> bool {
    let version_bytes = version.as_bytes();
    let range_bytes = range.as_bytes();
    let Some(version) = Version::parse_exact(SlicedString::init(version_bytes, version_bytes)) else {
        return false;
    };
    let Ok(group) = query::parse(range_bytes, SlicedString::init(range_bytes, range_bytes)) else {
        return false;
    };
    match group.get_exact_version() {
        Some(exact) => version.eql(exact),
        None => group.satisfies(version, range_bytes, version_bytes),
    }
}

fn order(a: &str, b: &str) -> Ordering {
    let parse = |s: &[u8]| Version::parse_exact(SlicedString::init(s, s));
    match (parse(a.as_bytes()), parse(b.as_bytes())) {
        (Some(a_version), Some(b_version)) => a_version.order_without_build(b_version, a.as_bytes(), b.as_bytes()),
        _ => a.cmp(b),
    }
}

pub fn dependencies(meta: &Value, production: bool, root: bool) -> BTreeMap<String, (String, bool, bool)> {
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
        out.entry(name.clone()).or_insert((range.into(), false, peer));
    }
}

pub struct Resolver {
    pub packages: BTreeMap<String, Package>,
    pub registry: String,
    pub locked: Value,
    pub refresh: bool,
    packuments: BTreeMap<String, Value>,
    pending: VecDeque<String>,
}

impl Resolver {
    pub fn new(registry: String, locked: Value, refresh: bool) -> Self {
        Self {
            packages: BTreeMap::new(),
            registry,
            locked,
            refresh,
            packuments: BTreeMap::new(),
            pending: VecDeque::new(),
        }
    }

    pub fn resolve(&mut self, manifest: &Value, production: bool) -> Result<()> {
        for (name, (range, optional, _)) in dependencies(manifest, production, true) {
            self.add(&name, &range, vec![name.clone()], optional)?;
        }
        while let Some(key) = self.pending.pop_front() {
            let package = self.packages[&key].clone();
            self.children(&package)?;
        }
        Ok(())
    }

    fn children(&mut self, parent: &Package) -> Result<()> {
        for (name, (range, optional, peer)) in dependencies(&parent.meta, false, false) {
            let Some(target) = self.target(parent, &name, &range, optional || parent.optional)? else {
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

    fn target(&mut self, parent: &Package, name: &str, range: &str, optional: bool) -> Result<Option<String>> {
        if let Some(version) = self.locked_child(parent, name, range) {
            return Ok(Some(version));
        }
        if !is_tag(range) {
            return Ok(Some(range.into()));
        }
        match self.package(name, range, vec![name.into()], optional) {
            Ok(package) => Ok(Some(package.version)),
            Err(_) if optional => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn locked_child(&self, parent: &Package, name: &str, range: &str) -> Option<String> {
        let source_chain = parent.source_chain.as_deref()?;
        let row = &self.locked["packages"][source_chain.join("/")];
        if row[0] != format!("{}@{}", parent.name, parent.version) || !declared(&row[2], name, range) {
            return None;
        }
        for level in (0..=source_chain.len()).rev() {
            let mut candidate = source_chain[..level].to_vec();
            candidate.push(name.into());
            let row = &self.locked["packages"][candidate.join("/")];
            let Some(version) = row[0].as_str().and_then(|v| v.strip_prefix(&format!("{name}@"))) else {
                continue;
            };
            if matches(version, range) || is_tag(range) {
                return Some(version.into());
            }
            return None;
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
        for level in (0..=parent.chain.len()).rev() {
            let mut candidate = parent.chain[..level].to_vec();
            candidate.push(name.into());
            let key = candidate.join("/");
            let Some(found) = self.packages.get_mut(&key) else {
                continue;
            };
            if matches(&found.version, range) {
                self.require(&key, optional);
                return None;
            }
            if peer {
                eprintln!("warn: incorrect peer dependency \"{name}@{range}\"");
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
        let result = self.package(name, range, chain, optional);
        let package = match result {
            Ok(package) => package,
            Err(error) if optional => {
                eprintln!("warn: optional dependency {name}: {error}");
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let key = package.key();
        self.packages.insert(key.clone(), package);
        self.pending.push_back(key);
        Ok(())
    }

    fn package(&mut self, name: &str, range: &str, chain: Vec<String>, optional: bool) -> Result<Package> {
        if let Some(package) = self.from_lock(name, range, &chain, optional) {
            return Ok(package);
        }
        if !self.packuments.contains_key(name) {
            let encoded = name.replace('/', "%2f");
            let bytes = io::fetch(&format!("{}/{encoded}", self.registry), false, self.refresh)?;
            let meta =
                serde_json::from_slice(&bytes).map_err(|e| format!("Invalid registry response for {name}: {e}"))?;
            self.packuments.insert(name.into(), meta);
        }
        let packument = &self.packuments[name];
        let range = packument["dist-tags"][range].as_str().unwrap_or(range);
        let versions = packument["versions"]
            .as_object()
            .ok_or_else(|| format!("No versions found for {name}"))?;
        let version = versions
            .keys()
            .filter(|v| matches(v, range))
            .max_by(|a, b| order(a, b))
            .ok_or_else(|| format!("No version matching \"{range}\" found for specifier \"{name}\""))?;
        let meta = versions[version].clone();
        if !compatible(&meta) {
            return Err(format!("{name}@{version} is not compatible with wasm32-wasip1"));
        }
        let tarball = meta["dist"]["tarball"]
            .as_str()
            .ok_or("Missing package tarball URL")?
            .to_owned();
        let integrity = package_integrity(&meta)?;
        Ok(Package {
            name: name.into(),
            version: version.clone(),
            chain,
            source_chain: None,
            meta,
            tarball,
            integrity,
            optional,
        })
    }

    fn from_lock(&self, name: &str, range: &str, chain: &[String], optional: bool) -> Option<Package> {
        let row = &self.locked["packages"][chain.join("/")];
        if let Some(package) = self.locked_row(row, name, range, chain, optional) {
            return Some(package);
        }
        Version::parse_exact(SlicedString::init(range.as_bytes(), range.as_bytes()))?;
        self.locked["packages"].as_object()?.iter().find_map(|(key, row)| {
            let mut package = self.locked_row(row, name, range, chain, optional)?;
            package.source_chain = Some(super::chain_from_lock(key, row).ok()?);
            Some(package)
        })
    }

    fn locked_row(&self, row: &Value, name: &str, range: &str, chain: &[String], optional: bool) -> Option<Package> {
        let version = row[0].as_str()?.strip_prefix(&format!("{name}@"))?;
        let root_tag = chain.len() == 1 && is_tag(range) && declared(&self.locked["workspaces"][""], name, range);
        if !matches(version, range) && !root_tag {
            return None;
        }
        let source = row[1].as_str()?;
        let tarball = if source.is_empty() {
            if self.registry != "https://registry.npmjs.org" {
                return None;
            }
            format!(
                "https://registry.npmjs.org/{name}/-/{}-{version}.tgz",
                name.rsplit('/').next()?
            )
        } else {
            if !source.starts_with(&format!("{}/", self.registry)) {
                return None;
            }
            source.into()
        };
        if !row[2].is_object() {
            return None;
        }
        let mut meta = row[2].clone();
        meta["name"] = name.into();
        meta["version"] = version.into();
        Some(Package {
            name: name.into(),
            version: version.into(),
            chain: chain.to_vec(),
            source_chain: Some(chain.to_vec()),
            meta,
            tarball,
            integrity: row[3].as_str()?.into(),
            optional,
        })
    }
}

fn is_tag(range: &str) -> bool {
    range.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && range.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}

fn declared(meta: &Value, name: &str, range: &str) -> bool {
    [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ]
    .iter()
    .any(|field| meta[*field][name].as_str() == Some(range))
}

fn package_integrity(meta: &Value) -> Result<String> {
    if let Some(sri) = meta["dist"]["integrity"].as_str() {
        return Ok(sri.into());
    }
    let shasum = meta["dist"]["shasum"].as_str().ok_or("Missing package integrity")?;
    let bytes: Option<Vec<u8>> = (0..shasum.len())
        .step_by(2)
        .map(|i| shasum.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok()))
        .collect();
    Ok(format!(
        "sha1-{}",
        crate::encoding::base64_encode(&bytes.ok_or("Invalid package shasum")?, false)
    ))
}

fn compatible(meta: &Value) -> bool {
    compatible_field(&meta["os"], "wasi") && compatible_field(&meta["cpu"], "wasm32")
}

fn compatible_field(field: &Value, value: &str) -> bool {
    let Some(values) = field.as_array() else {
        return true;
    };
    if values.iter().any(|v| v.as_str() == Some(&format!("!{value}"))) {
        return false;
    }
    !values.iter().any(|v| !v.as_str().unwrap_or("").starts_with('!'))
        || values.iter().any(|v| v == value || v == "any")
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
