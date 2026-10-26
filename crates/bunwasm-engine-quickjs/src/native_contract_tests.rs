use std::fs;
use std::path::{Path, PathBuf};

fn produced_quickjs_out(root: &Path) -> PathBuf {
    let source = fs::read(root.join("third_party/rquickjs-sys/quickjs/quickjs.c")).unwrap();
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let profile = executable
        .ancestors()
        .find(|path| matches!(path.file_name().and_then(|name| name.to_str()), Some("debug" | "release")))
        .expect("QuickJS test executable has a Cargo profile directory");
    let build = profile.join("build").join("rquickjs-sys");
    let mut candidates = fs::read_dir(build)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("out"))
        .filter(|path| path.join("libquickjs.a").is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
        .into_iter()
        .find(|path| fs::read(path.join("quickjs.c")).is_ok_and(|produced| produced == source))
        .expect("QuickJS library produced from the current source")
}

#[test]
fn async_context_native_contracts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let produced = produced_quickjs_out(&root);
    let status = std::process::Command::new("node")
        .arg(root.join("scripts/check-quickjs-async-context.ts"))
        .current_dir(&root)
        .env("BUN_WASM_QUICKJS_OUT_DIR", produced)
        .status()
        .expect("run native QuickJS async-context contracts");
    assert!(status.success(), "native QuickJS async-context contracts");
}
