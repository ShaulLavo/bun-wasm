use super::*;

fn prepare(source: &str, path: &str) -> (Transpiled, Vec<String>) {
    let mut requests = Vec::new();
    let output = prepare_module(source, path, Loader::Js, true, true, &mut |specifier| {
        requests.push(specifier.to_owned());
        "bunwasm:request:0".to_owned()
    })
    .unwrap();
    (output, requests)
}

#[test]
fn runtime_static_text_requests_include_direct_reexports() {
    for statement in [
        "import page from './page.html' with { type: 'text' }; console.log(page);",
        "export { default as page } from './page.html' with { type: 'text' };",
        "export * as page from './page.html' with { type: 'text' };",
    ] {
        let (out, requests) = prepare(statement, "importer.mjs");
        assert_eq!(requests, ["./page.html"], "{statement}");
        assert!(!out.preserved);
        assert!(out.code.contains("bunwasm:request:0"), "{}", out.code);
        assert!(!out.code.contains("with {"));
        assert!(!out.mappings.is_empty());
        let span = out
            .imports
            .iter()
            .find(|import| import.specifier.is_some())
            .unwrap();
        assert!(out.code[span.start..span.end].contains("bunwasm:request:0"));
    }
}

#[test]
fn runtime_dynamic_options_roundtrip_in_preserved_extensions() {
    for path in ["importer.js", "importer.mjs", "importer.cjs"] {
        for args in [
            "'./page.html', { with: { type: 'text' } }",
            "specifier(), options()",
        ] {
            let (out, requests) = prepare(&format!("void import({args});"), path);
            assert!(requests.is_empty());
            assert!(!out.preserved);
            assert!(
                out.code.contains("options()") || out.code.contains("type:"),
                "{}",
                out.code
            );
            assert!(out.code.contains("__bunwasm_dynamicImport"), "{}", out.code);
            assert!(!out.mappings.is_empty());
        }
    }
    let (out, _) = prepare("console.log('unchanged');", "ordinary.mjs");
    assert!(out.preserved);
}

#[test]
fn runtime_lowering_keeps_default_requests_and_static_grammar_errors() {
    let source = "import ordinary from './page.html'; import page from './page.html' with { type: 'text' }; console.log(ordinary, page);";
    let (out, requests) = prepare(source, "mixed.mjs");
    assert_eq!(requests, ["./page.html"]);
    let record = register(&out.code, "mixed.mjs", Loader::Js).unwrap();
    assert!(record.code.contains("./page.html"));
    assert!(record.code.contains("bunwasm:request:0"));
    let bad = "import page from './page.html' with { type: 1 };";
    assert!(
        prepare_module(bad, "invalid.mjs", Loader::Js, true, true, &mut |_| {
            "unused".to_owned()
        })
        .is_err()
    );
}
