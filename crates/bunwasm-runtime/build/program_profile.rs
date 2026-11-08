//! The producer profile, not an isolated target-feature flag, enables the group ABI.
pub fn configure() {
    println!("cargo:rustc-check-cfg=cfg(bun_wasm_shared_group)");
    println!("cargo:rerun-if-env-changed=BUN_WASM_PROGRAM_PROFILE");
    let profile = std::env::var("BUN_WASM_PROGRAM_PROFILE").ok();
    if profile.as_deref() != Some("shared-group") {
        return;
    }
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("wasi"),
        "shared-group targets WASI"
    );
    let features = std::env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    assert!(
        features.split(',').any(|feature| feature == "atomics"),
        "shared-group requires real wasm atomics"
    );
    println!("cargo:rustc-cfg=bun_wasm_shared_group");
}
