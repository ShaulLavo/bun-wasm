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
    versions
        .keys()
        .filter(|version| matches(version, range))
        .max_by(|a, b| is_release(a).cmp(&is_release(b)).then_with(|| order(a, b)))
        .map(String::as_str)
}

fn is_release(version: &str) -> bool {
    let bytes = version.as_bytes();
    Version::parse_exact(SlicedString::init(bytes, bytes))
        .is_some_and(|version| !version.tag.has_pre())
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
}
