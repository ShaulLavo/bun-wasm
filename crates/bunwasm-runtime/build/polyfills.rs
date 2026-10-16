use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn embed(manifest: &Path, out: &Path) {
    let js_dir = manifest.join("src/js");
    println!("cargo:rerun-if-changed={}", js_dir.display());

    let mut names: Vec<String> = fs::read_dir(&js_dir)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".js") || (n.ends_with(".ts") && !n.ends_with(".d.ts")))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut stems = std::collections::HashSet::new();
    let transpiler = manifest.join("../../scripts/transpile-runtime.ts");
    println!("cargo:rerun-if-changed={}", transpiler.display());
    // Development aid: files in $BUNWASM_JS_OVERRIDE_DIR replace same-named
    // polyfills (handy to test a module without touching the tree).
    println!("cargo:rerun-if-env-changed=BUNWASM_JS_OVERRIDE_DIR");
    let override_dir = std::env::var_os("BUNWASM_JS_OVERRIDE_DIR").map(std::path::PathBuf::from);
    let mut table = String::from("pub static POLYFILLS: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = override_dir
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|p| p.exists())
            .unwrap_or_else(|| js_dir.join(name));
        println!("cargo:rerun-if-changed={}", path.display());
        let stem = Path::new(name).file_stem().unwrap().to_str().unwrap();
        assert!(stems.insert(stem), "duplicate runtime module {stem} (.js and .ts)");
        let path = if name.ends_with(".ts") {
            transpile(&path, out, stem, &transpiler)
        } else {
            path
        };
        table.push_str(&format!("    ({stem:?}, include_str!({:?})),\n", path.display().to_string()));
    }
    table.push_str("];\n");
    fs::write(out.join("polyfills.rs"), table).unwrap();

}

fn transpile(source: &Path, out: &Path, stem: &str, script: &Path) -> PathBuf {
    let dir = out.join("runtime-js");
    fs::create_dir_all(&dir).expect("create transpiled runtime directory");
    let destination = dir.join(format!("{stem}.js"));
    let output = Command::new("bun")
        .arg(script)
        .arg(source)
        .arg(&destination)
        .output()
        .expect("runtime TypeScript requires Bun on PATH (source env.sh)");
    assert!(output.status.success(), "transpile {}: {}", source.display(), String::from_utf8_lossy(&output.stderr));
    destination
}
