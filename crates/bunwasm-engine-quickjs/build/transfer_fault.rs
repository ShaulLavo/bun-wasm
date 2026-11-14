//! Whether this compilation is a validation side (`src/transfer_fault.rs`). The build scripts of
//! the three engine crates and of the SpiderMonkey adapter decide with this file, and the
//! QuickJS engine crate's tests run its decision too.

/// `value` is `BUN_WASM_TRANSFER_FAULT` as the compiler's environment has it. Only a side's
/// producer sets it (`scripts/src/transfer-fault.sh`), and only to `1`, when it is asked for a
/// validation side and so writes no receipt. Any other value is refused: nothing but the
/// producer may choose, and a value that merely looks like "off" must not pass for a choice.
pub fn selected(value: Option<&str>) -> Result<bool, String> {
    match value {
        None => Ok(false),
        Some("1") => Ok(true),
        Some(other) => Err(format!(
            "BUN_WASM_TRANSFER_FAULT={other:?} is not accepted: unset it. \
             A side's producer sets it for its own transfer-fault option"
        )),
    }
}

/// For a build script: reads the variable, tells cargo about it and about the cfg, sets the cfg
/// for a validation side, and fails the build on a value [`selected`] refuses.
#[allow(dead_code)]
pub fn configure() -> bool {
    println!("cargo:rustc-check-cfg=cfg(bun_wasm_transfer_fault)");
    println!("cargo:rerun-if-env-changed=BUN_WASM_TRANSFER_FAULT");
    let ambient = std::env::var_os("BUN_WASM_TRANSFER_FAULT");
    let value = ambient
        .as_ref()
        .map(|value| value.to_str().unwrap_or("not UTF-8"));
    match selected(value) {
        Ok(true) => {
            println!("cargo:rustc-cfg=bun_wasm_transfer_fault");
            true
        }
        Ok(false) => false,
        Err(refusal) => panic!("{refusal}"),
    }
}

#[cfg(test)]
mod tests {
    use super::selected;

    #[test]
    fn only_the_producers_own_value_selects_a_validation_side() {
        assert_eq!(selected(None), Ok(false));
        assert_eq!(selected(Some("1")), Ok(true));
        // Present is not selected: each of these used to compile the validation module.
        for value in ["0", "", "true", "false", "yes", "2", " 1", "1 "] {
            assert!(selected(Some(value)).is_err(), "{value:?}");
        }
    }
}
