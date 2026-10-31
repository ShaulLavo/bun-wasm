use std::borrow::Cow;

const EVAL_REQUIRE: &str = "eval(\"require\")";
const REQUIRE_VALUE: &str = "(0,require)    ";
const END: &str = "function end(){const main=eval(\"require\")(file);";
const EXEC: &str = "function execMethod(method,args){const main=eval(\"require\")(file);";
const PROCESS_WORKER: &str = "/node_modules/next/dist/compiled/jest-worker/processChild.js";
const THREAD_WORKER: &str = "/node_modules/next/dist/compiled/jest-worker/threadChild.js";

pub(crate) fn adapt<'a>(source: &'a str, filename: &str) -> Cow<'a, str> {
    if !filename.ends_with(PROCESS_WORKER) && !filename.ends_with(THREAD_WORKER) {
        return Cow::Borrowed(source);
    }
    if source.matches(END).count() != 1
        || source.matches(EXEC).count() != 1
        || source.matches(EVAL_REQUIRE).count() != 2
    {
        return Cow::Borrowed(source);
    }
    Cow::Owned(source.replace(EVAL_REQUIRE, REQUIRE_VALUE))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROCESS: &str =
        include_str!("../../../tests/hermes/fixtures/next-jest-worker/processChild.js");
    const THREAD: &str =
        include_str!("../../../tests/hermes/fixtures/next-jest-worker/threadChild.js");
    const DIRECTORY: &str = "/app/node_modules/next/dist/compiled/jest-worker/";

    #[test]
    fn lowers_both_real_worker_require_lookups_without_moving_positions() {
        for (file, source) in [("processChild.js", PROCESS), ("threadChild.js", THREAD)] {
            let adapted = adapt(source, &format!("{DIRECTORY}{file}"));
            assert_eq!(adapted, source.replace(EVAL_REQUIRE, REQUIRE_VALUE));
            assert_eq!(adapted.len(), source.len());
            assert_eq!(adapted.matches(EVAL_REQUIRE).count(), 0);
        }
    }

    #[test]
    fn accepts_nested_installations_and_commonjs_wrappers() {
        let source = format!(
            "(function(exports, require, module, __filename, __dirname) {{\n{PROCESS}\n}})"
        );
        let path =
            "/app/node_modules/tool/node_modules/next/dist/compiled/jest-worker/processChild.js";
        assert_eq!(
            adapt(&source, path),
            source.replace(EVAL_REQUIRE, REQUIRE_VALUE)
        );
    }

    #[test]
    fn leaves_unrelated_modules_borrowed() {
        for file in [
            "/app/processChild.js",
            "/app/node_modules/jest-worker/build/workers/processChild.js",
            "/app/node_modules/next/dist/compiled/jest-worker/notChild.js",
            "/app/notnode_modules/next/dist/compiled/jest-worker/processChild.js",
        ] {
            assert!(matches!(adapt(PROCESS, file), Cow::Borrowed(_)));
        }
    }

    #[test]
    fn leaves_different_worker_source_borrowed() {
        let file = format!("{DIRECTORY}processChild.js");
        for source in ["eval(\"require\")", END, EXEC] {
            assert!(matches!(adapt(source, &file), Cow::Borrowed(_)));
        }
        let source = PROCESS.replace(
            EXEC,
            "function different(method,args){const main=eval(\"require\")(file);",
        );
        assert!(matches!(adapt(&source, &file), Cow::Borrowed(_)));
    }

    #[test]
    fn leaves_ambiguous_sources_borrowed() {
        let source = format!("{PROCESS};eval(\"require\")");
        assert!(matches!(
            adapt(&source, &format!("{DIRECTORY}processChild.js")),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn leaves_an_adapted_worker_borrowed() {
        let source = PROCESS.replace(EVAL_REQUIRE, REQUIRE_VALUE);
        assert!(matches!(
            adapt(&source, &format!("{DIRECTORY}processChild.js")),
            Cow::Borrowed(_)
        ));
    }
}
