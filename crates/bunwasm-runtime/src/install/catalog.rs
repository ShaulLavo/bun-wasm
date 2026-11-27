use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde_json::{Map, Value};

use super::io::{self, Result};
use crate::Transpiler;

#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub(super) struct Catalogs {
    pub default: BTreeMap<String, String>,
    pub named: BTreeMap<String, BTreeMap<String, String>>,
    pub changed: BTreeSet<String>,
    pub loaded: bool,
}

pub(super) fn is_protocol(range: &str) -> bool {
    range.trim_start().starts_with("catalog:")
}

pub(super) fn yarn_rc_filename() -> String {
    yarn_rc_filename_from(std::env::var("YARN_RC_FILENAME").ok().as_deref())
}

pub(super) fn yarn_rc_filename_from(value: Option<&str>) -> String {
    value
        .filter(|value| !value.is_empty())
        .unwrap_or(".yarnrc.yml")
        .into()
}

impl Catalogs {
    pub fn load(
        root: &Path,
        manifest: &Value,
        locked: &Value,
        parser: &dyn Transpiler,
    ) -> Result<Self> {
        let mut default_source = workspace_field(manifest, "catalog");
        let mut named_source = workspace_field(manifest, "catalogs");
        let pnpm_config = read_optional_yaml(
            &root.join("pnpm-workspace.yaml"),
            default_source.is_none() || named_source.is_none(),
            parser,
        )?;
        if let Some(config) = &pnpm_config {
            fill_catalog_sources(config, &mut default_source, &mut named_source);
        }
        let default_from_yarn = default_source.is_none();
        let named_from_yarn = named_source.is_none();
        let yarn_config = if default_from_yarn || named_from_yarn {
            read_optional_yaml_lenient(&root.join(yarn_rc_filename()), parser)
        } else {
            None
        };
        if let Some(config) = &yarn_config {
            fill_catalog_sources(config, &mut default_source, &mut named_source);
        }
        let mut catalogs = Self::parse(
            default_source,
            named_source,
            locked,
            default_from_yarn && yarn_config.is_some(),
            named_from_yarn && yarn_config.is_some(),
        )?;
        if default_source.is_none()
            && named_source.is_none()
            && !root.join("pnpm-workspace.yaml").is_file()
            && let Some(pnpm_lock) =
                read_optional_yaml_lenient(&root.join("pnpm-lock.yaml"), parser)
        {
            catalogs.merge_pnpm_lock(&pnpm_lock, true, true)?;
            catalogs.recompute_changed(locked);
        }
        Ok(catalogs)
    }

    pub fn from_manifest(manifest: &Value, locked: &Value) -> Result<Self> {
        let default_source = workspace_field(manifest, "catalog");
        let named_source = workspace_field(manifest, "catalogs");
        Self::parse(default_source, named_source, locked, false, false)
    }

    pub fn from_pnpm_lock(pnpm_lock: &Value) -> Result<Self> {
        let mut catalogs = Self {
            loaded: true,
            ..Self::default()
        };
        catalogs.merge_pnpm_lock(pnpm_lock, true, true)?;
        Ok(catalogs)
    }

    pub fn is_empty(&self) -> bool {
        self.default.is_empty() && self.named.is_empty()
    }

    pub fn merge_declared(&mut self, declared: &Self) {
        if let Some(named_default) = declared.named.get("default") {
            let target = self.named.entry("default".into()).or_default();
            for pkg in named_default.keys() {
                if let Some(specifier) = self.default.remove(pkg) {
                    target.entry(pkg.clone()).or_insert(specifier);
                }
            }
        }
        for (pkg, specifier) in &declared.default {
            self.default
                .entry(pkg.clone())
                .or_insert_with(|| specifier.clone());
        }
        for (catalog_name, entries) in &declared.named {
            let target = self.named.entry(catalog_name.clone()).or_default();
            for (pkg, specifier) in entries {
                target
                    .entry(pkg.clone())
                    .or_insert_with(|| specifier.clone());
            }
        }
    }

    fn merge_pnpm_lock(
        &mut self,
        pnpm_lock: &Value,
        fill_default: bool,
        fill_named: bool,
    ) -> Result<()> {
        let Some(catalogs) = pnpm_lock["catalogs"].as_object() else {
            return Ok(());
        };
        for (catalog_name, entries) in catalogs {
            let parsed = parse_pnpm_lock_entries(entries, catalog_name)?;
            if catalog_name == "default" {
                if !fill_default || self.named.contains_key("default") {
                    continue;
                }
                for (pkg, specifier) in parsed {
                    self.default.entry(pkg).or_insert(specifier);
                }
                continue;
            }
            if !fill_named {
                continue;
            }
            let target = self.named.entry(catalog_name.clone()).or_default();
            for (pkg, specifier) in parsed {
                target.entry(pkg).or_insert(specifier);
            }
        }
        check_default_conflicts(&self.default, &self.named)
    }

    fn recompute_changed(&mut self, locked: &Value) {
        let previous = Self::from_lock(locked);
        self.changed = changed_names(&previous, &self.default, &self.named);
    }

    pub fn from_lock(locked: &Value) -> Self {
        let default = locked["catalog"]
            .as_object()
            .map(string_entries)
            .unwrap_or_default();
        let named = locked["catalogs"]
            .as_object()
            .map(|catalogs| {
                catalogs
                    .iter()
                    .filter_map(|(name, entries)| {
                        Some((name.clone(), string_entries(entries.as_object()?)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            default,
            named,
            changed: BTreeSet::new(),
            loaded: true,
        }
    }

    fn parse(
        default_source: Option<&Value>,
        named_source: Option<&Value>,
        locked: &Value,
        normalize_default_yarn: bool,
        normalize_named_yarn: bool,
    ) -> Result<Self> {
        let default = match default_source {
            Some(value) => parse_entries(value, None, normalize_default_yarn)?,
            None => BTreeMap::new(),
        };
        let named = match named_source {
            Some(value) => parse_named(value, normalize_named_yarn)?,
            None => BTreeMap::new(),
        };
        check_default_conflicts(&default, &named)?;
        let previous = Self::from_lock(locked);
        let changed = changed_names(&previous, &default, &named);
        Ok(Self {
            default,
            named,
            changed,
            loaded: true,
        })
    }

    pub fn resolve<'a>(&'a self, name: &str, range: &str) -> Result<Option<&'a str>> {
        let Some(raw_name) = range.trim_start().strip_prefix("catalog:") else {
            return Ok(None);
        };
        let catalog_name = raw_name.trim();
        if catalog_name.is_empty() || catalog_name == "default" {
            return self.resolve_default(name, catalog_name).map(Some);
        }
        let Some(entries) = self.named.get(catalog_name) else {
            return Err(format!(
                "{name}@catalog:{catalog_name}: there is no catalog named \"{catalog_name}\""
            ));
        };
        entries.get(name).map(|v| Some(v.as_str())).ok_or_else(|| {
            format!("{name}@catalog:{catalog_name} not in catalog \"{catalog_name}\"")
        })
    }

    fn resolve_default<'a>(&'a self, name: &str, catalog_name: &str) -> Result<&'a str> {
        if let Some(version) = self.default.get(name) {
            return Ok(version.as_str());
        }
        if let Some(version) = self.named.get("default").and_then(|c| c.get(name)) {
            return Ok(version.as_str());
        }
        if catalog_name == "default"
            && self.default.is_empty()
            && !self.named.contains_key("default")
        {
            return Err(format!(
                "{name}@catalog:default: there is no catalog named \"default\""
            ));
        }
        Err(format!("{name}@catalog:{catalog_name} not in catalog"))
    }

    pub fn resolve_str<'a>(&'a self, name: &str, range: &'a str) -> Result<&'a str> {
        Ok(self.resolve(name, range)?.unwrap_or(range))
    }

    pub fn default_value(&self) -> Option<Value> {
        if self.default.is_empty() {
            return None;
        }
        Some(entries_value(&self.default))
    }

    pub fn named_value(&self) -> Option<Value> {
        if self.named.is_empty() {
            return None;
        }
        let mut out = Map::new();
        for (name, entries) in &self.named {
            out.insert(name.clone(), entries_value(entries));
        }
        Some(Value::Object(out))
    }

    pub fn all_values(&self) -> impl Iterator<Item = &str> {
        self.default
            .values()
            .chain(self.named.values().flat_map(BTreeMap::values))
            .map(String::as_str)
    }
}

fn read_optional_yaml(path: &Path, needed: bool, parser: &dyn Transpiler) -> Result<Option<Value>> {
    if !needed || !path.is_file() {
        return Ok(None);
    }
    Ok(Some(io::read(path, "YAML", parser)?))
}

fn read_optional_yaml_lenient(path: &Path, parser: &dyn Transpiler) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    io::read(path, "YAML", parser).ok()
}

fn fill_catalog_sources<'a>(
    config: &'a Value,
    default_source: &mut Option<&'a Value>,
    named_source: &mut Option<&'a Value>,
) {
    if default_source.is_none() && !config["catalog"].is_null() {
        *default_source = Some(&config["catalog"]);
    }
    if named_source.is_none() && !config["catalogs"].is_null() {
        *named_source = Some(&config["catalogs"]);
    }
}

fn workspace_field<'a>(manifest: &'a Value, field: &str) -> Option<&'a Value> {
    if let Some(value) = manifest["workspaces"]
        .as_object()
        .and_then(|workspaces| workspaces.get(field))
        .filter(|value| !value.is_null())
    {
        return Some(value);
    }
    manifest.get(field).filter(|value| !value.is_null())
}

fn normalize_yarn_range(range: &str) -> &str {
    let Some(rest) = range.strip_prefix("npm:") else {
        return range;
    };
    if rest.is_empty() || rest.starts_with('@') || rest.contains('@') {
        return range;
    }
    rest
}

fn parse_entries(
    value: &Value,
    catalog_name: Option<&str>,
    normalize_yarn: bool,
) -> Result<BTreeMap<String, String>> {
    let Some(entries) = value.as_object() else {
        return Err(match catalog_name {
            Some(name) => format!("Catalog \"{name}\" must be an object"),
            None => "catalog must be an object".into(),
        });
    };
    let mut parsed = BTreeMap::new();
    for (name, range) in entries {
        let Some(range) = range.as_str().filter(|s| !s.is_empty()) else {
            return Err(match catalog_name {
                Some(cat) => {
                    format!("Catalog \"{cat}\" entry for \"{name}\" must be a non-empty string")
                }
                None => format!("Catalog entry for \"{name}\" must be a non-empty string"),
            });
        };
        if is_protocol(range) {
            return Err(format!(
                "Catalog entry for \"{name}\" cannot reference another catalog"
            ));
        }
        let range = if normalize_yarn {
            normalize_yarn_range(range)
        } else {
            range
        };
        parsed.insert(name.clone(), range.to_owned());
    }
    Ok(parsed)
}

fn parse_pnpm_lock_entries(value: &Value, catalog_name: &str) -> Result<BTreeMap<String, String>> {
    let Some(entries) = value.as_object() else {
        return Err(format!("Catalog \"{catalog_name}\" must be an object"));
    };
    let mut parsed = BTreeMap::new();
    for (name, entry) in entries {
        let Some(specifier) = entry["specifier"]
            .as_str()
            .or_else(|| entry.as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if is_protocol(specifier) {
            return Err(format!(
                "Catalog entry for \"{name}\" cannot reference another catalog"
            ));
        }
        parsed.insert(name.clone(), specifier.to_owned());
    }
    Ok(parsed)
}

fn parse_named(
    value: &Value,
    normalize_yarn: bool,
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let Some(catalogs) = value.as_object() else {
        return Err("catalogs must be an object".into());
    };
    let mut parsed = BTreeMap::new();
    for (name, entries) in catalogs {
        parsed.insert(
            name.clone(),
            parse_entries(entries, Some(name), normalize_yarn)?,
        );
    }
    Ok(parsed)
}

fn check_default_conflicts(
    default: &BTreeMap<String, String>,
    named: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<()> {
    let Some(named_default) = named.get("default") else {
        return Ok(());
    };
    for name in default.keys() {
        if named_default.contains_key(name) {
            return Err(format!(
                "\"{name}\" is defined in both \"catalog\" and \"catalogs.default\"; keep one of them"
            ));
        }
    }
    Ok(())
}

fn string_entries(map: &Map<String, Value>) -> BTreeMap<String, String> {
    map.iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect()
}

fn entries_value(entries: &BTreeMap<String, String>) -> Value {
    let mut map = Map::new();
    for (name, range) in entries {
        map.insert(name.clone(), Value::String(range.clone()));
    }
    Value::Object(map)
}

fn changed_names(
    previous: &Catalogs,
    default: &BTreeMap<String, String>,
    named: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeSet<String> {
    let mut changed = BTreeSet::new();
    collect_diff(&previous.default, default, &mut changed);
    for name in previous.named.keys().chain(named.keys()) {
        let before = previous.named.get(name);
        let after = named.get(name);
        if before == after {
            continue;
        }
        let empty = BTreeMap::new();
        collect_diff(
            before.unwrap_or(&empty),
            after.unwrap_or(&empty),
            &mut changed,
        );
    }
    changed
}

fn collect_diff(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
    out: &mut BTreeSet<String>,
) {
    for name in before.keys().chain(after.keys()) {
        if before.get(name) != after.get(name) {
            out.insert(name.clone());
        }
    }
}
