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
    let mut ordinary = Vec::new();
    let mut compact = Vec::new();
    let mut table = String::from("pub static POLYFILLS: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = override_dir
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|p| p.exists())
            .unwrap_or_else(|| js_dir.join(name));
        println!("cargo:rerun-if-changed={}", path.display());
        let stem = Path::new(name).file_stem().unwrap().to_str().unwrap();
        assert!(
            stems.insert(stem),
            "duplicate runtime module {stem} (.js and .ts)"
        );
        let batch = if matches!(stem, "stack_trace" | "bun_builtins") {
            &mut compact
        } else {
            &mut ordinary
        };
        let path = if name.ends_with(".ts") {
            let destination = out.join("runtime-js").join(format!("{stem}.js"));
            batch.push((path, destination.clone()));
            destination
        } else {
            path
        };
        table.push_str(&format!(
            "    ({stem:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    fs::create_dir_all(out.join("runtime-js")).expect("create transpiled runtime directory");
    transpile_batch(&ordinary, &transpiler, false);
    transpile_batch(&compact, &transpiler, true);
    generate(
        &mut table,
        "bun_wrap",
        &manifest.join("../../scripts/generate-bun-wrap.ts"),
        &manifest.join("../../vendor/bun/src/runtime.js"),
        out,
    );
    generate(
        &mut table,
        "direct_stream",
        &manifest.join("../../scripts/generate-direct-stream.ts"),
        &manifest.join("../../web/src/native-direct-stream.ts"),
        out,
    );
    table.push_str("];\n");
    fs::write(out.join("polyfills.rs"), table).unwrap();
}

/// Adds runtime module `name`, written by a Node generator script from `input`.
fn generate(table: &mut String, name: &str, generator: &Path, input: &Path, out: &Path) {
    println!("cargo:rerun-if-changed={}", input.display());
    println!("cargo:rerun-if-changed={}", generator.display());
    let destination = out.join(format!("{name}.js"));
    eprintln!("runtime-js phase={name} source={}", input.display());
    let output = Command::new("node")
        .arg(generator)
        .arg(input)
        .arg(&destination)
        .output()
        .unwrap_or_else(|error| panic!("generate {name}: {error}"));
    assert!(
        output.status.success(),
        "runtime-js phase={name} status={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    table.push_str(&format!(
        "    ({name:?}, include_str!({:?})),\n",
        destination.display().to_string()
    ));
}

fn transpile_batch(files: &[(PathBuf, PathBuf)], script: &Path, compact: bool) {
    if files.is_empty() {
        return;
    }
    let runner = if compact { "bun" } else { "node" };
    let phase = if compact { "compact" } else { "strip" };
    let mut command = Command::new(runner);
    command.arg(script).arg("--batch");
    for (source, destination) in files {
        command.arg(source).arg(destination);
    }
    if compact {
        command.arg("--minify-whitespace");
    }
    eprintln!("runtime-js launch phase={phase} files={}", files.len());
    let output = command
        .stderr(std::process::Stdio::inherit())
        .output()
        .expect("runtime TypeScript requires Node.js 24+ and Bun on PATH");
    assert!(
        output.status.success(),
        "runtime-js phase={phase} status={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}
