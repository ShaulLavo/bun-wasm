//! `bun init`, adapted from oven-sh/bun src/runtime/cli/init_command.rs (blank and minimal templates;
//! docs/bun-patches/bun-init-and-create.md). Writes the same files, then installs in-process.
use std::{fs, path::Path};

use serde_json::{Map, Value};

use crate::{BUN_VERSION, Transpiler};

const GITIGNORE: &[u8] =
    include_bytes!("../../../vendor/bun/src/runtime/cli/init/gitignore.default");
const TSCONFIG_JSON: &[u8] =
    include_bytes!("../../../vendor/bun/src/runtime/cli/init/tsconfig.default.json");
const README_MD: &str = include_str!("../../../vendor/bun/src/runtime/cli/init/README.default.md");

const HELP: &str = "Usage: bun init [flags] [<folder>]
  Initialize a Bun project in the current directory.
  Creates a package.json, tsconfig.json, and bunfig.toml if they don't exist.

Flags:
      --help             Print this menu
  -y, --yes              Accept all default options
  -m, --minimal          Only initialize type definitions

Examples:
  bun init
  bun init --yes
";
const ENTRY_POINTS: &[&str] = &[
    "index.mts",
    "index.tsx",
    "index.ts",
    "index.jsx",
    "index.mjs",
    "index.js",
    "src/index.mts",
    "src/index.tsx",
    "src/index.ts",
    "src/index.jsx",
    "src/index.mjs",
    "src/index.js",
];

struct Flags {
    minimal: bool,
    folder: Option<String>,
}

fn flags(args: Vec<String>) -> Result<Flags, i32> {
    let mut result = Flags {
        minimal: false,
        folder: None,
    };
    let mut parse_flags = true;
    for arg in args {
        if !parse_flags || !arg.starts_with('-') {
            result.folder.get_or_insert(arg);
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return Err(0);
            }
            "-m" | "--minimal" => result.minimal = true,
            "--" => parse_flags = false,
            // There is no terminal picker here: every run takes the default Blank template.
            "-y" | "--yes" => {}
            react if react.starts_with("--react") || react == "-r" => {
                eprintln!("error: bun init --react is not supported in bun-wasm yet");
                return Err(1);
            }
            _ => {}
        }
    }
    Ok(result)
}

fn normalize_package_name(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            ' ' | '"' | '\'' => '-',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

fn is_type_script(entry_point: &str) -> bool {
    !matches!(
        Path::new(entry_point).extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "cjs" | "jsx")
    )
}

fn is_safe_entry_point(path: &str) -> bool {
    !path.starts_with('/') && !path.split(['/', '\\']).any(|part| part == "..")
}

fn infer_entry_point() -> String {
    if let Some(found) = ENTRY_POINTS.iter().find(|path| Path::new(path).is_file()) {
        return (*found).to_owned();
    }
    let script_like = fs::read_dir(".")
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && matches!(
                    extension,
                    "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx"
                )
        });
    // A non-index source file might not be the main file; leave the field out.
    if script_like {
        String::new()
    } else {
        "index.ts".into()
    }
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn create(path: &str, contents: &[u8], suffix: &str) {
    if fs::write(path, contents).is_ok() {
        println!(" + {path}{suffix}");
    }
}

fn object<'a>(package: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !package.get(key).is_some_and(Value::is_object) {
        package.insert(key.into(), Value::Object(Map::new()));
    }
    package.get_mut(key).and_then(Value::as_object_mut).unwrap()
}

fn has_dependency(package: &Map<String, Value>, group: &str, name: &str) -> bool {
    package
        .get(group)
        .and_then(Value::as_object)
        .is_some_and(|deps| deps.contains_key(name))
}

/// Applies Bun's blank-template package.json fields. Returns whether an install is needed.
fn configure(
    package: &mut Map<String, Value>,
    name: &str,
    entry_point: &str,
    minimal: bool,
) -> bool {
    if !minimal {
        package.insert("name".into(), name.into());
        if !entry_point.is_empty() {
            let field = if package.contains_key("main") && !package.contains_key("module") {
                "main"
            } else {
                "module"
            };
            package.insert(field.into(), entry_point.into());
            if field == "module" {
                package.insert("type".into(), "module".into());
            }
        }
        package.insert("private".into(), true.into());
    }
    let needs_types = !has_dependency(package, "devDependencies", "@types/bun");
    let needs_typescript = !minimal
        && !has_dependency(package, "devDependencies", "typescript")
        && !has_dependency(package, "peerDependencies", "typescript");
    if !minimal && is_type_script(entry_point) {
        let scripts = object(package, "scripts");
        if !scripts.contains_key("typecheck") {
            let command = if scripts.contains_key("check") {
                "bun --check"
            } else {
                "bun check"
            };
            scripts.insert("typecheck".into(), command.into());
        }
    }
    if needs_types {
        object(package, "devDependencies").insert("@types/bun".into(), "latest".into());
    }
    if needs_typescript {
        object(package, "peerDependencies").insert("typescript".into(), "^7".into());
    }
    needs_types || needs_typescript
}

fn read_package() -> Option<Map<String, Value>> {
    let text = fs::read_to_string("package.json").ok()?;
    match serde_json::from_str(&text).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

pub fn run(args: Vec<String>, parser: &dyn Transpiler) -> i32 {
    let flags = match flags(args) {
        Ok(flags) => flags,
        Err(code) => return code,
    };
    if let Some(folder) = &flags.folder {
        if let Err(error) = fs::create_dir_all(folder) {
            eprintln!("Failed to create directory {folder}: {error}");
            return 1;
        }
        if let Err(error) = std::env::set_current_dir(folder) {
            eprintln!("Failed to change directory to {folder}: {error}");
            return 1;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let directory = cwd.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let loaded = read_package();
    let mut package = loaded.clone().unwrap_or_default();
    let mut name = match normalize_package_name(directory) {
        name if name.is_empty() => "project".to_owned(),
        name => name,
    };
    if let Some(existing) = package.get("name").and_then(Value::as_str) {
        name = existing.to_owned();
    }
    let mut entry_point = package
        .get("module")
        .or_else(|| package.get("main"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if entry_point.is_empty() && !flags.minimal {
        entry_point = infer_entry_point();
    }
    if loaded.is_some() {
        println!("note: package.json already exists, configuring existing project");
    }

    let write_gitignore = !flags.minimal && !exists(".gitignore");
    let write_readme = !flags.minimal
        && !["README.md", "README", "README.txt", "README.mdx"]
            .iter()
            .any(|path| exists(path));
    let write_tsconfig = !exists("tsconfig.json") && !exists("jsconfig.json");
    let needs_install = configure(&mut package, &name, &entry_point, flags.minimal);

    let mut json = serde_json::to_string_pretty(&Value::Object(package)).unwrap();
    json.push('\n');
    if let Err(error) = fs::write("package.json", json) {
        eprintln!("package.json failed to write due to error {error}");
    } else if loaded.is_none() {
        println!(" + package.json");
    }
    if write_gitignore {
        create(".gitignore", GITIGNORE, "");
    }
    if !entry_point.is_empty() && is_safe_entry_point(&entry_point) && !exists(&entry_point) {
        if let Some(parent) = Path::new(&entry_point).parent() {
            let _ = fs::create_dir_all(parent);
        }
        create(&entry_point, b"console.log(\"Hello via Bun!\");\n", "");
    }
    if write_tsconfig {
        let (file, purpose) = if is_type_script(&entry_point) {
            ("tsconfig.json", " (for bun check and editor autocomplete)")
        } else {
            ("jsconfig.json", " (for editor autocomplete)")
        };
        create(file, TSCONFIG_JSON, purpose);
    }
    if write_readme {
        let readme = README_MD
            .replace("{[name]s}", &name)
            .replace("{[bunVersion]s}", BUN_VERSION)
            .replace("{[entryPoint]s}", &entry_point);
        create("README.md", readme.as_bytes(), "");
    }
    if !entry_point.is_empty() && loaded.is_none() {
        let shown = if entry_point.contains([' ', '"', '\'']) {
            serde_json::to_string(&entry_point).unwrap()
        } else {
            entry_point.clone()
        };
        print!("\nTo get started, run:\n\n    bun run {shown}\n\n");
        if is_type_script(&entry_point) {
            print!("To type check, run:\n\n    bun check\n\n");
        }
    }
    if needs_install {
        println!();
        return crate::install::run("install", Vec::new(), parser);
    }
    0
}
