use std::borrow::Cow;

const IMPORT: &str = "await import((0, _url.pathToFileURL)(pkgPath).toString())";
const RESOLVED_IMPORT: &str = "await import((0, _url.pathToFileURL)(importPath ? pkgPath : require.resolve(pkgPath)).toString())";

pub(crate) fn adapt<'a>(source: &'a str, path: &str) -> Cow<'a, str> {
    if !path.ends_with("/node_modules/next/dist/build/swc/index.js")
        || !source.contains("async function loadWasmRawBindings(")
        || source.matches(IMPORT).count() != 1
    {
        return Cow::Borrowed(source);
    }
    Cow::Owned(source.replacen(IMPORT, RESOLVED_IMPORT, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/project/node_modules/next/dist/build/swc/index.js";

    fn source() -> String {
        format!("async function loadWasmRawBindings(importPath = '') {{\n{IMPORT};\n}}")
    }

    #[test]
    fn resolves_installed_packages_before_file_url_conversion() {
        let source = source();
        assert_eq!(
            adapt(&source, PATH),
            source.replace(IMPORT, RESOLVED_IMPORT)
        );
    }

    #[test]
    fn accepts_nested_package_installations() {
        let source = source();
        let path = "/project/node_modules/other/node_modules/next/dist/build/swc/index.js";
        assert_eq!(
            adapt(&source, path),
            source.replace(IMPORT, RESOLVED_IMPORT)
        );
    }

    #[test]
    fn leaves_other_files_unchanged() {
        let source = source();
        for path in [
            "/project/index.js",
            "/project/node_modules/not-next/dist/build/swc/index.js",
        ] {
            assert!(matches!(adapt(&source, path), Cow::Borrowed(_)));
        }
    }

    #[test]
    fn leaves_different_loader_shapes_unchanged() {
        for source in ["export {}", IMPORT] {
            assert!(matches!(adapt(source, PATH), Cow::Borrowed(_)));
        }
    }

    #[test]
    fn leaves_ambiguous_sources_unchanged() {
        let source = format!("{}\n{IMPORT}", source());
        assert!(matches!(adapt(&source, PATH), Cow::Borrowed(_)));
    }

    #[test]
    fn does_not_rewrite_an_already_adapted_loader() {
        let source = source();
        let adapted = adapt(&source, PATH);
        assert!(matches!(adapt(&adapted, PATH), Cow::Borrowed(_)));
    }
}
