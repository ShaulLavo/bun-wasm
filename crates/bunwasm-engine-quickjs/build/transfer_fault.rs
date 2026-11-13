//! Whether this compilation is a validation side (`src/transfer_fault.rs`). The build script
//! decides with this function, and the crate's tests run it too.

/// `value` is `BUN_WASM_TRANSFER_FAULT` as the compiler's environment has it. Only
/// `scripts/build-engine-quickjs.sh` sets it, and only to `1`, when it is asked for a
/// validation side and so writes no receipt. Any other value is refused: nothing but that
/// producer may choose, and a value that merely looks like "off" must not pass for a choice.
pub fn selected(value: Option<&str>) -> Result<bool, String> {
    match value {
        None => Ok(false),
        Some("1") => Ok(true),
        Some(other) => Err(format!(
            "BUN_WASM_TRANSFER_FAULT={other:?} is not accepted: unset it. \
             scripts/build-engine-quickjs.sh sets it for QUICKJS_TRANSFER_FAULT=1"
        )),
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
