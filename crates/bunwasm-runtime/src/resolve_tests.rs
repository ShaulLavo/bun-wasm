use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("bun-wasm-resolve-{}-{id}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, relative: &str) -> String {
        self.0.join(relative).to_str().unwrap().to_owned()
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn file(&self, relative: &str) {
        self.write(relative, "export default 'fixture';\n");
    }

    fn resolves(&self, spec: &str, from: &str, expected: &str) {
        for kind in [Kind::Import, Kind::Require] {
            assert_eq!(
                Resolver::new().resolve(spec, &self.path(from), kind),
                Ok(Resolved::File(self.path(expected))),
                "{kind:?} {spec} from {from}"
            );
        }
    }

    fn rejects(&self, spec: &str, from: &str) {
        for kind in [Kind::Import, Kind::Require] {
            let result = Resolver::new().resolve(spec, &self.path(from), kind);
            assert!(result.is_err(), "{kind:?} {spec} from {from}: {result:?}");
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn package_patterns_use_suffix_specificity_in_either_key_order() {
    for keys in [
        r#""./feature/*":"./general/*.js","./feature/*.js":"./specific/*.js""#,
        r#""./feature/*.js":"./specific/*.js","./feature/*":"./general/*.js""#,
    ] {
        let fixture = Fixture::new();
        fixture.write(
            "node_modules/pattern-pkg/package.json",
            &format!(r#"{{"exports":{{{keys}}}}}"#),
        );
        fixture.file("node_modules/pattern-pkg/general/item.js.js");
        fixture.file("node_modules/pattern-pkg/specific/item.js");
        fixture.resolves(
            "pattern-pkg/feature/item.js",
            "index.ts",
            "node_modules/pattern-pkg/specific/item.js",
        );
        fixture.write(
            "package.json",
            &format!(
                r##"{{"imports":{{{}}}}}"##,
                keys.replace("./feature/", "#feature/")
            ),
        );
        fixture.file("general/item.js.js");
        fixture.file("specific/item.js");
        fixture.resolves("#feature/item.js", "index.ts", "specific/item.js");
    }
}

#[test]
fn package_patterns_preserve_exact_prefix_and_selected_target_priority() {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/p/package.json",
        r#"{"exports":{
        "./feature/*":"./general/*.js",
        "./feature/*.js":"./suffix/*.js",
        "./feature/deep/*":"./prefix/*.js",
        "./feature/exact.js":"./exact.js",
        "./feature/missing.js":"./missing.js"
    }}"#,
    );
    for path in [
        "general/exact.js.js",
        "suffix/exact.js",
        "exact.js",
        "prefix/item.js.js",
        "suffix/deep/item.js",
        "suffix/missing.js",
    ] {
        fixture.file(&format!("node_modules/p/{path}"));
    }
    fixture.resolves("p/feature/exact.js", "index.ts", "node_modules/p/exact.js");
    fixture.resolves(
        "p/feature/deep/item.js",
        "index.ts",
        "node_modules/p/prefix/item.js.js",
    );
    fixture.rejects("p/feature/missing.js", "index.ts");
    fixture.rejects("p/feature/absent.js", "index.ts");
}

#[test]
fn package_patterns_do_not_fall_back_after_more_specific_missing_or_null_targets() {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/p/package.json",
        r#"{"exports":{
        "./feature/*":"./general/*.js",
        "./feature/*.js":"./missing/*.js",
        "./feature/*.json":null
    }}"#,
    );
    fixture.file("node_modules/p/general/item.js.js");
    fixture.file("node_modules/p/general/item.json.js");
    fixture.rejects("p/feature/item.js", "index.ts");
    fixture.rejects("p/feature/item.json", "index.ts");
}

#[test]
fn package_lookup_stops_at_selected_nearest_package() {
    for manifest in [
        r#"{"exports":{".":"./index.js"}}"#,
        r#"{"exports":{"./extra":"./missing.js"}}"#,
        r#"{"exports":{".":"./missing.js","./extra":"./missing.js"}}"#,
        r#"{"exports":{".":null,"./extra":null}}"#,
    ] {
        let fixture = Fixture::new();
        fixture.write("app/node_modules/p/package.json", manifest);
        fixture.write(
            "node_modules/p/package.json",
            r#"{"exports":{".":"./index.js","./extra":"./extra.js"}}"#,
        );
        fixture.file("node_modules/p/index.js");
        fixture.file("node_modules/p/extra.js");
        fixture.rejects("p", "app/index.ts");
        fixture.rejects("p/extra", "app/index.ts");
    }
}

#[test]
fn legacy_package_lookup_keeps_bun_ancestor_fallback() {
    for manifest in [r#"{"main":"./missing.js"}"#, r#"{}"#, r#"{"exports":null}"#] {
        let fixture = Fixture::new();
        fixture.write("app/node_modules/p/package.json", manifest);
        fixture.write(
            "node_modules/p/package.json",
            r#"{"exports":{".":"./index.js","./extra":"./extra.js"}}"#,
        );
        fixture.file("node_modules/p/index.js");
        fixture.file("node_modules/p/extra.js");
        fixture.resolves("p", "app/index.ts", "node_modules/p/index.js");
        fixture.resolves("p/extra", "app/index.ts", "node_modules/p/extra.js");
    }
}

#[test]
fn package_lookup_skips_absent_packages_and_selects_nearest_success() {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/@scope/p/package.json",
        r#"{"exports":{".":"./index.js","./extra":"./extra.js"}}"#,
    );
    fixture.file("node_modules/@scope/p/index.js");
    fixture.file("node_modules/@scope/p/extra.js");
    fixture.resolves("@scope/p", "app/index.ts", "node_modules/@scope/p/index.js");
    fixture.resolves(
        "@scope/p/extra",
        "app/index.ts",
        "node_modules/@scope/p/extra.js",
    );
    fixture.write(
        "app/node_modules/@scope/p/package.json",
        r#"{"exports":{".":"./index.js","./extra":"./extra.js"}}"#,
    );
    fixture.file("app/node_modules/@scope/p/index.js");
    fixture.file("app/node_modules/@scope/p/extra.js");
    fixture.resolves(
        "@scope/p",
        "app/index.ts",
        "app/node_modules/@scope/p/index.js",
    );
    fixture.resolves(
        "@scope/p/extra",
        "app/index.ts",
        "app/node_modules/@scope/p/extra.js",
    );
}

#[test]
fn package_self_reference_failure_is_terminal() {
    for exports in [
        r#"{".":"./index.js"}"#,
        r#"{".":"./missing.js","./extra":"./missing.js"}"#,
        r#"{"bun":null,"default":"./index.js"}"#,
    ] {
        let fixture = Fixture::new();
        fixture.write(
            "app/package.json",
            &format!(r#"{{"name":"self-pkg","exports":{exports}}}"#),
        );
        fixture.file("app/index.js");
        fixture.write(
            "app/node_modules/self-pkg/package.json",
            r#"{"exports":{".":"./index.js","./extra":"./extra.js"}}"#,
        );
        fixture.file("app/node_modules/self-pkg/index.js");
        fixture.file("app/node_modules/self-pkg/extra.js");
        fixture.rejects("self-pkg/extra", "app/consumer.ts");
    }
}

#[test]
fn package_self_reference_success_and_unselected_scope() {
    let fixture = Fixture::new();
    fixture.write(
        "app/package.json",
        r#"{"name":"self-pkg","exports":"./own.js"}"#,
    );
    fixture.file("app/own.js");
    fixture.write(
        "app/node_modules/other/package.json",
        r#"{"main":"./index.js"}"#,
    );
    fixture.file("app/node_modules/other/index.js");
    fixture.resolves("self-pkg", "app/nested/index.ts", "app/own.js");
    fixture.resolves(
        "other",
        "app/nested/index.ts",
        "app/node_modules/other/index.js",
    );
}

fn target_fixture(target: &str) -> Fixture {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/p/package.json",
        &format!(r#"{{"exports":{target}}}"#),
    );
    fixture.write(
        "package.json",
        &format!(r##"{{"imports":{{"#target":{target}}}}}"##),
    );
    fixture.file("node_modules/p/fallback.js");
    fixture.file("fallback.js");
    fixture
}

#[test]
fn selected_null_and_invalid_conditions_are_terminal() {
    for target in [
        r#"{"bun":null,"node":null,"default":"./fallback.js"}"#,
        r#"{"node":null,"default":"./fallback.js"}"#,
        r#"{"bun":{"node":null,"default":"./fallback.js"},"default":"./fallback.js"}"#,
        r#"{"bun":42,"default":"./fallback.js"}"#,
        r#"{"bun":false,"default":"./fallback.js"}"#,
        r#"{"bun":[],"default":"./fallback.js"}"#,
        r#"{"bun":[42,null],"default":"./fallback.js"}"#,
    ] {
        let fixture = target_fixture(target);
        fixture.rejects("p", "index.ts");
        fixture.rejects("#target", "index.ts");
    }
}

#[test]
fn unmatched_conditions_and_array_fallbacks_are_preserved() {
    for target in [
        r#"{"browser":null,"default":"./fallback.js"}"#,
        r#"{"bun":{"browser":null},"default":"./fallback.js"}"#,
        r#"{"default":"./fallback.js","bun":null}"#,
        r#"[null,"./fallback.js"]"#,
        r#"[42,"./fallback.js"]"#,
        r#"[true,"./fallback.js"]"#,
        r#"[{"bun":null},"./fallback.js"]"#,
        r#"{"bun":[{"browser":null}],"default":"./fallback.js"}"#,
    ] {
        let fixture = target_fixture(target);
        fixture.resolves("p", "index.ts", "node_modules/p/fallback.js");
        fixture.resolves("#target", "index.ts", "fallback.js");
    }
}

#[test]
fn array_fallback_does_not_retry_a_missing_selected_file() {
    let fixture = target_fixture(r#"["./missing.js","./fallback.js"]"#);
    fixture.rejects("p", "index.ts");
    fixture.rejects("#target", "index.ts");
}

#[test]
fn import_and_require_conditions_keep_manifest_order() {
    let fixture = target_fixture(
        r#"{"import":"./import.js","require":"./require.js","default":"./fallback.js"}"#,
    );
    for path in [
        "import.js",
        "require.js",
        "node_modules/p/import.js",
        "node_modules/p/require.js",
    ] {
        fixture.file(path);
    }
    for (kind, path) in [(Kind::Import, "import.js"), (Kind::Require, "require.js")] {
        assert_eq!(
            Resolver::new().resolve("p", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(
                fixture.path(&format!("node_modules/p/{path}"))
            ))
        );
        assert_eq!(
            Resolver::new().resolve("#target", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(fixture.path(path)))
        );
    }
}

#[test]
fn invalid_target_arrays_fall_back_but_conditions_do_not() {
    for target in [
        r#"["../outside.js","./fallback.js"]"#,
        r#"["./nested/../fallback.js","./fallback.js"]"#,
        r#"["./node_modules/hidden.js","./fallback.js"]"#,
    ] {
        let fixture = target_fixture(target);
        fixture.file("node_modules/outside.js");
        fixture.resolves("p", "index.ts", "node_modules/p/fallback.js");
        fixture.resolves("#target", "index.ts", "fallback.js");
    }
    for target in [
        r#"{"bun":"./nested/../fallback.js","default":"./fallback.js"}"#,
        r#"{"bun":"../outside.js","default":"./fallback.js"}"#,
    ] {
        let fixture = target_fixture(target);
        fixture.file("node_modules/outside.js");
        fixture.rejects("p", "index.ts");
        fixture.rejects("#target", "index.ts");
    }
}

#[test]
fn pattern_captures_flow_through_import_and_require_conditions() {
    let fixture = Fixture::new();
    let target = r#"{"bun":{"browser":null},"import":"./import-*.js","require":"./require-*.js"}"#;
    fixture.write(
        "node_modules/p/package.json",
        &format!(r#"{{"exports":{{"./feature/*":{target}}}}}"#),
    );
    fixture.write(
        "package.json",
        &format!(r##"{{"imports":{{"#feature/*":{target}}}}}"##),
    );
    for file in [
        "import-item.js",
        "require-item.js",
        "node_modules/p/import-item.js",
        "node_modules/p/require-item.js",
    ] {
        fixture.file(file);
    }
    for (kind, path) in [
        (Kind::Import, "import-item.js"),
        (Kind::Require, "require-item.js"),
    ] {
        assert_eq!(
            Resolver::new().resolve("p/feature/item", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(
                fixture.path(&format!("node_modules/p/{path}"))
            ))
        );
        assert_eq!(
            Resolver::new().resolve("#feature/item", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(fixture.path(path)))
        );
    }
}

#[test]
fn patterns_require_one_star_and_nonempty_captures() {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/p/package.json",
        r#"{"exports":{
        "./feature/*b*":"./wrong.js",
        "./feature/*":"./general/*.js",
        "./empty/*.js":"./empty/*.js"
    }}"#,
    );
    fixture.file("node_modules/p/wrong.js");
    fixture.file("node_modules/p/general/axb*.js");
    fixture.file("node_modules/p/empty/.js");
    fixture.resolves(
        "p/feature/axb*",
        "index.ts",
        "node_modules/p/general/axb*.js",
    );
    fixture.rejects("p/empty/.js", "index.ts");
}

#[test]
fn selected_self_reference_root_failure_does_not_load_a_shadow_package() {
    for target in [r#""./missing.js""#, r#"{"bun":null,"default":"./own.js"}"#] {
        let fixture = Fixture::new();
        fixture.write(
            "app/package.json",
            &format!(r#"{{"name":"self-pkg","exports":{target}}}"#),
        );
        fixture.file("app/own.js");
        fixture.write(
            "app/node_modules/self-pkg/package.json",
            r#"{"exports":"./index.js"}"#,
        );
        fixture.file("app/node_modules/self-pkg/index.js");
        fixture.rejects("self-pkg", "app/index.ts");
    }
}

#[test]
fn imports_can_still_select_external_packages_and_builtins() {
    let fixture = Fixture::new();
    fixture.write(
        "package.json",
        r##"{"imports":{"#dep":"dep","#builtin":"node:fs"}}"##,
    );
    fixture.write(
        "node_modules/dep/package.json",
        r#"{"exports":"./index.js"}"#,
    );
    fixture.file("node_modules/dep/index.js");
    fixture.resolves("#dep", "index.ts", "node_modules/dep/index.js");
    for kind in [Kind::Import, Kind::Require] {
        assert_eq!(
            Resolver::new().resolve("#builtin", &fixture.path("index.ts"), kind),
            Ok(Resolved::Builtin("node:fs".to_owned()))
        );
    }
}

#[test]
fn invalid_pattern_captures_are_terminal_before_array_fallback() {
    let fixture = Fixture::new();
    let target = r#"["./*.js","./fallback.js"]"#;
    fixture.write(
        "node_modules/p/package.json",
        &format!(r#"{{"exports":{{"./feature/*":{target}}}}}"#),
    );
    fixture.write(
        "package.json",
        &format!(r##"{{"imports":{{"#feature/*":{target}}}}}"##),
    );
    fixture.file("node_modules/p/fallback.js");
    fixture.file("fallback.js");
    fixture.rejects("p/feature/../outside", "index.ts");
    fixture.rejects("#feature/../outside", "index.ts");
}

#[test]
fn null_exports_field_does_not_activate_package_exports_or_self_reference() {
    let fixture = Fixture::new();
    fixture.write("app/package.json", r#"{"name":"p","exports":null}"#);
    fixture.write(
        "app/node_modules/p/package.json",
        r#"{"exports":null,"main":"./own.js"}"#,
    );
    fixture.file("app/node_modules/p/own.js");
    fixture.resolves("p", "app/consumer.ts", "app/node_modules/p/own.js");
}

#[test]
fn missing_package_keeps_one_malformed_manifest_diagnostic() {
    let fixture = Fixture::new();
    fixture.write("app/node_modules/p/package.json", r#"{"exports":"#);
    for kind in [Kind::Import, Kind::Require] {
        let resolver = Resolver::new();
        assert!(
            resolver
                .resolve("p", &fixture.path("app/index.ts"), kind)
                .is_err()
        );
        let notes = resolver.notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].file,
            fixture.path("app/node_modules/p/package.json")
        );
    }
}

#[test]
fn custom_conditions_precede_builtin_defaults_for_exports_and_imports() {
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/p/package.json",
        r#"{"exports":{"custom":"./custom.js","node":"./node.js","default":"./default.js"}}"#,
    );
    fixture.write(
        "package.json",
        r##"{"imports":{"#p":{"custom":"./custom.js","node":"./node.js","default":"./default.js"}}}"##,
    );
    for path in [
        "node_modules/p/custom.js",
        "node_modules/p/node.js",
        "node_modules/p/default.js",
        "custom.js",
        "node.js",
        "default.js",
    ] {
        fixture.file(path);
    }

    for kind in [Kind::Import, Kind::Require] {
        let resolver = Resolver::with_conditions(vec!["custom".to_owned()]);
        assert_eq!(
            resolver.resolve("p", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(fixture.path("node_modules/p/custom.js")))
        );
        assert_eq!(
            resolver.resolve("#p", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(fixture.path("custom.js")))
        );
    }

    for kind in [Kind::Import, Kind::Require] {
        assert_eq!(
            Resolver::new().resolve("p", &fixture.path("index.ts"), kind),
            Ok(Resolved::File(fixture.path("node_modules/p/node.js")))
        );
    }
}
