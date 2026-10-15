//! Hoisted npm installs over the optional fetch ABI. No JS engine or OS processes.
mod io;
mod resolve;

use std::{collections::BTreeSet, fs, path::Path, time::Instant};

use serde_json::{Value, json};

use crate::{BUN_REVISION, BUN_VERSION, Transpiler};
use io::Result;
use resolve::{Package, Resolver};

#[derive(Default)]
struct Options {
    names: Vec<String>,
    dev: bool,
    exact: bool,
    production: bool,
    frozen: bool,
    refresh: bool,
    registry: Option<String>,
}

pub fn run(command: &str, args: Vec<String>, parser: &dyn Transpiler) -> i32 {
    match execute(command, args, parser) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error}");
            1
        }
    }
}

fn options(args: Vec<String>) -> Result<Options> {
    let mut opts = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-d" | "-D" | "--dev" | "--development" => opts.dev = true,
            "-E" | "--exact" => opts.exact = true,
            "--production" | "-p" => opts.production = true,
            "--frozen-lockfile" => opts.frozen = true,
            "--no-cache" | "--force" => opts.refresh = true,
            "--ignore-scripts" | "--save-text-lockfile" => {}
            "--cwd" => std::env::set_current_dir(args.next().ok_or("--cwd requires a directory")?)
                .map_err(|e| e.to_string())?,
            "--registry" => opts.registry = Some(args.next().ok_or("--registry requires a URL")?),
            "--linker" => {
                if args.next().as_deref() != Some("hoisted") {
                    return Err("Only --linker hoisted is supported in bun-wasm".into());
                }
            }
            flag if flag.starts_with("--registry=") => opts.registry = Some(flag[11..].into()),
            flag if flag.starts_with('-') => return Err(format!("Unknown install option: {flag}")),
            _ => opts.names.push(arg),
        }
    }
    Ok(opts)
}

fn execute(command: &str, args: Vec<String>, parser: &dyn Transpiler) -> Result<()> {
    let start = Instant::now();
    let mut opts = options(args)?;
    if command == "ci" {
        opts.frozen = true;
    }
    if command == "pm" {
        return pm(&opts, parser);
    }
    let command = match command {
        "add" | "a" => "add",
        "remove" | "rm" | "r" | "uninstall" => "remove",
        _ => "install",
    };
    if matches!(command, "add" | "remove") && opts.names.is_empty() {
        return Err(format!("bun {command} requires a package name"));
    }
    println!(
        "bun {command} v{BUN_VERSION} ({})\n",
        &BUN_REVISION[..9.min(BUN_REVISION.len())]
    );
    let mut manifest = manifest(command, parser)?;
    if manifest.get("workspaces").is_some() {
        return Err("Workspace installs are not supported in bun-wasm yet".into());
    }
    let old_manifest = manifest.clone();
    if command == "remove" {
        remove_names(&mut manifest, &opts.names)?;
    }
    if command == "add" || command == "install" && !opts.names.is_empty() {
        add_names(&mut manifest, &opts)?;
    }
    let registry = registry(&opts, parser)?;
    let locked = if Path::new("bun.lock").exists() {
        io::read(Path::new("bun.lock"), "JSONC", parser)?
    } else {
        json!({})
    };
    let mut resolver = Resolver::new(registry, locked.clone(), opts.refresh);
    resolver.resolve(&manifest, opts.production)?;
    if command != "remove" {
        finalize_additions(&mut manifest, &opts, &resolver)?;
    }
    let lock = lockfile(&manifest, &resolver);
    if opts.frozen && !same_lock(&locked, &lock, parser, opts.production)? {
        return Err("lockfile had changes, but lockfile is frozen".into());
    }
    let installed = install_packages(&mut resolver)?;
    prune(&locked, &resolver)?;
    if manifest != old_manifest {
        io::write(
            Path::new("package.json"),
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()).as_bytes(),
        )?;
    }
    if !opts.production && fs::read_to_string("bun.lock").ok().as_deref() != Some(lock.as_str()) {
        io::write(Path::new("bun.lock"), lock.as_bytes())?;
        eprintln!("Saved lockfile");
    }
    report(command, &opts, &resolver, installed, start);
    Ok(())
}

fn manifest(command: &str, parser: &dyn Transpiler) -> Result<Value> {
    if !Path::new("package.json").exists() {
        if command == "add" {
            return Ok(json!({}));
        }
        return Err("No package.json found to install from".into());
    }
    let value = io::read(Path::new("package.json"), "JSON", parser)?;
    if !value.is_object() {
        return Err("package.json must be an object".into());
    }
    Ok(value)
}

fn registry(opts: &Options, parser: &dyn Transpiler) -> Result<String> {
    if let Some(registry) = &opts.registry {
        return Ok(registry.trim_end_matches('/').into());
    }
    for variable in ["NPM_CONFIG_REGISTRY", "npm_config_registry"] {
        if let Ok(registry) = std::env::var(variable)
            && !registry.is_empty()
        {
            return Ok(registry.trim_end_matches('/').into());
        }
    }
    if Path::new("bunfig.toml").exists() {
        let config = io::read(Path::new("bunfig.toml"), "TOML", parser)?;
        if let Some(registry) = config["install"]["registry"].as_str() {
            return Ok(registry.trim_end_matches('/').into());
        }
    }
    Ok("https://registry.npmjs.org".into())
}

fn remove_names(manifest: &mut Value, names: &[String]) -> Result<()> {
    for name in names {
        resolve::valid_name(name)?;
        remove_name(manifest, name);
    }
    Ok(())
}

fn remove_name(manifest: &mut Value, name: &str) {
    for field in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if let Some(deps) = manifest[field].as_object_mut() {
            deps.remove(name);
        }
    }
}

fn add_names(manifest: &mut Value, opts: &Options) -> Result<()> {
    let field = if opts.dev { "devDependencies" } else { "dependencies" };
    for input in &opts.names {
        let (name, range) = resolve::spec(input)?;
        remove_name(manifest, &name);
        if !manifest[field].is_object() {
            manifest[field] = json!({});
        }
        manifest[field][name] = range.into();
    }
    Ok(())
}

fn finalize_additions(manifest: &mut Value, opts: &Options, resolver: &Resolver) -> Result<()> {
    let field = if opts.dev { "devDependencies" } else { "dependencies" };
    for input in &opts.names {
        let (name, range) = resolve::spec(input)?;
        let Some(package) = resolver.packages.get(&name) else {
            continue;
        };
        let range = if opts.exact {
            package.version.clone()
        } else if range == "latest" {
            format!("^{}", package.version)
        } else {
            range
        };
        manifest[field][name] = range.into();
    }
    Ok(())
}

fn package_present(package: &Package) -> bool {
    let Ok(bytes) = fs::read(package.path().join("package.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value["name"] == package.name && value["version"] == package.version
}

fn install_packages(resolver: &mut Resolver) -> Result<usize> {
    let mut installed = 0;
    let keys: Vec<_> = resolver.packages.keys().cloned().collect();
    for key in keys {
        let package = &resolver.packages[&key];
        if package_present(package) {
            continue;
        }
        if let Err(error) = install_package(package, resolver.refresh) {
            if !package.optional {
                return Err(format!("{}@{}: {error}", package.name, package.version));
            }
            eprintln!("warn: optional dependency {}: {error}", package.name);
            resolver.packages.remove(&key);
            continue;
        }
        installed += 1;
    }
    Ok(installed)
}

fn install_package(package: &Package, refresh: bool) -> Result<()> {
    let bytes = io::fetch(&package.tarball, true, refresh)?;
    io::integrity(&bytes, &package.integrity)?;
    let path = package.path();
    let staging = path.with_file_name(format!(".{}.bun-wasm-tmp", package.name.rsplit('/').next().unwrap()));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = io::extract(&bytes, &staging).and_then(|_| validate_package(&staging, package));
    if let Err(error) = result {
        let _ = fs::remove_dir_all(staging);
        return Err(error);
    }
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(staging, path).map_err(|e| e.to_string())
}

fn validate_package(staging: &Path, package: &Package) -> Result<()> {
    let bytes = fs::read(staging.join("package.json")).map_err(|_| "Tarball has no package.json")?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if manifest["name"] != package.name || manifest["version"] != package.version {
        return Err("Tarball name/version does not match registry metadata".into());
    }
    Ok(())
}

fn prune(locked: &Value, resolver: &Resolver) -> Result<()> {
    let Some(packages) = locked["packages"].as_object() else {
        return Ok(());
    };
    for (key, row) in packages {
        if resolver.packages.contains_key(key) {
            continue;
        }
        let chain = chain_from_lock(key, row)?;
        let path = resolve::path(&chain);
        if path.exists() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn chain_from_lock(key: &str, row: &Value) -> Result<Vec<String>> {
    let mut chain = Vec::new();
    let mut parts = key.split('/');
    while let Some(part) = parts.next() {
        let name = if part.starts_with('@') {
            format!("{part}/{}", parts.next().ok_or("Invalid lockfile package path")?)
        } else {
            part.into()
        };
        resolve::valid_name(&name)?;
        chain.push(name);
    }
    if !row.is_array() {
        return Err("Invalid lockfile package entry".into());
    }
    Ok(chain)
}

fn same_lock(locked: &Value, text: &str, parser: &dyn Transpiler, production: bool) -> Result<bool> {
    let planned = io::parsed(text.as_bytes(), "JSONC", parser)?;
    if !production {
        return Ok(*locked == planned);
    }
    let packages_match = planned["packages"].as_object().is_some_and(|packages| {
        packages.values().all(|row| {
            locked["packages"]
                .as_object()
                .is_some_and(|locked| locked.values().any(|old| old == row))
        })
    });
    Ok(locked["workspaces"] == planned["workspaces"] && packages_match)
}

fn lockfile(manifest: &Value, resolver: &Resolver) -> String {
    let mut root = json!({});
    for key in [
        "name",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if !manifest[key].is_null() {
            root[key] = manifest[key].clone();
        }
    }
    let mut out = "{\n  \"lockfileVersion\": 2,\n  \"configVersion\": 1,\n  \"workspaces\": {\n    \"\": ".to_owned();
    pretty(&root, 2, &mut out);
    out.push_str(",\n  },\n  \"packages\": {\n");
    for (index, (key, package)) in resolver.packages.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let tarball = if package.tarball.starts_with("https://registry.npmjs.org/") {
            ""
        } else {
            &package.tarball
        };
        let row = json!([
            format!("{}@{}", package.name, package.version),
            tarball,
            resolve::lock_info(&package.meta),
            package.integrity
        ]);
        out.push_str(&format!("    {}: {},\n", json!(key), inline(&row)));
    }
    out.push_str("  }\n}\n");
    out
}

fn pretty(value: &Value, level: usize, out: &mut String) {
    let Some(object) = value.as_object() else {
        out.push_str(&value.to_string());
        return;
    };
    if object.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push_str("{\n");
    for (key, value) in object {
        out.push_str(&format!("{}{}: ", "  ".repeat(level + 1), json!(key)));
        pretty(value, level + 1, out);
        out.push_str(",\n");
    }
    out.push_str(&format!("{}}}", "  ".repeat(level)));
}

fn inline(value: &Value) -> String {
    match value {
        Value::Array(values) => format!("[{}]", values.iter().map(inline).collect::<Vec<_>>().join(", ")),
        Value::Object(values) if !values.is_empty() => format!(
            "{{ {} }}",
            values
                .iter()
                .map(|(key, value)| format!("{}: {}", json!(key), inline(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => value.to_string(),
    }
}

fn report(command: &str, opts: &Options, resolver: &Resolver, installed: usize, start: Instant) {
    if command == "remove" {
        for name in &opts.names {
            println!("- {name}");
        }
        let removed = opts.names.len();
        println!(
            "{removed} package{} removed [{}ms]",
            if removed == 1 { "" } else { "s" },
            start.elapsed().as_millis()
        );
    } else if installed == 0 {
        println!(
            "Done! Checked {} packages (no changes) [{}ms]",
            resolver.packages.len() + 1,
            start.elapsed().as_millis()
        );
    } else {
        report_installed(command, opts, resolver, installed, start);
    }
    let blocked = resolver
        .packages
        .values()
        .filter(|p| resolve::lock_info(&p.meta)["hasInstallScript"] == true || p.meta["hasInstallScript"] == true)
        .count();
    if blocked > 0 {
        println!(
            "\nBlocked {blocked} postinstall{}. Lifecycle scripts cannot run in bun-wasm.",
            if blocked == 1 { "" } else { "s" }
        );
    }
}

fn report_installed(command: &str, opts: &Options, resolver: &Resolver, installed: usize, start: Instant) {
    if command == "add" {
        for input in &opts.names {
            report_added(input, resolver);
        }
    } else {
        for package in resolver.packages.values().filter(|p| p.chain.len() == 1) {
            println!("+ {}@{}", package.name, package.version);
        }
    }
    println!(
        "\n{installed} package{} installed [{}ms]",
        if installed == 1 { "" } else { "s" },
        start.elapsed().as_millis()
    );
}

fn report_added(input: &str, resolver: &Resolver) {
    if let Ok((name, _)) = resolve::spec(input)
        && let Some(package) = resolver.packages.get(&name)
    {
        println!("installed {name}@{}", package.version);
    }
}

fn pm(opts: &Options, parser: &dyn Transpiler) -> Result<()> {
    if opts.names.first().map(String::as_str) != Some("ls") {
        return Err("Only bun pm ls is supported in bun-wasm".into());
    }
    let manifest = manifest("install", parser)?;
    let deps = resolve::dependencies(&manifest, false, true);
    let names: BTreeSet<_> = deps.keys().collect();
    println!(
        "{} node_modules",
        std::env::current_dir().map_err(|e| e.to_string())?.display()
    );
    for (index, name) in names.iter().enumerate() {
        let path = Path::new("node_modules").join(name).join("package.json");
        let package: Value =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        println!(
            "{} {}@{}",
            if index + 1 == names.len() {
                "└──"
            } else {
                "├──"
            },
            name,
            package["version"].as_str().unwrap_or("?")
        );
    }
    Ok(())
}
