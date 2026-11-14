use std::cmp::Ordering;

use bun_semver::{SlicedString, Version, query};
use serde_json::{Map, Value};

pub fn matches(version: &str, range: &str) -> bool {
    let version_bytes = version.as_bytes();
    let range_bytes = range.as_bytes();
    let Some(version) = Version::parse_exact(SlicedString::init(version_bytes, version_bytes))
    else {
        return false;
    };
    let Ok(group) = query::parse(range_bytes, SlicedString::init(range_bytes, range_bytes)) else {
        return false;
    };
    if group.has_skipped() {
        return false;
    }
    match group.get_exact_version() {
        Some(exact) => version.eql(exact),
        None => group.satisfies(version, range_bytes, version_bytes),
    }
}

pub(crate) fn order(a: &str, b: &str) -> Ordering {
    let parse = |s: &[u8]| Version::parse_exact(SlicedString::init(s, s));
    match (parse(a.as_bytes()), parse(b.as_bytes())) {
        (Some(a_version), Some(b_version)) => {
            a_version.order_without_build(b_version, a.as_bytes(), b.as_bytes())
        }
        _ => a.cmp(b),
    }
}

pub(super) fn select<'a>(versions: &'a Map<String, Value>, range: &str) -> Option<&'a str> {
    let range_bytes = range.as_bytes();
    let group = query::parse(range_bytes, SlicedString::init(range_bytes, range_bytes)).ok()?;
    if group.has_skipped() {
        return None;
    }
    versions
        .keys()
        .filter_map(|text| {
            let bytes = text.as_bytes();
            let version = Version::parse_exact(SlicedString::init(bytes, bytes))?;
            let matches = match group.get_exact_version() {
                Some(exact) => version.eql(exact),
                None => group.satisfies(version, range_bytes, bytes),
            };
            matches.then_some((text.as_str(), version))
        })
        .max_by(|(a_text, a), (b_text, b)| {
            (!a.tag.has_pre())
                .cmp(&!b.tag.has_pre())
                .then_with(|| a.order_without_build(*b, a_text.as_bytes(), b_text.as_bytes()))
        })
        .map(|(text, _)| text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn selected(range: &str) -> Option<String> {
        let versions = json!({"1.7.1": {}, "1.11.3": {}, "2.0.0-alpha.4": {}, "2.0.0-beta.2": {}});
        select(versions.as_object().unwrap(), range).map(str::to_owned)
    }

    #[test]
    fn published_oxc_runtime_peer_range_prefers_the_stable_release() {
        assert_eq!(
            selected("^1.7.1 || ^2.0.0-alpha.4").as_deref(),
            Some("1.11.3")
        );
    }

    #[test]
    fn explicit_prerelease_range_still_selects_its_highest_match() {
        assert_eq!(selected("^2.0.0-alpha.4").as_deref(), Some("2.0.0-beta.2"));
        assert_eq!(selected("2.0.0-alpha.4").as_deref(), Some("2.0.0-alpha.4"));
    }

    #[test]
    fn ranges_without_prereleases_preserve_their_release_selection() {
        assert_eq!(selected("^1.7.1").as_deref(), Some("1.11.3"));
        assert_eq!(selected("1.7.1").as_deref(), Some("1.7.1"));
        assert_eq!(selected("^3").as_deref(), None);
    }

    #[test]
    fn semver_order_is_unchanged_for_non_install_consumers() {
        assert!(order("2.0.0-beta.2", "1.11.3").is_gt());
        assert!(matches("2.0.0-beta.2", "^1.7.1 || ^2.0.0-alpha.4"));
    }

    #[test]
    fn equivalent_build_versions_keep_the_last_registry_entry() {
        for names in [["1.2.3+first", "1.2.3+last"], ["1.2.3+last", "1.2.3+first"]] {
            let mut versions = Map::new();
            for name in names {
                versions.insert(name.into(), Value::Null);
            }
            versions.insert("invalid".into(), Value::Null);
            assert_eq!(select(&versions, "^1.0.0"), Some(names[1]));
        }
    }

    #[test]
    fn invalid_versions_and_ranges_do_not_match() {
        let versions = json!({"invalid": {}, "1.2": {}, "1.2.3": {}});
        let versions = versions.as_object().unwrap();
        assert_eq!(select(versions, "^1.0.0"), Some("1.2.3"));
        assert_eq!(select(versions, "latest"), None);
        assert_eq!(select(versions, "^1.0.0 invalid"), None);
    }
}
