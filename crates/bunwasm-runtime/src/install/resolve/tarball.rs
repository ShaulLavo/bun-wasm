use super::*;
use crate::encoding;

pub(in super::super) fn is_specifier(range: &str) -> bool {
    if let Some(alias) = range.strip_prefix("npm:") {
        return spec(alias).is_ok_and(|(_, range)| is_specifier(&range));
    }
    range.contains("://") || range.starts_with("https:") || range.starts_with("http:")
}

fn source(range: &str) -> Result<String> {
    let url = url::Url::parse(range).map_err(|_| "Invalid tarball dependency URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Tarball dependency URLs must not contain credentials or fragments".into());
    }
    io::source_url(range)
}

pub(super) fn matches(package: &Package, name: &str, range: &str) -> bool {
    if let Some(alias) = range.strip_prefix("npm:") {
        return spec(alias).is_ok_and(|(name, range)| matches(package, &name, &range));
    }
    package.explicit_tarball
        && package.name == name
        && source(range).is_ok_and(|url| package.tarball == url)
}

impl Resolver {
    pub(super) fn tarball_package(
        &mut self,
        name: &str,
        range: &str,
        chain: Vec<String>,
        optional: bool,
    ) -> Result<Package> {
        let tarball = source(range)?;
        let direct = &self.locked["packages"][chain.join("/")];
        let prior = self.locked["packages"]
            .as_object()
            .into_iter()
            .flatten()
            .find(|(_, row)| {
                row[1].as_str() == Some(tarball.as_str()) && locked_version(row, name).is_some()
            });
        let row = if direct[1].as_str() == Some(tarball.as_str()) {
            direct
        } else {
            prior.map_or(&Value::Null, |(_, row)| row)
        };
        let pinned = !row.is_null();
        let expected = if pinned {
            Some(
                io::normalized_integrity(row[3].as_str().unwrap_or_default())
                    .ok_or("Locked tarball dependency needs a supported integrity hash")?,
            )
        } else {
            None
        };
        let bytes = self
            .downloads
            .fetch(&tarball, true, self.refresh, &self.registry)
            .map_err(|error| io::package_fetch_error(name, error))?;
        if let Some(expected) = &expected {
            io::integrity(&bytes, expected)?;
        }
        let mut meta = io::archive_manifest(&bytes)?;
        validate_dependencies(&meta)?;
        let version = validate_manifest(&meta, name)?.to_owned();
        if pinned && row[0] != format!("{name}@{version}") {
            return Err("Tarball name/version does not match locked package identity".into());
        }
        next_swc::adapt(&mut meta);
        wasm_packages::adapt(&mut meta, &self.overrides);
        let integrity = expected.unwrap_or_else(|| {
            format!(
                "sha512-{}",
                encoding::base64_encode(&encoding::digest("sha512", &bytes).unwrap(), false)
            )
        });
        Ok(Package {
            name: name.into(),
            version,
            source_chain: (pinned && direct == row).then(|| chain.clone()),
            chain,
            meta,
            integrity,
            tarball,
            local: None,
            optional,
            explicit_tarball: true,
        })
    }
}

fn validate_manifest<'a>(meta: &'a Value, name: &str) -> Result<&'a str> {
    let actual = meta["name"]
        .as_str()
        .ok_or("Tarball package.json needs a name")?;
    valid_name(actual)?;
    if actual != name {
        return Err(format!(
            "Tarball package name {actual} does not match requested {name}; use an explicit npm alias to rename a package"
        ));
    }
    let version = meta["version"]
        .as_str()
        .ok_or("Tarball package.json needs a version")?;
    Version::parse_exact(SlicedString::init(version.as_bytes(), version.as_bytes()))
        .ok_or("Tarball package.json needs an exact semver version")?;
    Ok(version)
}

fn validate_dependencies(meta: &Value) -> Result<()> {
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        let Some(value) = meta.get(field) else {
            continue;
        };
        let entries = value
            .as_object()
            .ok_or_else(|| format!("Tarball {field} must be an object"))?;
        for (name, range) in entries {
            valid_name(name)?;
            range
                .as_str()
                .filter(|range| !range.is_empty())
                .ok_or_else(|| {
                    format!("Tarball dependency {name} needs a nonempty string specifier")
                })?;
        }
    }
    Ok(())
}

pub(in super::super) fn locked_sources(locked: &Value, manifest: &Value) -> BTreeSet<String> {
    let mut rows = BTreeSet::new();
    let manifest_overrides = Overrides::new(manifest, locked).unwrap_or_default();
    let locked_overrides = Overrides::from_lock(locked);
    let manifest_catalogs = Catalogs::from_manifest(manifest, locked).unwrap_or_default();
    let locked_catalogs = Catalogs::from_lock(locked);
    mark_declared_rows(
        locked,
        &[],
        manifest,
        &manifest_overrides,
        &manifest_catalogs,
        true,
        &mut rows,
    );
    mark_locked_rows(locked, &locked_overrides, &locked_catalogs, &mut rows);
    rows
}

pub(super) fn collect_workspace_sources(
    manifest: &Value,
    locked: &Value,
    workspaces: &BTreeMap<String, super::super::local::Local>,
    overrides: &Overrides,
    catalogs: &Catalogs,
    locked_catalogs: &Catalogs,
    rows: &mut BTreeSet<String>,
) {
    let locked_overrides = Overrides::from_lock(locked);
    mark_declared_rows(locked, &[], manifest, overrides, catalogs, true, rows);
    for (ws_name, member) in workspaces {
        mark_declared_rows(
            locked,
            &[ws_name.as_str()],
            &member.meta,
            overrides,
            catalogs,
            true,
            rows,
        );
    }
    mark_locked_rows(locked, &locked_overrides, locked_catalogs, rows);
}

fn mark_locked_rows(
    locked: &Value,
    locked_overrides: &Overrides,
    locked_catalogs: &Catalogs,
    rows: &mut BTreeSet<String>,
) {
    for (rel_path, meta) in locked["workspaces"].as_object().into_iter().flatten() {
        let mut chain = Vec::new();
        if !rel_path.is_empty()
            && let Some(name) = meta["name"].as_str()
        {
            chain.push(name);
        }
        mark_declared_rows(
            locked,
            &chain,
            meta,
            locked_overrides,
            locked_catalogs,
            true,
            rows,
        );
    }
    for (pkg_key, row) in locked["packages"].as_object().into_iter().flatten() {
        let chain = lock_chain_segments(pkg_key);
        mark_declared_rows(
            locked,
            &chain,
            &row[2],
            locked_overrides,
            locked_catalogs,
            false,
            rows,
        );
    }
}

fn mark_declared_rows(
    locked: &Value,
    parent_chain: &[&str],
    meta: &Value,
    overrides: &Overrides,
    catalogs: &Catalogs,
    workspace: bool,
    rows: &mut BTreeSet<String>,
) {
    for (name, (range, _, _)) in dependencies(meta, false, true) {
        let Ok((resolved, _)) = resolve_declared(&name, &range, overrides, catalogs, workspace)
        else {
            continue;
        };
        let Some(url) = explicit_tarball_url(resolved) else {
            continue;
        };
        mark_bound_row(locked, parent_chain, &name, &url, rows);
    }
}

fn explicit_tarball_url(range: &str) -> Option<String> {
    if let Some(alias) = range.strip_prefix("npm:") {
        let (_, target_range) = spec(alias).ok()?;
        return explicit_tarball_url(&target_range);
    }
    is_specifier(range).then(|| source(range).ok()).flatten()
}

fn mark_bound_row(
    locked: &Value,
    parent_chain: &[&str],
    dep_name: &str,
    url: &str,
    rows: &mut BTreeSet<String>,
) {
    let Some(packages) = locked["packages"].as_object() else {
        return;
    };
    for level in (0..=parent_chain.len()).rev() {
        let mut candidate = Vec::with_capacity(level + 1);
        candidate.extend_from_slice(&parent_chain[..level]);
        candidate.push(dep_name);
        let key = candidate.join("/");
        let Some(row) = packages.get(&key) else {
            continue;
        };
        if row[1].as_str() == Some(url) {
            rows.insert(key);
        }
        return;
    }
}

fn lock_chain_segments(key: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut rest = key;
    while !rest.is_empty() {
        let end = segment_end(rest);
        segments.push(&rest[..end]);
        rest = rest.get(end + 1..).unwrap_or("");
    }
    segments
}

fn segment_end(rest: &str) -> usize {
    if !rest.starts_with('@') {
        return rest.find('/').unwrap_or(rest.len());
    }
    let Some(first) = rest.find('/') else {
        return rest.len();
    };
    rest[first + 1..]
        .find('/')
        .map_or(rest.len(), |second| first + 1 + second)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_validation_keeps_the_existing_transport_policy() {
        assert_eq!(
            source("https://packages.invalid/opaque").unwrap(),
            "https://packages.invalid/opaque"
        );
        assert_eq!(
            source("http://127.0.0.1:1234/fixture").unwrap(),
            "http://127.0.0.1:1234/fixture"
        );
        for value in [
            "https://user:password@packages.invalid/fixture",
            "https://packages.invalid/fixture?token=synthetic",
            "https://packages.invalid/fixture#sha512-synthetic",
            "ftp://packages.invalid/fixture",
            "https://",
        ] {
            assert!(is_specifier(value));
            assert!(source(value).is_err());
        }
        assert!(is_specifier(
            "npm:@fixture/tool@https://packages.invalid/opaque"
        ));
        for range in [
            "^1.0.0",
            "latest",
            "npm:tool@1.0.0",
            "file:./directory",
            "link:./directory",
        ] {
            assert!(!is_specifier(range));
        }
    }

    #[test]
    fn former_explicit_sources_are_not_registry_range_candidates() {
        let source = "https://packages.invalid/opaque";
        let mut resolver = Resolver::new(
            io::Registry::new("http://registry.invalid").unwrap(),
            json!({
                "workspaces":{"":{"dependencies":{"tool":source}}},
                "packages":{"tool":["tool@1.2.3",source,{},"sha512-not-used"]}
            }),
            false,
        );
        resolver.packuments.insert("tool".into(), json!({"versions":{"1.2.3":{
            "name":"tool","version":"1.2.3","dist":{"tarball":"http://registry.invalid/tool.tgz"}
        }}}));
        resolver
            .resolve(&json!({"dependencies":{"tool":"^1"}}), false)
            .unwrap();
        assert_eq!(
            resolver.packages["tool"].tarball,
            "http://registry.invalid/tool.tgz"
        );
        assert!(!resolver.packages["tool"].explicit_tarball);
    }
}
