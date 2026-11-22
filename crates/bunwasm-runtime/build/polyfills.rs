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
    // Debugging aid: keep every token at its source line and column (types erased only).
    println!("cargo:rerun-if-env-changed=BUNWASM_JS_PRESERVE_POSITIONS");
    let compact_enabled = std::env::var_os("BUNWASM_JS_PRESERVE_POSITIONS").is_none();
    fs::create_dir_all(out.join("runtime-strip")).expect("create runtime strip directory");
    fs::create_dir_all(out.join("runtime-js")).expect("create transpiled runtime directory");
    let mut strip = Vec::new();
    let mut compact = Vec::new();
    // (module name, path of the plain JavaScript the table embeds)
    let mut modules: Vec<(String, PathBuf)> = Vec::new();
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
        let path = if name.ends_with(".ts") {
            let destination = out.join("runtime-strip").join(format!("{stem}.js"));
            strip.push((path, destination.clone()));
            destination
        } else {
            path
        };
        modules.push((stem.to_owned(), path));
    }
    transpile_batch(&strip, &transpiler, false);
    let mut table = String::from("pub static POLYFILLS: &[(&str, &str)] = &[\n");
    for (stem, path) in modules {
        let path = if compact_enabled && !matches!(stem.as_str(), "intl" | "tz_data") {
            let destination = out.join("runtime-js").join(format!("{stem}.js"));
            compact.push((path, destination.clone()));
            destination
        } else {
            path
        };
        table.push_str(&format!(
            "    ({stem:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    let generated = [
        (
            "bun_wrap",
            "generate-bun-wrap.ts",
            manifest.join("../../vendor/bun/src/runtime.js"),
        ),
        (
            "direct_stream",
            "generate-direct-stream.ts",
            manifest.join("../../web/src/native-direct-stream.ts"),
        ),
        (
            "dev_html_client",
            "generate-dev-html-client.ts",
            manifest.join("../../web/src/dev-html-client.ts"),
        ),
    ];
    for (name, generator, input) in generated {
        let source = generate(name, &manifest.join("../../scripts").join(generator), &input, out);
        let path = if compact_enabled {
            let destination = out.join("runtime-js").join(format!("{name}.js"));
            compact.push((source, destination.clone()));
            destination
        } else {
            source
        };
        table.push_str(&format!(
            "    ({name:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    transpile_batch(&compact, &transpiler, true);
    table.push_str("];\n");
    fs::write(out.join("polyfills.rs"), table).unwrap();
}

/// Writes runtime module `name` with a source generator script from `input`; returns its path.
fn generate(name: &str, generator: &Path, input: &Path, out: &Path) -> PathBuf {
    println!("cargo:rerun-if-changed={}", input.display());
    println!("cargo:rerun-if-changed={}", generator.display());
    let destination = out.join(format!("{name}.js"));
    eprintln!("runtime-js phase={name} source={}", input.display());
    let runner = if name == "dev_html_client" {
        "bun"
    } else {
        "node"
    };
    let output = Command::new(runner)
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
    destination
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
