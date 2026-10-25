use std::collections::{BTreeMap, BTreeSet};

use bun_semver::{SlicedString, query};
use serde_json::{Value, json};

use super::{io::Result, resolve};

#[derive(Default)]
pub(super) struct Overrides {
    rules: Vec<Rule>,
    pub metadata: Value,
    pub changed: BTreeSet<String>,
}

struct Rule {
    name: String,
    selector: Option<Selector>,
    replacement: String,
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum Selector {
    Range(String),
    Alias { name: String, range: String },
}

impl Selector {
    fn new(range: String) -> Option<Self> {
        if let Some(alias) = range.strip_prefix("npm:") {
            let (name, range) = resolve::spec(alias).ok()?;
            parsed(&range)?;
            return Some(Self::Alias { name, range });
        }
        parsed(&range)?;
        Some(Self::Range(range))
    }

    fn matches(&self, declared: &str) -> bool {
        match self {
            Self::Range(range) => !declared.starts_with("npm:") && intersects(range, declared),
            Self::Alias { name, range } => declared
                .strip_prefix("npm:")
                .and_then(|alias| resolve::spec(alias).ok())
                .is_some_and(|(target, requested)| {
                    *name == target && intersects(range, &requested)
                }),
        }
    }
}

impl Overrides {
    pub fn new(manifest: &Value, locked: &Value) -> Result<Self> {
        let mut result = Self {
            metadata: json!({}),
            ..Self::default()
        };
        for (key, value) in manifest["overrides"].as_object().into_iter().flatten() {
            result.insert(key, value)?;
        }
        result.rules.sort_by(|a, b| a.selector.cmp(&b.selector));
        result.changed = changed_names(&locked["overrides"], &result.metadata);
        Ok(result)
    }

    fn insert(&mut self, key: &str, value: &Value) -> Result<()> {
        if key.starts_with("//") {
            return Ok(());
        }
        let Some(replacement) = value.as_str() else {
            return Err("Only root string overrides are supported".into());
        };
        let Ok((name, range)) = resolve::spec(key) else {
            eprintln!("warn: Invalid root override selector");
            return Ok(());
        };
        if replacement.is_empty() {
            eprintln!("warn: Missing root override value");
            return Ok(());
        }
        let selector = if key[name.len()..].starts_with('@') {
            let Some(selector) = Selector::new(range) else {
                eprintln!("warn: Invalid root override selector");
                return Ok(());
            };
            Some(selector)
        } else {
            None
        };
        self.metadata[key] = if selector.is_some() {
            json!({".": replacement})
        } else {
            replacement.into()
        };
        self.rules.push(Rule {
            name,
            selector,
            replacement: replacement.into(),
        });
        Ok(())
    }

    pub fn target<'a>(&'a self, name: &str, range: &'a str) -> &'a str {
        self.replacement(name, range).unwrap_or(range)
    }

    pub fn replacement(&self, name: &str, range: &str) -> Option<&str> {
        self.rules
            .iter()
            .filter(|rule| rule.name == name)
            .find(|rule| {
                rule.selector
                    .as_ref()
                    .is_some_and(|selector| selector.matches(range))
            })
            .or_else(|| {
                self.rules.iter().find(|rule| {
                    rule.name == name && rule.selector.is_none() && !range.starts_with("npm:")
                })
            })
            .map(|rule| rule.replacement.as_str())
    }
}

fn parsed(range: &str) -> Option<query::Group> {
    let bytes = range.as_bytes();
    let group = query::parse(bytes, SlicedString::init(bytes, bytes)).ok()?;
    (!group.has_skipped()).then_some(group)
}

fn intersects(selector: &str, range: &str) -> bool {
    let (Some(selector_group), Some(range_group)) = (parsed(selector), parsed(range)) else {
        return false;
    };
    selector_group.intersects(selector.as_bytes(), &range_group, range.as_bytes())
}

fn by_name(metadata: &Value) -> BTreeMap<String, BTreeMap<String, Value>> {
    let mut grouped = BTreeMap::<String, BTreeMap<String, Value>>::new();
    let Some(entries) = metadata.as_object() else {
        return grouped;
    };
    for (key, value) in entries {
        let Ok((name, _)) = resolve::spec(key) else {
            continue;
        };
        grouped
            .entry(name)
            .or_default()
            .insert(key.clone(), value.clone());
    }
    grouped
}

fn changed_names(previous: &Value, current: &Value) -> BTreeSet<String> {
    let previous = by_name(previous);
    let current = by_name(current);
    previous
        .keys()
        .chain(current.keys())
        .filter(|name| previous.get(*name) != current.get(*name))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_intersection_uses_buns_parser() {
        for selector in ["^1", "1.0.0 || ^3", ">=0.9 <1.1"] {
            assert!(intersects(selector, "<2.0.0"), "{selector}");
        }
        for selector in [
            "^3",
            "^99999999999999999999",
            "^1 || ^99999999999999999999",
            "^1 && <2",
            "1.2.3.4",
            "latest",
        ] {
            assert!(!intersects(selector, "<2.0.0"), "{selector}");
        }
    }

    #[test]
    fn scoped_names_and_specific_rules_take_precedence() {
        let overrides = Overrides::new(
            &json!({"overrides": {
                "@scope/pkg": "2.0.0",
                "@scope/pkg@^1": "0.5.0",
                "@scope/pkg@>=1": "0.6.0"
            }}),
            &json!({}),
        )
        .unwrap();
        assert_eq!(overrides.target("@scope/pkg", "<2"), "0.6.0");
        assert_eq!(overrides.target("@scope/pkg", "^0.1"), "2.0.0");
        assert_eq!(
            overrides.target("@scope/pkg", "npm:other@^1"),
            "npm:other@^1"
        );
        assert_eq!(overrides.target("untouched", "^1"), "^1");
    }

    #[test]
    fn changed_names_cover_add_remove_and_metadata_only_changes() {
        let previous = json!({"overrides": {"a": "1.0.0", "b@^1": {".": "1.0.0"}}});
        let current = json!({"overrides": {"a@^1": "1.0.0", "b@^1": "1.0.0", "c": "2.0.0"}});
        let overrides = Overrides::new(&current, &previous).unwrap();
        assert_eq!(overrides.changed, BTreeSet::from(["a".into(), "c".into()]));
        let removed = Overrides::new(&json!({}), &previous).unwrap();
        assert_eq!(removed.changed, BTreeSet::from(["a".into(), "b".into()]));
    }

    #[test]
    fn unsupported_nested_objects_are_explicit() {
        let result = Overrides::new(&json!({"overrides": {"a": {"b": "1.0.0"}}}), &json!({}));
        assert!(result.err().unwrap().contains("Only root string overrides"));
    }
}

#[cfg(test)]
mod alias_tests {
    use super::*;

    #[test]
    fn alias_selectors_require_the_declared_target_and_a_valid_intersection() {
        let overrides = Overrides::new(
            &json!({"overrides": {
                "alias": "2.0.0",
                "alias@npm:@fixture/selected@^1": "0.5.0",
                "alias@npm:@fixture/selected@>=1": "0.6.0"
            }}),
            &json!({}),
        )
        .unwrap();
        assert_eq!(
            overrides.target("alias", "npm:@fixture/selected@<2"),
            "0.6.0"
        );
        assert_eq!(overrides.target("alias", "npm:other@^1"), "npm:other@^1");
        assert_eq!(
            overrides.target("alias", "npm:@fixture/selected@^2"),
            "0.6.0"
        );
        assert_eq!(overrides.target("alias", "^1"), "2.0.0");
        for range in ["latest", "^99999999999999999999", "^1 && <2", "1.2.3.4"] {
            let declared = format!("npm:@fixture/selected@{range}");
            assert_eq!(overrides.target("alias", &declared), declared);
            let invalid = Overrides::new(
                &json!({"overrides": {format!("alias@npm:@fixture/selected@{range}"): "0.5.0"}}),
                &json!({}),
            )
            .unwrap();
            assert_eq!(
                invalid.target("alias", "npm:@fixture/selected@<2"),
                "npm:@fixture/selected@<2"
            );
        }
    }
}
