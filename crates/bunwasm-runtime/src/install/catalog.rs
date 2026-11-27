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

impl Catalogs {
    pub fn load(
        root: &Path,
        manifest: &Value,
        locked: &Value,
        parser: &dyn Transpiler,
    ) -> Result<Self> {
        let mut default_source = workspace_field(manifest, "catalog");
        let mut named_source = workspace_field(manifest, "catalogs");
        let pnpm_config = if (default_source.is_none() || named_source.is_none())
            && root.join("pnpm-workspace.yaml").exists()
        {
            Some(io::read(&root.join("pnpm-workspace.yaml"), "YAML", parser)?)
        } else {
            None
        };
        if let Some(config) = &pnpm_config {
            if default_source.is_none() && !config["catalog"].is_null() {
                default_source = Some(&config["catalog"]);
            }
            if named_source.is_none() && !config["catalogs"].is_null() {
                named_source = Some(&config["catalogs"]);
            }
        }
        Self::parse(default_source, named_source, locked)
    }

    pub fn from_manifest(manifest: &Value, locked: &Value) -> Result<Self> {
        let default_source = workspace_field(manifest, "catalog");
        let named_source = workspace_field(manifest, "catalogs");
        Self::parse(default_source, named_source, locked)
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
    ) -> Result<Self> {
        let default = match default_source {
            Some(value) => parse_entries(value, None)?,
            None => BTreeMap::new(),
        };
        let named = match named_source {
            Some(value) => parse_named(value)?,
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
        let Some(catalog_name) = range.strip_prefix("catalog:") else {
            return Ok(None);
        };
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

fn parse_entries(value: &Value, catalog_name: Option<&str>) -> Result<BTreeMap<String, String>> {
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
        if range.starts_with("catalog:") {
            return Err(format!(
                "Catalog entry for \"{name}\" cannot reference another catalog"
            ));
        }
        parsed.insert(name.clone(), range.to_owned());
    }
    Ok(parsed)
}

fn parse_named(value: &Value) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let Some(catalogs) = value.as_object() else {
        return Err("catalogs must be an object".into());
    };
    let mut parsed = BTreeMap::new();
    for (name, entries) in catalogs {
        parsed.insert(name.clone(), parse_entries(entries, Some(name))?);
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
