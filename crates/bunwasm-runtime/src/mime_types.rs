//! Bun's interned MIME types: the list in `src/http_types/mime_type_list.txt` and the
//! canonical values `MimeType.rs` `by_name_static` gives some of them
//! (docs/bun-patches/blob-types-and-slicing.md). A Blob type found here is kept, or
//! canonicalized, and `slice()` inherits it; Bun lowercases any other type and does
//! not pass it on to a slice.

use std::collections::HashSet;
use std::sync::OnceLock;

const NAMES: &str = include_str!("../data/bun-mime-types.txt");

/// The value Bun keeps for `name` when it is in the interned list (an exact,
/// case-sensitive match), or `None`.
pub fn interned(name: &str) -> Option<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    let set = SET.get_or_init(|| NAMES.lines().filter(|line| !line.is_empty()).collect());
    let name: &'static str = set.get(name)?;
    Some(match name {
        "application/webassembly" => "application/wasm",
        "application/javascript" | "text/javascript" | "text/jsx" => {
            "text/javascript;charset=utf-8"
        }
        "application/json" => "application/json;charset=utf-8",
        "application/x-www-form-urlencoded" => "application/x-www-form-urlencoded;charset=UTF-8",
        "text/css" => "text/css;charset=utf-8",
        "text/html" => "text/html;charset=utf-8",
        "text/plain" => "text/plain;charset=utf-8",
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::interned;

    #[test]
    fn interned_types_match_buns_list_and_canonical_values() {
        assert_eq!(interned("text/plain"), Some("text/plain;charset=utf-8"));
        assert_eq!(
            interned("text/plain;charset=utf-8"),
            Some("text/plain;charset=utf-8")
        );
        assert_eq!(
            interned("text/plain; charset=utf-8"),
            Some("text/plain; charset=utf-8")
        );
        assert_eq!(interned("image/tiff"), Some("image/tiff"));
        assert_eq!(
            interned("application/x-www-form-urlencoded"),
            Some("application/x-www-form-urlencoded;charset=UTF-8")
        );
        assert_eq!(interned("TEXT/PLAIN"), None);
        assert_eq!(interned("application/x-not-a-registered-type"), None);
        assert_eq!(interned(""), None);
    }
}
