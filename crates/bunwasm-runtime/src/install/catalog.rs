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
    pub from_yarn: bool,
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
        let (mut default_source, mut named_source) = manifest_catalog_sources(manifest);
        let pnpm_config = if default_source.is_none() && named_source.is_none() {
            read_optional_yaml_lenient(&root.join("pnpm-workspace.yaml"), parser)
        } else {
            None
        };
        if let Some(config) = &pnpm_config {
            (default_source, named_source) = object_catalog_sources(config);
        }
        let from_yarn = default_source.is_none() && named_source.is_none();
        let yarn_config = if from_yarn {
            read_optional_yaml_lenient(&root.join(yarn_rc_filename()), parser)
        } else {
            None
        };
        if let Some(config) = &yarn_config {
            (default_source, named_source) = object_catalog_sources(config);
        }
        let mut catalogs = Self::parse(default_source, named_source, locked)?;
        catalogs.from_yarn = from_yarn
            && yarn_config.is_some()
            && (default_source.is_some() || named_source.is_some());
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
        let (default_source, named_source) = manifest_catalog_sources(manifest);
        Self::parse(default_source, named_source, locked)
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
        self.move_named_default_entries(declared);
        insert_missing_entries(&mut self.default, &declared.default);
        for (catalog_name, entries) in &declared.named {
            let target = self.named.entry(catalog_name.clone()).or_default();
            insert_missing_entries(target, entries);
        }
    }

    fn move_named_default_entries(&mut self, declared: &Self) {
        let Some(named_default) = declared.named.get("default") else {
            return;
        };
        let target = self.named.entry("default".into()).or_default();
        for pkg in named_default.keys() {
            let Some(specifier) = self.default.remove(pkg) else {
                continue;
            };
            target.entry(pkg.clone()).or_insert(specifier);
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
            self.merge_pnpm_catalog(catalog_name, parsed, fill_default, fill_named);
        }
        check_default_conflicts(&self.default, &self.named)
    }

    fn merge_pnpm_catalog(
        &mut self,
        catalog_name: &str,
        parsed: BTreeMap<String, String>,
        fill_default: bool,
        fill_named: bool,
    ) {
        if catalog_name == "default" {
            if !fill_default || self.named.contains_key("default") {
                return;
            }
            merge_owned_entries(&mut self.default, parsed);
            return;
        }
        if !fill_named {
            return;
        }
        let target = self.named.entry(catalog_name.to_owned()).or_default();
        merge_owned_entries(target, parsed);
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
            from_yarn: false,
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
            from_yarn: false,
        })
    }

    fn normalize_resolved<'a>(&self, entry: &'a str) -> &'a str {
        if self.from_yarn {
            return without_yarn_npm_protocol(entry);
        }
        without_npm_protocol(entry)
    }

    pub fn resolve<'a>(&'a self, name: &str, range: &str) -> Result<Option<&'a str>> {
        let Some(raw_name) = range.trim_start().strip_prefix("catalog:") else {
            return Ok(None);
        };
        let catalog_name = raw_name.trim();
        if catalog_name.is_empty() || catalog_name == "default" {
            return self
                .resolve_default(name, catalog_name)
                .map(|entry| Some(self.normalize_resolved(entry)));
        }
        let Some(entries) = self.named.get(catalog_name) else {
            return Err(format!(
                "{name}@catalog:{catalog_name}: there is no catalog named \"{catalog_name}\""
            ));
        };
        entries
            .get(name)
            .map(|v| Some(self.normalize_resolved(v.as_str())))
            .ok_or_else(|| {
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
}

fn read_optional_yaml_lenient(path: &Path, parser: &dyn Transpiler) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let mut parsed = io::parsed(&bytes, "YAML", parser).ok()?;
    if let Ok(source) = std::str::from_utf8(&bytes) {
        preserve_numeric_catalog_scalars(&mut parsed, source);
    }
    Some(parsed)
}

fn preserve_numeric_catalog_scalars(value: &mut Value, source: &str) {
    if !has_numeric_catalog_entry(value) {
        return;
    }
    let raw_scalars = extract_yaml_catalog_scalars(source);
    if let Some(entries) = value["catalog"].as_object_mut() {
        stringify_numeric_entries(entries, None, &raw_scalars);
    }
    let Some(catalogs) = value["catalogs"].as_object_mut() else {
        return;
    };
    for (group, entries) in catalogs {
        if let Some(entries) = entries.as_object_mut() {
            stringify_numeric_entries(entries, Some(group.as_str()), &raw_scalars);
        }
    }
}

fn has_numeric_catalog_entry(value: &Value) -> bool {
    let default_has_num = value["catalog"]
        .as_object()
        .is_some_and(|entries| entries.values().any(Value::is_number));
    if default_has_num {
        return true;
    }
    value["catalogs"].as_object().is_some_and(|catalogs| {
        catalogs.values().any(|group| {
            group
                .as_object()
                .is_some_and(|entries| entries.values().any(Value::is_number))
        })
    })
}

fn stringify_numeric_entries(
    entries: &mut Map<String, Value>,
    group: Option<&str>,
    raw_scalars: &BTreeMap<(Option<String>, String), String>,
) {
    for (pkg, val) in entries.iter_mut() {
        let Some(number) = val.as_number() else {
            continue;
        };
        let key = (group.map(str::to_owned), pkg.clone());
        let text = raw_scalars
            .get(&key)
            .filter(|raw| numbers_match(raw, number))
            .cloned()
            .unwrap_or_else(|| number.to_string());
        *val = Value::String(text);
    }
}

fn numbers_match(raw: &str, number: &serde_json::Number) -> bool {
    let Ok(parsed_f64) = raw.parse::<f64>() else {
        return false;
    };
    number.as_f64().is_some_and(|n| parsed_f64 == n)
}

enum YamlSection {
    Other,
    Default,
    Named(Option<(usize, String)>),
}

fn extract_yaml_catalog_scalars(source: &str) -> BTreeMap<(Option<String>, String), String> {
    let mut out = BTreeMap::new();
    let mut section = YamlSection::Other;
    for raw_line in source.lines() {
        let line = raw_line.trim_end_matches('\r');
        let indent = line.len() - line.trim_start_matches(' ').len();
        let trimmed = line[indent..].trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = split_yaml_mapping(trimmed) else {
            continue;
        };
        let key = unquote_yaml_key(raw_key);
        let value = strip_yaml_comment(raw_value);
        if indent == 0 {
            section = enter_top_level_section(&key, value, &mut out);
            continue;
        }
        record_section_entry(&mut section, indent, key, value, &mut out);
    }
    out
}

fn enter_top_level_section(
    key: &str,
    value: &str,
    out: &mut BTreeMap<(Option<String>, String), String>,
) -> YamlSection {
    if key == "catalog" {
        if value.starts_with('{') && value.ends_with('}') {
            extract_flow_scalars(value, None, out);
            return YamlSection::Other;
        }
        return YamlSection::Default;
    }
    if key == "catalogs" {
        return YamlSection::Named(None);
    }
    YamlSection::Other
}

fn record_section_entry(
    section: &mut YamlSection,
    indent: usize,
    key: String,
    value: &str,
    out: &mut BTreeMap<(Option<String>, String), String>,
) {
    match section {
        YamlSection::Other => {}
        YamlSection::Default if !value.is_empty() => {
            out.insert((None, key), value.to_owned());
        }
        YamlSection::Default => {}
        YamlSection::Named(group) => record_named_entry(group, indent, key, value, out),
    }
}

fn record_named_entry(
    group: &mut Option<(usize, String)>,
    indent: usize,
    key: String,
    value: &str,
    out: &mut BTreeMap<(Option<String>, String), String>,
) {
    let starts_group = group
        .as_ref()
        .is_none_or(|(g_indent, _)| indent <= *g_indent);
    if starts_group {
        if value.starts_with('{') && value.ends_with('}') {
            extract_flow_scalars(value, Some(&key), out);
        }
        *group = Some((indent, key));
        return;
    }
    if let Some((_, group_name)) = group
        && !value.is_empty()
    {
        out.insert((Some(group_name.clone()), key), value.to_owned());
    }
}

fn extract_flow_scalars(
    flow: &str,
    group: Option<&str>,
    out: &mut BTreeMap<(Option<String>, String), String>,
) {
    let inner = flow.trim_start_matches('{').trim_end_matches('}');
    for entry in inner.split(',') {
        let Some((raw_key, raw_value)) = split_yaml_mapping(entry.trim()) else {
            continue;
        };
        let key = unquote_yaml_key(raw_key);
        let value = raw_value.trim();
        if !value.is_empty() {
            out.insert((group.map(str::to_owned), key), value.to_owned());
        }
    }
}

pub(super) fn split_yaml_mapping(line: &str) -> Option<(&str, &str)> {
    let mut quote = None;
    for (index, ch) in line.char_indices() {
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_some() {
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch == ':' && (line[index + 1..].is_empty() || line[index..].starts_with(": ")) {
            return Some((line[..index].trim(), line[index + 1..].trim()));
        }
    }
    None
}

fn unquote_yaml_key(raw: &str) -> String {
    if raw.len() >= 2
        && ((raw.starts_with('\'') && raw.ends_with('\''))
            || (raw.starts_with('"') && raw.ends_with('"')))
    {
        return raw[1..raw.len() - 1].to_owned();
    }
    raw.to_owned()
}

fn strip_yaml_comment(raw: &str) -> &str {
    if raw.starts_with('\'') || raw.starts_with('"') {
        return raw;
    }
    raw.split(" #").next().unwrap_or(raw).trim()
}

fn object_catalog_sources(source: &Value) -> (Option<&Value>, Option<&Value>) {
    let Some(object) = source.as_object() else {
        return (None, None);
    };
    let default = object.get("catalog").filter(|value| !value.is_null());
    let named = object.get("catalogs").filter(|value| !value.is_null());
    (default, named)
}

fn manifest_catalog_sources(manifest: &Value) -> (Option<&Value>, Option<&Value>) {
    let Some(workspaces) = manifest.get("workspaces").filter(|value| !value.is_null()) else {
        return (None, None);
    };
    let nested = object_catalog_sources(workspaces);
    if nested.0.is_some() || nested.1.is_some() {
        return nested;
    }
    object_catalog_sources(manifest)
}

fn is_range_after_npm_protocol(target: &str) -> bool {
    if target.is_empty()
        || target.starts_with('@')
        || target.contains('@')
        || target.contains("://")
        || target.starts_with("file:")
        || target.starts_with("link:")
        || target.starts_with("workspace:")
        || is_protocol(target)
    {
        return false;
    }
    let bytes = target.as_bytes();
    bytes.iter().any(|b| b"^~><=*| ".contains(b))
        || bun_semver::Version::parse_exact(bun_semver::SlicedString::init(bytes, bytes)).is_some()
}

pub(super) fn without_npm_protocol(range: &str) -> &str {
    match range.strip_prefix("npm:") {
        Some(target) if is_range_after_npm_protocol(target) => target,
        _ => range,
    }
}

fn without_yarn_npm_protocol(range: &str) -> &str {
    match range.strip_prefix("npm:") {
        Some(rest) if !rest.is_empty() && !rest.starts_with('@') && !rest.contains('@') => rest,
        _ => range,
    }
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
        if is_protocol(range) {
            return Err(format!(
                "Catalog entry for \"{name}\" cannot reference another catalog"
            ));
        }
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

fn insert_missing_entries(
    target: &mut BTreeMap<String, String>,
    entries: &BTreeMap<String, String>,
) {
    for (pkg, specifier) in entries {
        target
            .entry(pkg.clone())
            .or_insert_with(|| specifier.clone());
    }
}

fn merge_owned_entries(target: &mut BTreeMap<String, String>, entries: BTreeMap<String, String>) {
    for (pkg, specifier) in entries {
        target.entry(pkg).or_insert(specifier);
    }
}
