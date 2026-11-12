use bun_semver::{SlicedString, Version};
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

static PARSES: AtomicUsize = AtomicUsize::new(0);

fn record_parse() {
    PARSES.fetch_add(1, Ordering::Relaxed);
}

fn is_release(version: &str) -> bool {
    let bytes = version.as_bytes();
    Version::parse_exact(SlicedString::init(bytes, bytes))
        .is_some_and(|version| !version.tag.has_pre())
}

// The previous installer scan is an oracle for query reuse, including equal maxima.
fn original_select<'a>(versions: &'a Map<String, Value>, range: &str) -> Option<&'a str> {
    versions
        .keys()
        .filter(|version| selection::matches(version, range))
        .max_by(|a, b| {
            is_release(a)
                .cmp(&is_release(b))
                .then_with(|| selection::order(a, b))
        })
        .map(String::as_str)
}

fn compare(versions: &Map<String, Value>, range: &str) {
    PARSES.store(0, Ordering::Relaxed);
    let actual = selection::select(versions, range);
    assert_eq!(PARSES.load(Ordering::Relaxed), 1);
    PARSES.store(0, Ordering::Relaxed);
    assert_eq!(actual, original_select(versions, range), "range: {range}");
    let valid_keys = versions
        .keys()
        .filter(|key| {
            let bytes = key.as_bytes();
            Version::parse_exact(SlicedString::init(bytes, bytes)).is_some()
        })
        .count();
    assert_eq!(PARSES.load(Ordering::Relaxed), valid_keys);
    if let Some(selected) = actual {
        assert!(
            versions
                .keys()
                .any(|key| std::ptr::eq(key.as_str(), selected))
        );
    }
}

fn check_order(keys: &[&str]) {
    let versions = keys
        .iter()
        .map(|key| (key.to_string(), Value::Null))
        .collect();
    for range in [
        "1.0.0",
        "1.0.0+abc",
        "=v1.0.0",
        "^1.7.1",
        "^1.7.1 || ^2.0.0-alpha.4",
        "^2.0.0-alpha.4",
        "2.0.0-beta.2",
        "1.x",
        "~1.0",
        "1 - 2",
        "",
        "*",
        ">=1.0.0 <2.0.0",
        "latest",
        ">=1 && <2",
        "1.2.3.4",
        ">=999999999999999999999999999999",
        "1.0.0-averylongprerelease.1",
    ] {
        compare(&versions, range);
    }
}

fn varied_orders() {
    let mut keys = [
        "1.0.0",
        "1.0.0+abc",
        "1.0.0+def",
        "1.7.1",
        "1.11.3",
        "2.0.0-alpha.4",
        "2.0.0-beta.2",
        "invalid",
        "01.2.3",
        "v1.0.0",
        "1.0.0-averylongprerelease.1",
    ];
    for _ in 0..keys.len() {
        check_order(&keys);
        keys.reverse();
        check_order(&keys);
        keys.reverse();
        keys.rotate_left(1);
    }
    check_order(&[]);
    check_order(&["invalid", "1.2.3.4"]);
}

fn large_maps() {
    for count in [1, 64, 4096] {
        let versions = (0..count)
            .map(|i| (format!("1.{}.{}", i / 64, i % 64), Value::Null))
            .collect();
        check_map(&versions);
    }
}

fn check_map(versions: &Map<String, Value>) {
    for range in ["1.0.0", "^1.0.0", "^2.0.0-alpha.4", "latest", ">=1 && <2"] {
        compare(versions, range);
    }
}

fn main() {
    varied_orders();
    large_maps();
    let versions = serde_json::json!({"1.11.3": {}, "2.0.0-beta.2": {}});
    assert_eq!(
        selection::select(versions.as_object().unwrap(), "^1.7.1 || ^2.0.0-alpha.4"),
        Some("1.11.3")
    );
    assert_eq!(
        selection::select(versions.as_object().unwrap(), "^2.0.0-alpha.4"),
        Some("2.0.0-beta.2")
    );
    assert!(!selection::matches("invalid", "*"));
    assert!(!selection::matches("1.0.0", "latest"));
    assert!(!selection::matches("1.0.0", ">=1 && <2"));
}
