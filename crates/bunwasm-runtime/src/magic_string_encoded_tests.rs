use sha2::Digest as _;

fn magic_string_fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/magic-string")
        .join(name);
    let bytes = std::fs::read(path).unwrap();
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut text)
        .unwrap();
    text
}

#[test]
fn host_magic_string_exact_source_and_paths() {
    let original = magic_string_fixture("original.mjs.gz");
    let expected = magic_string_fixture("corrected.mjs.gz");
    let path = "/project/node_modules/magic-string/dist/magic-string.es.mjs";
    assert_eq!(magic_string_encoded::adapt(&original, path), expected);
    for unsupported in [
        "/project/magic-string.es.mjs",
        "/project/node_modules/other/dist/magic-string.es.mjs",
        "/project/node_modules/magic-string/dist/magic-string.cjs.js",
        "/project/node_modules/magic-string/dist/magic-string.es.mjs/extra",
    ] {
        assert!(matches!(
            magic_string_encoded::adapt(&original, unsupported),
            std::borrow::Cow::Borrowed(_)
        ));
    }
    for changed in [
        original.clone() + "\n",
        expected,
        original.replace("const", "let"),
    ] {
        assert!(matches!(
            magic_string_encoded::adapt(&changed, path),
            std::borrow::Cow::Borrowed(_)
        ));
    }
}

#[test]
fn host_magic_string_actual_loader_and_source_cache() {
    let fixture = TestModule::new("magic-string-loader");
    let directory = fixture.0.join("node_modules/magic-string/dist");
    std::fs::create_dir_all(&directory).unwrap();
    let file = directory.join("magic-string.es.mjs");
    let path = file.to_str().unwrap();
    let original = magic_string_fixture("original.mjs.gz");
    let expected = magic_string_fixture("corrected.mjs.gz");
    std::fs::write(&file, &original).unwrap();
    let state = State::new(
        Vec::new(),
        Box::new(crate::transpiler::PassthroughTranspiler),
    );
    let (actual, format) = state.load_source(path).unwrap();
    assert_eq!(actual.as_ref(), expected);
    assert_eq!(format, Format::Esm);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    assert!(Rc::ptr_eq(&actual, &state.load_source(path).unwrap().0));
    let emitted = directory.join("loaded.mjs");
    std::fs::write(&emitted, actual.as_bytes()).unwrap();
    let control = std::process::Command::new("bun")
        .args(["test", "scripts/magic-string-encoded.test.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("BUNWASM_MAGIC_STRING_LOADED", &emitted)
        .output()
        .unwrap();
    assert!(
        control.status.success(),
        "{}",
        String::from_utf8_lossy(&control.stderr)
    );
    let changed = original.clone() + "\n";
    std::fs::write(&file, &changed).unwrap();
    assert_eq!(state.load_source(path).unwrap().0.as_ref(), changed);
    std::fs::write(&file, &original).unwrap();
    assert_eq!(state.load_source(path).unwrap().0.as_ref(), expected);
}

struct MagicStringHotTranspiler;

impl crate::Transpiler for MagicStringHotTranspiler {
    fn transpile(&self, source: &str, _: &str, _: SourceLoader) -> Result<String, String> {
        Ok(source.to_owned())
    }

    fn register(&self, source: &str, _: &str) -> Result<crate::Transpiled, crate::RecordError> {
        Ok(crate::Transpiled {
            code: source.to_owned(),
            ..Default::default()
        })
    }
}

#[test]
fn host_magic_string_actual_hot_preparation() {
    use crate::data::Val;
    let fixture = TestModule::new("magic-string-hot");
    let file = fixture
        .0
        .join("node_modules/magic-string/dist/magic-string.es.mjs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let original = magic_string_fixture("original.mjs.gz");
    let expected = magic_string_fixture("corrected.mjs.gz");
    std::fs::write(&file, &original).unwrap();
    let path = file.to_str().unwrap();
    let state = State::new(Vec::new(), Box::new(MagicStringHotTranspiler));
    let Val::Object(fields) = state.prepare_hot(1, path).unwrap() else {
        panic!("missing snapshot")
    };
    let get = |name: &str| &fields.iter().find(|(key, _)| key == name).unwrap().1;
    assert_eq!(get("kind"), &Val::Str("esm".into()));
    assert_eq!(get("code"), &Val::Str(esm_prologue(&expected) + &expected));
    assert_eq!(
        get("digest"),
        &Val::Str(format!("{:x}", sha2::Sha256::digest(original.as_bytes())))
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), original);
}
