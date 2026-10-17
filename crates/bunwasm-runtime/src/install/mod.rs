//! Hoisted npm installs over the optional fetch ABI. No JS engine or OS processes.
mod io;
mod local;
mod migration;
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
    latest: bool,
    lockfile_only: bool,
    silent: bool,
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
            "-f" => opts.refresh = true,
            "--silent" => opts.silent = true,
            "--latest" => opts.latest = true,
            "--lockfile-only" => opts.lockfile_only = true,
            "--linker=hoisted" => {}
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
    let member = local::root(parser)?;
    if command == "ci" {
        opts.frozen = true;
    }
    if command == "pm" {
        return pm(&opts, parser);
    }
    let command = match command {
        "add" | "a" => "add",
        "remove" | "rm" | "r" | "uninstall" => "remove",
        "update" | "up" => "update",
        _ => "install",
    };
    if matches!(command, "add" | "remove") && opts.names.is_empty() {
        return Err(format!("bun {command} requires a package name"));
    }
    if !opts.silent {
        println!(
            "bun {command} v{BUN_VERSION} ({})\n",
            &BUN_REVISION[..9.min(BUN_REVISION.len())]
        );
    }
    let root_manifest = manifest(command, parser)?;
    let manifest_path = member.as_ref().map_or_else(
        || Path::new("package.json").to_owned(),
        |path| path.join("package.json"),
    );
    let mut manifest = if member.is_some() {
        io::read(&manifest_path, "JSON", parser)?
    } else {
        root_manifest.clone()
    };
    let old_manifest = manifest.clone();
    if command == "update" {
        update_manifest(&mut manifest, &opts)?;
    }
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
        migration::read(
            if member.is_some() {
                &root_manifest
            } else {
                &old_manifest
            },
            parser,
        )?
        .unwrap_or_else(|| json!({}))
    };
    let mut resolution_lock = locked.clone();
    if command == "update" {
        opts.refresh = true;
        unlock(&mut resolution_lock, &opts);
    }
    let mut resolver = Resolver::new(registry, resolution_lock, opts.refresh);
    let project_manifest = if member.is_some() { &root_manifest } else { &manifest };
    resolver.workspaces = local::workspaces(
        &std::env::current_dir().map_err(|e| e.to_string())?,
        project_manifest,
        parser,
    )?;
    if let Some(member) = &member {
        if let Some(local) = resolver.workspaces.values_mut().find(|local| &local.path == member) {
            local.meta = manifest.clone();
        }
    }
    resolver.resolve(project_manifest, opts.production)?;
    if command != "remove" && command != "update" {
        finalize_additions(&mut manifest, &opts, &resolver, member.as_deref())?;
    }
    if command == "update" {
        finalize_updates(&mut manifest, &opts, &resolver, member.as_deref())?;
    }
    if let Some(member) = &member {
        if let Some(local) = resolver.workspaces.values_mut().find(|local| &local.path == member) {
            local.meta = manifest.clone();
        }
    }
    let lock = lockfile(if member.is_some() { &root_manifest } else { &manifest }, &resolver);
    if opts.frozen && !same_lock(&locked, &lock, parser, opts.production)? {
        return Err("lockfile had changes, but lockfile is frozen".into());
    }
    let installed = if opts.lockfile_only {
        0
    } else {
        let count = install_packages(&mut resolver)?;
        prune(&locked, &resolver)?;
        link_bins(&resolver)?;
        count
    };
    if manifest != old_manifest {
        io::write(
            &manifest_path,
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()).as_bytes(),
        )?;
    }
    if !opts.production && fs::read_to_string("bun.lock").ok().as_deref() != Some(lock.as_str()) {
        io::write(Path::new("bun.lock"), lock.as_bytes())?;
        eprintln!("Saved lockfile");
    }
    if !opts.silent {
        report(command, &opts, &resolver, installed, start, member.as_deref());
    }
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
    let mut value = value;
    if value["workspaces"].is_null() && Path::new("pnpm-workspace.yaml").exists() {
        let config = io::read(Path::new("pnpm-workspace.yaml"), "YAML", parser)?;
        if config["packages"].is_array() {
            value["workspaces"] = config["packages"].clone();
        }
    }
    Ok(value)
}

fn registry(opts: &Options, parser: &dyn Transpiler) -> Result<String> {
    if let Some(registry) = &opts.registry {
        return Ok(registry.trim_end_matches('/').into());
    }
    for variable in ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"] {
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

fn finalize_additions(manifest: &mut Value, opts: &Options, resolver: &Resolver, member: Option<&Path>) -> Result<()> {
    let field = if opts.dev { "devDependencies" } else { "dependencies" };
    for input in &opts.names {
        let (name, range) = resolve::spec(input)?;
        let Some(package) = command_package(resolver, &name, member) else {
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

fn command_package<'a>(resolver: &'a Resolver, name: &str, member: Option<&Path>) -> Option<&'a Package> {
    let local = member.and_then(|member| resolver.workspaces.iter().find(|(_, local)| local.path == member));
    if let Some((workspace, _)) = local {
        if let Some(package) = resolver.packages.get(&format!("{workspace}/{name}")) {
            return Some(package);
        }
    }
    resolver.packages.get(name)
}

fn package_present(package: &Package) -> bool {
    if let Some(local) = &package.local {
        return local::physical(&package.path()).ok().as_deref() == Some(local.path.as_path());
    }
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
    if let Some(local) = &package.local {
        return local::link(&local.path, &package.path());
    }
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
        if fs::symlink_metadata(&path).is_ok() {
            if fs::symlink_metadata(&path).is_ok_and(|m| m.is_symlink()) {
                fs::remove_file(path)
            } else {
                fs::remove_dir_all(path)
            }
            .map_err(|e| e.to_string())?;
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
    let mut root = local::lock_meta(manifest);
    root.as_object_mut().unwrap().remove("version");
    let mut out = "{\n  \"lockfileVersion\": 2,\n  \"configVersion\": 1,\n  \"workspaces\": {\n    \"\": ".to_owned();
    pretty(&root, 2, &mut out);
    for member in resolver.workspaces.values() {
        let cwd = std::env::current_dir().unwrap();
        let path = member.path.strip_prefix(&cwd).unwrap_or(&member.path).to_string_lossy();
        out.push_str(&format!(",\n    {}: ", json!(path)));
        pretty(&local::lock_meta(&member.meta), 2, &mut out);
    }
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
        let row = if let Some(local) = &package.local {
            let cwd = std::env::current_dir().unwrap();
            let path = local::relative(&local.path, &cwd);
            let path = if !local.workspace
                && path
                    .components()
                    .next()
                    .is_some_and(|part| matches!(part, std::path::Component::Normal(_)))
            {
                format!("./{}", path.display())
            } else {
                path.to_string_lossy().into_owned()
            };
            json!([format!(
                "{}@{}:{path}",
                package.name,
                if local.workspace { "workspace" } else { "link" }
            )])
        } else {
            json!([
                format!("{}@{}", package.name, package.version),
                tarball,
                resolve::lock_info(&package.meta),
                package.integrity
            ])
        };
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

fn report(command: &str, opts: &Options, resolver: &Resolver, installed: usize, start: Instant, member: Option<&Path>) {
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
        report_installed(command, opts, resolver, installed, start, member);
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

fn report_installed(
    command: &str,
    opts: &Options,
    resolver: &Resolver,
    installed: usize,
    start: Instant,
    member: Option<&Path>,
) {
    if command == "add" {
        for input in &opts.names {
            report_added(input, resolver, member);
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

fn report_added(input: &str, resolver: &Resolver, member: Option<&Path>) {
    if let Ok((name, _)) = resolve::spec(input)
        && let Some(package) = command_package(resolver, &name, member)
    {
        println!("installed {name}@{}", package.version);
    }
}

fn pm(opts: &Options, parser: &dyn Transpiler) -> Result<()> {
    if opts.names.first().map(String::as_str) == Some("migrate") {
        let manifest = manifest("install", parser)?;
        let lock = migration::read(&manifest, parser)?.ok_or("No lockfile found to migrate")?;
        return io::write(
            Path::new("bun.lock"),
            format!("{}\n", serde_json::to_string_pretty(&lock).unwrap()).as_bytes(),
        );
    }
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

fn update_manifest(manifest: &mut Value, opts: &Options) -> Result<()> {
    for input in &opts.names {
        let (name, range) = resolve::spec(input)?;
        if input.rfind('@').is_some_and(|at| at > 0) {
            for field in [
                "dependencies",
                "devDependencies",
                "optionalDependencies",
                "peerDependencies",
            ] {
                if opts.production && field == "devDependencies" {
                    continue;
                }
                if manifest[field].get(&name).is_some() {
                    manifest[field][&name] = range.clone().into();
                }
            }
        }
    }
    if !opts.latest {
        return Ok(());
    }
    for field in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if opts.production && field == "devDependencies" {
            continue;
        }
        let Some(deps) = manifest[field].as_object_mut() else {
            continue;
        };
        for (name, range) in deps {
            if selected(name, opts) && range.as_str().is_some_and(|r| !r.contains(':')) {
                *range = "latest".into();
            }
        }
    }
    Ok(())
}

fn selected(name: &str, opts: &Options) -> bool {
    opts.names.is_empty()
        || opts
            .names
            .iter()
            .any(|input| resolve::spec(input).is_ok_and(|(n, _)| n == name))
}

fn unlock(locked: &mut Value, opts: &Options) {
    let Some(packages) = locked["packages"].as_object_mut() else {
        return;
    };
    packages.retain(|key, _| !selected(key, opts));
}

fn finalize_updates(manifest: &mut Value, opts: &Options, resolver: &Resolver, member: Option<&Path>) -> Result<()> {
    for field in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        let Some(deps) = manifest[field].as_object_mut() else {
            continue;
        };
        for (name, range) in deps {
            if !selected(name, opts) {
                continue;
            }
            let Some(package) = command_package(resolver, name, member) else {
                continue;
            };
            let old = range.as_str().unwrap_or("");
            if old.contains(':') {
                continue;
            }
            let prefix = if opts.exact {
                ""
            } else if old.starts_with('~') {
                "~"
            } else if old.starts_with('^') || old == "latest" {
                "^"
            } else {
                ""
            };
            *range = format!("{prefix}{}", package.version).into();
        }
    }
    Ok(())
}

fn link_bins(resolver: &Resolver) -> Result<()> {
    for package in resolver.packages.values() {
        let path = package.path();
        if package.local.is_some() && !path.join("package.json").exists() {
            continue;
        }
        let meta: Value = serde_json::from_slice(&fs::read(path.join("package.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let bins = binary_entries(&meta, &path)?;
        let modules = resolve::path(&package.chain[..package.chain.len() - 1]).join("node_modules");
        for (name, file) in bins {
            let target = std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(&path)
                .join(&file);
            if !target.is_file() {
                continue;
            }
            let relative = Path::new("..").join(package.chain.last().unwrap()).join(file);
            local::link(&relative, &modules.join(".bin").join(name))?;
        }
    }
    if let Ok(entries) = fs::read_dir("node_modules/.bin") {
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_symlink() && !path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn binary_entries(meta: &Value, base: &Path) -> Result<Vec<(String, std::path::PathBuf)>> {
    let mut entries = Vec::new();
    if let Some(bin) = meta["bin"].as_str() {
        let name = meta["name"]
            .as_str()
            .and_then(|n| n.rsplit('/').next())
            .ok_or("Binary package needs a name")?;
        entries.push((name.to_owned(), bin.into()));
    } else if let Some(bins) = meta["bin"].as_object() {
        for (name, file) in bins {
            entries.push((
                name.clone(),
                file.as_str().ok_or("Package bin must be a string")?.into(),
            ));
        }
    } else if let Some(dir) = meta["directories"]["bin"].as_str() {
        let dir = std::path::PathBuf::from(dir);
        for entry in fs::read_dir(base.join(&dir)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                entries.push((
                    entry.file_name().to_string_lossy().into_owned(),
                    dir.join(entry.file_name()),
                ));
            }
        }
    }
    if entries.iter().any(|(_, file)| {
        file.is_absolute()
            || file
                .components()
                .any(|p| !matches!(p, std::path::Component::Normal(_) | std::path::Component::CurDir))
    }) {
        return Err("Invalid package bin path".into());
    }
    if entries
        .iter()
        .any(|(name, _)| name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\'))
    {
        return Err("Invalid package binary name".into());
    }
    Ok(entries)
}

pub fn prepare_x(args: Vec<String>, parser: &dyn Transpiler) -> Result<(String, Vec<String>)> {
    use sha2::{Digest, Sha256};
    let mut args = args.into_iter();
    let mut package = None;
    let mut no_install = false;
    let binary = loop {
        match args.next().as_deref() {
            Some("--bun" | "--silent" | "--") => continue,
            Some("--no-install") => no_install = true,
            Some("-p" | "--package") => package = Some(args.next().ok_or("--package requires a name")?),
            Some(flag) if flag.starts_with('-') => {
                return Err(format!("Unknown bun x option: {flag}"));
            }
            Some(name) => break name.to_owned(),
            None => return Err("bun x requires a package name".into()),
        }
    };
    let input = package.as_deref().unwrap_or(&binary);
    let (name, range) = resolve::spec(input)?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let bin_name = if package.is_some() {
        binary.as_str()
    } else {
        name.rsplit('/').next().unwrap()
    };
    if package.is_none() && input == name {
        for ancestor in cwd.ancestors() {
            let bin = ancestor.join("node_modules/.bin").join(bin_name);
            if bin.is_file() {
                return Ok((bin.to_string_lossy().into_owned(), args.collect()));
            }
        }
    }
    if no_install {
        return Err(format!("Executable not found: {bin_name}"));
    }
    let registry = registry(&Options::default(), parser)?;
    let hash = format!("{:x}", Sha256::digest(format!("{registry}/{name}@{range}").as_bytes()));
    let cache = cwd.join(io::cache_dir()).join("bunx");
    let destination = cache.join(hash);
    if !destination.join("bun.lock").exists() {
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let staging = cache.join(format!(".staging-{:x}", u128::from_le_bytes(random)));
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let result = (|| {
            io::write(
                &staging.join("package.json"),
                json!({"dependencies": {name.clone(): range}}).to_string().as_bytes(),
            )?;
            std::env::set_current_dir(&staging).map_err(|e| e.to_string())?;
            let installed = execute(
                "install",
                vec!["--silent".into(), "--registry".into(), registry],
                parser,
            );
            std::env::set_current_dir(&cwd).map_err(|e| e.to_string())?;
            installed?;
            match fs::rename(&staging, &destination) {
                Ok(()) => Ok(()),
                Err(_) if destination.join("bun.lock").exists() => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })();
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        result?;
    }
    let base = destination.join("node_modules").join(&name);
    let meta = io::read(&base.join("package.json"), "JSON", parser)?;
    let bins = binary_entries(&meta, &base)?;
    let file = bins
        .iter()
        .find(|(bin, _)| bin == bin_name)
        .or_else(|| if bins.len() == 1 { bins.first() } else { None })
        .ok_or_else(|| format!("Could not determine executable for package {name}"))?;
    Ok((base.join(&file.1).to_string_lossy().into_owned(), args.collect()))
}
