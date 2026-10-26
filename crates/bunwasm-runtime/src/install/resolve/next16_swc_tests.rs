use super::super::next_swc_tests::{
    assert_lock_round_trip, assert_matching_backend, assert_nested_backend,
    assert_optional_backend, fixture,
};
use super::super::*;

const BACKEND: &str = "@next/swc-wasm-nodejs";
const NATIVE: &str = "@next/swc-linux-x64-gnu";

#[test]
fn registry_and_old_lock_select_the_matching_wasm_backend() {
    assert_matching_backend("16.4.3");
}

#[test]
fn optional_next_keeps_the_backend_optional() {
    assert_optional_backend("16.4.3");
}

#[test]
fn a_different_root_backend_does_not_satisfy_next() {
    assert_nested_backend("16.4.3", "16.4.4");
}

#[test]
fn selected_backend_and_metadata_survive_a_lock_round_trip() {
    assert_lock_round_trip("16.4.3");
}

#[test]
fn missing_matching_backend_is_an_install_error_not_an_optional_success() {
    let (mut resolver, manifest) = fixture("16.4.3", false, false);
    resolver.packuments.get_mut(BACKEND).unwrap()["versions"] = json!({});
    let error = resolver.resolve(&manifest, false).err().unwrap();
    assert!(error.contains("16.4.3"), "{error}");
    assert!(error.contains(BACKEND), "{error}");
}

#[test]
fn requires_matching_native_metadata_and_preserves_explicit_backends() {
    let (resolver, _) = fixture("16.4.3", false, false);
    let original = &resolver.packuments["next"]["versions"]["16.4.3"];
    let mut mismatched = original.clone();
    mismatched["optionalDependencies"][NATIVE] = "16.4.4".into();
    assert_unchanged(mismatched);
    let mut missing = original.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("optionalDependencies");
    assert_unchanged(missing);
    for field in ["dependencies", "optionalDependencies"] {
        let mut declared = original.clone();
        declared[field][BACKEND] = "16.4.4".into();
        assert_unchanged(declared);
    }
}

fn assert_unchanged(mut metadata: Value) {
    let original = metadata.clone();
    super::adapt(&mut metadata);
    assert_eq!(metadata, original);
}
