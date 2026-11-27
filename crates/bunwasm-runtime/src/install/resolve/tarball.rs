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

pub(in super::super) fn locked_sources(
    locked: &Value,
    manifest: &Value,
) -> BTreeSet<(String, String)> {
    let mut sources = BTreeSet::new();
    let manifest_overrides = Overrides::new(manifest, locked).unwrap_or_default();
    let locked_overrides = Overrides::new(locked, &Value::Null).unwrap_or_default();
    let manifest_catalogs = Catalogs::from_manifest(manifest, locked).unwrap_or_default();
    let locked_catalogs = Catalogs::from_lock(locked);
    collect_declared_sources(
        manifest,
        &manifest_overrides,
        &manifest_catalogs,
        true,
        &mut sources,
    );
    collect_locked_sources(locked, &locked_overrides, &locked_catalogs, &mut sources);
    sources
}

pub(super) fn collect_workspace_sources(
    manifest: &Value,
    locked: &Value,
    workspaces: &BTreeMap<String, super::super::local::Local>,
    overrides: &Overrides,
    catalogs: &Catalogs,
    locked_catalogs: &Catalogs,
    sources: &mut BTreeSet<(String, String)>,
) {
    let locked_overrides = Overrides::new(locked, &Value::Null).unwrap_or_default();
    collect_declared_sources(manifest, overrides, catalogs, true, sources);
    for member in workspaces.values() {
        collect_declared_sources(&member.meta, overrides, catalogs, true, sources);
    }
    collect_locked_sources(locked, &locked_overrides, locked_catalogs, sources);
}

fn collect_locked_sources(
    locked: &Value,
    locked_overrides: &Overrides,
    locked_catalogs: &Catalogs,
    sources: &mut BTreeSet<(String, String)>,
) {
    for meta in locked["workspaces"]
        .as_object()
        .into_iter()
        .flat_map(|members| members.values())
    {
        collect_declared_sources(meta, locked_overrides, locked_catalogs, true, sources);
    }
    for row in locked["packages"]
        .as_object()
        .into_iter()
        .flat_map(|packages| packages.values())
    {
        collect_declared_sources(&row[2], locked_overrides, locked_catalogs, false, sources);
    }
}

fn collect_declared_sources(
    meta: &Value,
    overrides: &Overrides,
    catalogs: &Catalogs,
    workspace: bool,
    sources: &mut BTreeSet<(String, String)>,
) {
    for (name, (range, _, _)) in dependencies(meta, false, true) {
        let Ok((resolved, _)) = resolve_declared(&name, &range, overrides, catalogs, workspace)
        else {
            continue;
        };
        insert_source(&name, Some(resolved), sources);
    }
}

fn insert_source(dep_name: &str, range: Option<&str>, sources: &mut BTreeSet<(String, String)>) {
    let Some(range) = range else {
        return;
    };
    if let Some(alias) = range.strip_prefix("npm:") {
        if let Ok((_, range)) = spec(alias) {
            insert_source(dep_name, Some(&range), sources);
        }
        return;
    }
    if is_specifier(range)
        && let Ok(source) = source(range)
    {
        sources.insert((dep_name.to_owned(), source));
    }
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
