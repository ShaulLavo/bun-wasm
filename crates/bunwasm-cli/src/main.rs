//! `bun` for wasm32-wasip1: argument parsing and wiring of the transpiler
//! into the runtime.

use bunwasm_runtime::{Entry, Options, Transpiler};

const HELP: &str = "\
Bun is a fast JavaScript runtime. This is bun.wasm: Bun's runtime on WebAssembly (WASI).

Usage: bun <command> [...flags] [...args]

Commands:
  run       ./my-script.ts       Execute a file with Bun
  test      [filters]            Run unit tests with Bun's test runner
  build     ./a.ts --outdir out  Bundle TypeScript & JavaScript into a single file
  install, i                     Install dependencies
  add       <package>           Add dependencies
  remove    <package>           Remove dependencies
  update    [package]           Update dependencies
  x         <package>           Execute a package binary
  exec      <script>             Run a shell script
  init      [folder]             Start an empty Bun project
  create    <template> [dest]    Create a project from a create-<template> package
  repl                           Start a JavaScript and TypeScript REPL
  pm ls                          List installed dependencies
  <file>                         Same as `bun run <file>`
  -e, --eval <code>              Evaluate JavaScript source code
  -p, --print <code>             Evaluate and print the result

Flags:
  -v, --version                  Print version and exit
      --revision                 Print version with revision and exit
  -h, --help                     Display this menu and exit
      --conditions <condition>   Add a package-export resolution condition

Not available in bun.wasm: upgrade.
";

fn transpiler() -> Box<dyn Transpiler> {
    #[cfg(feature = "bun-transpiler")]
    {
        Box::new(bun_transpiler::BunTranspiler)
    }
    #[cfg(not(feature = "bun-transpiler"))]
    {
        Box::new(bunwasm_runtime::PassthroughTranspiler)
    }
}

#[cfg(feature = "bun-transpiler")]
mod bun_transpiler {
    use bunwasm_runtime::{Loader, Transpiled, Transpiler};
    use bunwasm_transpiler::Loader as BunLoader;

    /// The browser engine (feature engine-host) runs on a host JS engine
    /// without AsyncContext: `await`s get hooks that carry AsyncLocalStorage.
    const AWAIT_HOOKS: bool = cfg!(feature = "engine-host");

    fn runtime_imports(
        imports: Vec<bunwasm_transpiler::ModuleImport>,
    ) -> Vec<bunwasm_runtime::transpiler::ModuleImport> {
        use bunwasm_runtime::transpiler::{ModuleImport, ModuleImportKind};
        imports
            .into_iter()
            .map(|import| ModuleImport {
                start: import.start,
                end: import.end,
                kind: match import.specifier {
                    Some(specifier) => ModuleImportKind::Static(specifier),
                    None => ModuleImportKind::Dynamic,
                },
            })
            .collect()
    }

    /// Bun's real parser and printer (crates/bunwasm-transpiler).
    ///
    /// Plain JavaScript keeps its original text unless await hooks are needed.
    /// The same parse supplies its module kind and semantic import locations.
    pub struct BunTranspiler;

    impl Transpiler for BunTranspiler {
        fn public_transpile(
            &self,
            source: &[u8],
            options: &str,
            action: &str,
            loader: &str,
        ) -> Result<String, String> {
            bunwasm_transpiler::public_transpile(source, options, action, loader)
        }

        fn function_imports(&self, args: &[String], kind: &str) -> Result<Vec<Vec<usize>>, String> {
            bunwasm_transpiler::function_imports(args, kind)
        }

        fn parse_data(
            &self,
            source: &[u8],
            format: &str,
        ) -> Result<String, bunwasm_runtime::engine::NativeError> {
            use bunwasm_runtime::engine::NativeError;
            use bunwasm_transpiler::data::Error;
            bunwasm_transpiler::data::parse(source, format).map_err(|e| match e {
                Error::Syntax(message) => NativeError::syntax_error(message),
                Error::Range(message) => NativeError::range_error(message),
            })
        }

        fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String> {
            self.transpile_with_map(source, path, loader)
                .map(|out| out.code)
        }

        fn transpile_with_map(
            &self,
            source: &str,
            path: &str,
            loader: Loader,
        ) -> Result<Transpiled, String> {
            let loader = match loader {
                // The browser engine needs every `await` printed with its
                // AsyncLocalStorage hooks, plain JavaScript included.
                Loader::Js => BunLoader::Js,
                Loader::Jsx => BunLoader::Jsx,
                Loader::Ts => BunLoader::Ts,
                Loader::Tsx => BunLoader::Tsx,
                Loader::Json => BunLoader::Json,
                Loader::Toml => BunLoader::Toml,
                Loader::Yaml => BunLoader::Yaml,
                Loader::Json5 => BunLoader::Json5,
                Loader::Jsonc => BunLoader::Jsonc,
                Loader::Text => BunLoader::Text,
            };
            let preserve_source =
                loader == BunLoader::Js && !(AWAIT_HOOKS && source.contains("await"));
            // These extensions decide the format before parser classification in
            // State::detect_format, so unchanged JS only needs semantic imports.
            if preserve_source && (path.ends_with(".mjs") || path.ends_with(".cjs")) {
                use bunwasm_runtime::transpiler::ModuleKind;
                return Ok(Transpiled {
                    code: source.to_owned(),
                    mappings: None,
                    imports: if AWAIT_HOOKS {
                        self.module_imports(source, path)?
                    } else {
                        Vec::new()
                    },
                    module_kind: Some(if path.ends_with(".mjs") {
                        ModuleKind::Esm
                    } else {
                        ModuleKind::CommonJs
                    }),
                });
            }
            let out = bunwasm_transpiler::with_await_hooks(AWAIT_HOOKS, || {
                bunwasm_transpiler::transpile_with_source_map(source, path, loader, preserve_source)
            })?;
            use bunwasm_runtime::transpiler::ModuleKind;
            use bunwasm_transpiler::ModuleKind as ParsedKind;
            let module_kind = Some(match out.module_kind {
                ParsedKind::Script => ModuleKind::Script,
                ParsedKind::CommonJs => ModuleKind::CommonJs,
                ParsedKind::Esm => ModuleKind::Esm,
            });
            Ok(Transpiled {
                code: out.code,
                mappings: if preserve_source {
                    None
                } else {
                    Some(out.mappings)
                },
                imports: runtime_imports(out.imports),
                module_kind,
            })
        }

        fn module_imports(
            &self,
            source: &str,
            path: &str,
        ) -> Result<Vec<bunwasm_runtime::transpiler::ModuleImport>, String> {
            bunwasm_transpiler::module_imports(source, path).map(runtime_imports)
        }

        /// Bun's bundler on the one file, every import external: `bun build
        /// --format=cjs --target=bun --external '*' --sourcemap=inline`.
        /// Imports become `require()` calls read through live getters. No
        /// outdir: with one, the bundler writes the files itself.
        #[cfg(feature = "bun-build")]
        fn esm_to_cjs(&self, path: &str) -> Result<Transpiled, String> {
            use bunwasm_build::{BuildArgs, Format, SourceMap, Target};
            let args = BuildArgs {
                entry_points: vec![path.to_owned()],
                target: Some(Target::Bun),
                format: Format::Cjs,
                external: vec!["*".to_owned()],
                sourcemap: SourceMap::Inline,
                write: false,
                ..BuildArgs::default()
            };
            let out = bunwasm_transpiler::with_await_hooks(AWAIT_HOOKS, || {
                if AWAIT_HOOKS {
                    bunwasm_transpiler::with_dynamic_import_referrer(path, || {
                        bunwasm_build::build(&args)
                    })
                } else {
                    bunwasm_build::build(&args)
                }
            })
            .map_err(|log| log.trim_end().to_owned())?;
            let code = out
                .stdout
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            if code.is_empty() {
                return Err(format!("bun build produced no output for {path}"));
            }
            const MARK: &str = "\n//# sourceMappingURL=data:application/json;base64,";
            let (code, mappings) = match code.rfind(MARK) {
                Some(at) => {
                    let map = base64_decode(code[at + MARK.len()..].trim_end());
                    (
                        code[..at].to_owned(),
                        map.and_then(|json| json_string_field(&json, "mappings")),
                    )
                }
                None => (code, None),
            };
            Ok(Transpiled {
                code,
                mappings,
                ..Default::default()
            })
        }

        #[cfg(feature = "bun-build")]
        fn build(
            &self,
            request: &bunwasm_runtime::BuildRequest,
        ) -> Result<bunwasm_runtime::BuildResult, String> {
            build(request)
        }

        #[cfg(feature = "bun-build")]
        fn dev_server_open(&self, path: &str) -> Result<bunwasm_runtime::DevServerResult, String> {
            bunwasm_build::dev_server::open(path).map(dev_server_result)
        }

        #[cfg(feature = "bun-build")]
        fn dev_server_rebuild(
            &self,
            id: u32,
            changed: &[String],
        ) -> Result<bunwasm_runtime::DevServerResult, String> {
            bunwasm_build::dev_server::rebuild(id, changed).map(dev_server_result)
        }

        #[cfg(feature = "bun-build")]
        fn dev_server_close(&self, id: u32) {
            bunwasm_build::dev_server::close(id);
        }
    }

    #[cfg(feature = "bun-build")]
    fn dev_server_result(
        output: bunwasm_build::dev_server::Output,
    ) -> bunwasm_runtime::DevServerResult {
        bunwasm_runtime::DevServerResult {
            id: output.id,
            version: output.version,
            html: output.html,
            files: output
                .files
                .into_iter()
                .map(|file| bunwasm_runtime::DevServerFile {
                    path: file.path,
                    contents: file.contents,
                    mime: file.mime,
                })
                .collect(),
            watch: output.watch,
            update: output.update,
            errors: output.errors,
            logs: output.logs,
        }
    }

    /// `Bun.build`: the options map onto `bun build`'s flags. Without an
    /// `outdir` nothing is written: the outputs only come back in memory,
    /// named `./<name>.js` like native Bun's.
    #[cfg(feature = "bun-build")]
    pub(super) fn build(
        request: &bunwasm_runtime::BuildRequest,
    ) -> Result<bunwasm_runtime::BuildResult, String> {
        use bunwasm_build::{BuildArgs, Format, OutputKind, Packages, SourceMap, Target};
        use bunwasm_runtime::{BuildArtifact, BuildResult};
        let bad = |what: &str, value: &str| format!("Bun.build: invalid {what} \"{value}\"");
        let target = match request.target.as_deref() {
            None => None,
            Some("browser") => Some(Target::Browser),
            Some("bun") => Some(Target::Bun),
            Some("node") => Some(Target::Node),
            Some(other) => return Err(bad("target", other)),
        };
        let format = match request.format.as_deref() {
            None | Some("esm") => Format::Esm,
            Some("cjs") => Format::Cjs,
            Some("iife") => Format::Iife,
            Some(other) => return Err(bad("format", other)),
        };
        let sourcemap = match request.sourcemap.as_deref() {
            None | Some("none") => SourceMap::None,
            Some("inline") => SourceMap::Inline,
            Some("linked") => SourceMap::Linked,
            Some("external") => SourceMap::External,
            Some(other) => return Err(bad("sourcemap", other)),
        };
        let packages = match request.packages.as_deref() {
            None => None,
            Some("bundle") => Some(Packages::Bundle),
            Some("external") => Some(Packages::External),
            Some(other) => return Err(bad("packages", other)),
        };
        let args = BuildArgs {
            entry_points: request.entrypoints.clone(),
            outdir: request.outdir.clone(),
            root: request.root.clone(),
            target,
            format,
            minify_syntax: request.minify_syntax,
            minify_whitespace: request.minify_whitespace,
            minify_identifiers: request.minify_identifiers,
            sourcemap,
            splitting: request.splitting,
            external: request.external.clone(),
            packages,
            define: request.define.clone(),
            conditions: request.conditions.clone(),
            public_path: request.public_path.clone(),
            banner: request.banner.clone(),
            footer: request.footer.clone(),
            entry_naming: request.entry_naming.clone(),
            chunk_naming: request.chunk_naming.clone(),
            asset_naming: request.asset_naming.clone(),
            react_fast_refresh: request.react_fast_refresh,
            write: request.outdir.is_some(),
            ..BuildArgs::default()
        };
        // The output is for whatever `target` says, never for the host engine.
        let out = bunwasm_transpiler::with_await_hooks(false, || bunwasm_build::build(&args))
            .map_err(|log| log.trim_end().to_owned())?;
        let mut outputs = Vec::new();
        if let Some(bytes) = out.stdout {
            let entry = request
                .entrypoints
                .first()
                .map(String::as_str)
                .unwrap_or("out");
            let base = entry.rsplit('/').next().unwrap_or(entry);
            let stem = base.rsplit_once('.').map_or(base, |(stem, _)| stem);
            outputs.push(BuildArtifact {
                path: format!("./{stem}.js"),
                kind: "entry-point",
                contents: bytes,
            });
        }
        for file in out.files {
            let kind = match file.kind {
                OutputKind::EntryPoint => "entry-point",
                OutputKind::Chunk => "chunk",
                OutputKind::Asset => "asset",
                OutputKind::SourceMap => "sourcemap",
                OutputKind::Metafile => "metafile",
                OutputKind::Other => "asset",
            };
            let relative = file.path.trim_start_matches("./");
            let (path, contents) = match &request.outdir {
                // The bundler wrote the file itself and kept no copy.
                Some(dir) => {
                    let path = format!("{}/{relative}", dir.trim_end_matches('/'));
                    let contents = if file.contents.is_empty() {
                        std::fs::read(&path).unwrap_or_default()
                    } else {
                        file.contents
                    };
                    (path, contents)
                }
                None => (format!("./{relative}"), file.contents),
            };
            outputs.push(BuildArtifact {
                path,
                kind,
                contents,
            });
        }
        if let Some(err) = out.write_errors.first() {
            return Err(err.clone());
        }
        Ok(BuildResult {
            outputs,
            logs: out.log,
        })
    }

    #[cfg(feature = "bun-build")]
    fn base64_decode(text: &str) -> Option<String> {
        let mut out = Vec::with_capacity(text.len() * 3 / 4);
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in text.bytes() {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => break,
                _ => return None,
            };
            acc = (acc << 6) | u32::from(v);
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        String::from_utf8(out).ok()
    }

    /// The string value of `"key"` in a JSON object (source map fields have
    /// no nesting before `mappings`, and VLQ needs no unescaping).
    #[cfg(feature = "bun-build")]
    fn json_string_field(json: &str, key: &str) -> Option<String> {
        let at = json.find(&format!("\"{key}\""))? + key.len() + 2;
        let rest = json[at..]
            .trim_start()
            .strip_prefix(':')?
            .trim_start()
            .strip_prefix('"')?;
        Some(rest[..rest.find('"')?].to_owned())
    }
}

#[cfg(feature = "bun-build")]
mod build_command;

#[cfg(feature = "bun-build")]
fn build(args: Vec<String>) -> i32 {
    build_command::run(args)
}

#[cfg(not(feature = "bun-build"))]
fn build(_: Vec<String>) -> i32 {
    eprintln!("error: this bun.wasm was built without the bundler (feature bun-build)");
    1
}

mod tool_args;

enum Command {
    Run(Entry, Vec<String>, Vec<String>, Vec<String>),
    Build(Vec<String>),
    Lint,
    Install(String, Vec<String>),
    X(Vec<String>),
    Init(Vec<String>),
    Exit(i32),
}

/// `bun exec <script>`: the script runs in the system shell (bash-web), as package scripts do.
const EXEC: &str = "const shell = Bun.which(\"bash\") ?? Bun.which(\"sh\") ?? \"/bin/sh\";\n\
    const child = Bun.spawn([shell, \"-c\", process.argv[1]], { stdio: [\"inherit\", \"inherit\", \"inherit\"] });\n\
    process.exitCode = await child.exited;";

/// `bun repl`: Bun's banner, then node:repl (Bun's REPL transform) until .exit or Ctrl+D.
const REPL: &str = "if (process.stdin.isTTY) process.stdout.write(`Welcome to Bun v${Bun.version}\\r\\nType .help for more info.\\r\\n\\r\\n`);\n\
    const repl = (await import(\"node:repl\")).start();\n\
    await new Promise(resolve => repl.on(\"exit\", resolve));\n\
    process.exit(0);";

const CREATE_HELP: &str = "Usage:
  bun create <template> [...flags] dest

Templates:
  • NPM: Runs bunx create-<template> with given arguments

Learn more: https://bun.com/docs/cli/bun-create
";

/// Bun's BunxCommand::add_create_prefix: `vite` -> `create-vite`, `@scope/x` -> `@scope/create-x`,
/// `@scope` -> `@scope/create`.
fn create_package(template: &str) -> String {
    let Some(scoped) = template.strip_prefix('@') else {
        return format!("create-{template}");
    };
    if let Some(slash) = scoped.find('/') {
        return format!("@{}/create-{}", &scoped[..slash], &scoped[slash + 1..]);
    }
    match scoped.find('@') {
        Some(version) => format!("@{}/create{}", &scoped[..version], &scoped[version..]),
        None => format!("{template}/create"),
    }
}

/// `bun create <template> ...`: npm templates run `bun x create-<template>`, as in Bun.
fn create_command(args: Vec<String>) -> Command {
    let Some(index) = args
        .iter()
        .position(|arg| !arg.trim().is_empty() && !arg.starts_with("--"))
    else {
        print!("{CREATE_HELP}");
        return Command::Exit(0);
    };
    let template = args[index].trim();
    if args[..=index]
        .iter()
        .any(|arg| arg == "--help" || arg == "-h")
    {
        print!("{CREATE_HELP}");
        return Command::Exit(0);
    }
    if template == "react" || template == "next" {
        let tool = if template == "react" {
            "vite"
        } else {
            "next-app"
        };
        eprintln!("error: the \"{template}\" template is not available; run bun create {tool}");
        return Command::Exit(1);
    }
    if template.contains('/') && !template.starts_with('@')
        || template.ends_with(".jsx")
        || template.ends_with(".tsx")
    {
        eprintln!(
            "error: bun create supports npm create-<template> packages in bun-wasm; {template} is not one"
        );
        return Command::Exit(1);
    }
    let bun = args[..index].iter().any(|arg| arg == "--bun");
    let x_args = if bun {
        vec!["--bun".to_owned()]
    } else {
        Vec::new()
    };
    Command::X(
        x_args
            .into_iter()
            .chain([create_package(template)])
            .chain(args[index + 1..].iter().cloned())
            .collect(),
    )
}

fn usage_error(message: &str) -> Command {
    eprintln!("error: {message}\n");
    eprint!("{HELP}");
    Command::Exit(1)
}

fn parse(args: Vec<String>, executable: &str) -> Command {
    if matches!(executable.rsplit('/').next(), Some("node" | "nodejs")) {
        return node_command(args);
    }
    if tool_args::before_command(&args).is_some() {
        return Command::Lint;
    }
    parse_command(args, false)
}

fn node_command(args: Vec<String>) -> Command {
    match parse_command(args, true) {
        Command::Run(Entry::File(file), args, conditions, exec_argv) => {
            // Node operands are files even when their names match Bun commands or package scripts.
            let path = std::env::current_dir().unwrap_or_default().join(file);
            Command::Run(
                Entry::File(path.to_string_lossy().into_owned()),
                args,
                conditions,
                exec_argv,
            )
        }
        command => command,
    }
}

fn direct_file(file: &str) -> String {
    let path = std::path::Path::new(file);
    if !path.is_file() {
        return file.to_owned();
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join(path)
        .to_string_lossy()
        .into_owned()
}

fn parse_command(args: Vec<String>, run_file: bool) -> Command {
    parse_command_with_flags(args, run_file, Vec::new(), Vec::new())
}

fn parse_command_with_flags(
    args: Vec<String>,
    run_file: bool,
    conditions: Vec<String>,
    exec_argv: Vec<String>,
) -> Command {
    let mut rest = args.into_iter();
    let mut conditions = conditions;
    let mut exec_argv = exec_argv;
    while let Some(arg) = rest.next() {
        if run_file && (arg == "-" || !arg.starts_with('-')) {
            return Command::Run(Entry::File(arg), rest.collect(), conditions, exec_argv);
        }
        if arg == "--conditions" {
            let Some(value) = rest.next() else {
                return usage_error("--conditions requires a value");
            };
            conditions.push(value.clone());
            exec_argv.push(arg);
            exec_argv.push(value);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--conditions=") {
            conditions.push(value.to_owned());
            exec_argv.push(arg);
            continue;
        }
        match arg.as_str() {
            "-v" | "--version" => {
                println!("{}", bunwasm_runtime::BUN_VERSION);
                return Command::Exit(0);
            }
            "--revision" => {
                let short =
                    &bunwasm_runtime::BUN_REVISION[..bunwasm_runtime::BUN_REVISION.len().min(9)];
                println!("{}+{short}", bunwasm_runtime::BUN_VERSION);
                return Command::Exit(0);
            }
            "-h" | "--help" | "help" => {
                print!("{HELP}");
                return Command::Exit(0);
            }
            "-e" | "--eval" => {
                let Some(code) = rest.next() else {
                    return usage_error("--eval requires code");
                };
                return Command::Run(Entry::Eval(code), rest.collect(), conditions, exec_argv);
            }
            "-p" | "--print" => {
                let Some(code) = rest.next() else {
                    return usage_error("--print requires code");
                };
                let wrapped = format!(
                    "const __bunwasm_print = await (0, eval)({code:?}); \
                     console.log(typeof __bunwasm_print === 'string' ? __bunwasm_print : Bun.inspect(__bunwasm_print));"
                );
                return Command::Run(Entry::Eval(wrapped), Vec::new(), conditions, exec_argv);
            }
            "lint" | "fmt" => return Command::Lint,
            "test" => {
                return Command::Run(
                    Entry::Test(rest.collect()),
                    Vec::new(),
                    conditions,
                    exec_argv,
                );
            }
            "build" | "bun" => return Command::Build(rest.collect()),
            "install" | "i" | "ci" | "add" | "a" | "remove" | "rm" | "r" | "uninstall" | "pm"
            | "update" | "up" => return Command::Install(arg, rest.collect()),
            "x" | "bunx" => return Command::X(rest.collect()),
            "create" | "c" => return create_command(rest.collect()),
            "init" => return Command::Init(rest.collect()),
            "repl" => {
                return Command::Run(
                    Entry::Eval(REPL.to_owned()),
                    rest.collect(),
                    conditions,
                    exec_argv,
                );
            }
            "exec" => {
                let Some(script) = rest.next() else {
                    return usage_error("bun exec needs a script to run");
                };
                return Command::Run(
                    Entry::Eval(EXEC.to_owned()),
                    vec![script],
                    conditions,
                    exec_argv,
                );
            }
            "upgrade" | "link" | "unlink" | "outdated" | "publish" | "patch" | "patch-commit"
            | "info" | "why" | "audit" | "completions" | "getcompletes" | "discord" | "dedupe"
            | "prune" | "check" | "deploy" | "cloud" | "config" | "use" | "auth" | "login"
            | "logout" => {
                eprintln!("error: bun {arg} is not supported in bun-wasm");
                return Command::Exit(1);
            }
            "run" => return parse_command_with_flags(rest.collect(), true, conditions, exec_argv),
            "--" => {
                let Some(file) = rest.next() else {
                    return usage_error("bun run needs a file to run");
                };
                return Command::Run(Entry::File(file), rest.collect(), conditions, exec_argv);
            }
            // Flags native Bun accepts that change nothing here.
            "--bun" | "--smol" | "--no-install" => continue,
            // Like native Bun, other runtime flags (Node's --enable-source-maps, --no-warnings, ...)
            // are accepted and kept in process.execArgv, so forked children receive them too.
            // `bun run --silent` reaches package scripts this way and hides their `$ command` lines.
            flag if flag.starts_with('-') => exec_argv.push(flag.to_owned()),
            file => {
                return Command::Run(
                    Entry::File(direct_file(file)),
                    rest.collect(),
                    conditions,
                    exec_argv,
                );
            }
        }
    }
    if run_file {
        return usage_error("bun run needs a file to run");
    }
    print!("{HELP}");
    Command::Exit(0)
}

// Referenced so the linker keeps the host-engine exports (docs/engine-browser.md).
#[cfg(feature = "engine-host")]
#[used]
static KEEP_HOST_ENGINE: [extern "C" fn() -> i32; 2] = [
    bunwasm_runtime::engine_host::bunwasm_ready,
    bunwasm_runtime::engine_host::bunwasm_describe,
];
#[cfg(feature = "engine-host")]
#[used]
static KEEP_HOST_CALL: (
    extern "C" fn(u32) -> *mut u8,
    unsafe extern "C" fn(u32, *mut u8, u32) -> i32,
    extern "C" fn() -> *const u8,
    extern "C" fn() -> u32,
) = (
    bunwasm_runtime::engine_host::bunwasm_alloc,
    bunwasm_runtime::engine_host::bunwasm_call,
    bunwasm_runtime::engine_host::bunwasm_result_ptr,
    bunwasm_runtime::engine_host::bunwasm_result_len,
);

// Referenced so the linker keeps the exported slot table (docs/host-abi.md).
#[used]
static KEEP_HOST_SLOTS: extern "C" fn() -> *mut bunwasm_runtime::host::HostSlots =
    bunwasm_runtime::host::bun_wasm_host_slots;

fn main() {
    // Sets the parser's stack limit and keeps Bun's C/POSIX shims linked.
    #[cfg(all(
        any(feature = "bun-transpiler", feature = "bun-build"),
        target_os = "wasi"
    ))]
    bunwasm_glue::init();

    // WASI has no working directory of its own; hosts pass the intended one
    // as $PWD (the browser host and scripts/test.sh do).
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }

    let mut argv = std::env::args();
    let executable = argv.next().unwrap_or_default();
    let args = if executable
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".wasm")
        == "bunx"
    {
        std::iter::once("x".to_owned()).chain(argv).collect()
    } else {
        argv.collect()
    };
    let command = parse(args, &executable);
    let (entry, args, conditions, exec_argv) = match command {
        Command::Exit(code) => std::process::exit(code),
        Command::Lint => {
            eprintln!("error: bun lint/fmt requires a host that loads dist/bun-tools.wasm");
            std::process::exit(1);
        }
        Command::Build(args) => std::process::exit(build(args)),
        Command::Install(command, args) => std::process::exit(bunwasm_runtime::install::run(
            &command,
            args,
            transpiler().as_ref(),
        )),
        Command::Init(args) => {
            std::process::exit(bunwasm_runtime::init::run(args, transpiler().as_ref()))
        }
        Command::X(args) => {
            match bunwasm_runtime::install::prepare_x(args, transpiler().as_ref()) {
                Ok((file, args)) => (Entry::File(file), args, Vec::new(), Vec::new()),
                Err(error) => {
                    eprintln!("error: {error}");
                    std::process::exit(1);
                }
            }
        }
        Command::Run(entry, args, conditions, exec_argv) => (entry, args, conditions, exec_argv),
    };
    let code = bunwasm_runtime::run(Options {
        entry,
        args,
        conditions,
        exec_argv,
        transpiler: transpiler(),
    });
    // The host engine runs the program after `_start` returns.
    if code == 0 && bunwasm_runtime::host_engine_ready() {
        return;
    }
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditions_reach_every_runtime_entry_mode() {
        for mode in ["-e", "-p", "--eval", "--print", "test", "entry.ts"] {
            let command = parse_command(
                vec![
                    "--conditions=custom".into(),
                    mode.into(),
                    "require('p')".into(),
                ],
                false,
            );
            let Command::Run(_, _, conditions, exec_argv) = command else {
                panic!("{mode} discarded runtime flags");
            };
            assert_eq!(conditions, ["custom"], "{mode}");
            assert_eq!(exec_argv, ["--conditions=custom"], "{mode}");
        }
    }

    #[test]
    fn conditions_parse_in_order_and_preserve_exec_argv_shape() {
        let command = parse_command(
            vec![
                "run".into(),
                "--conditions".into(),
                "first".into(),
                "--conditions=second".into(),
                "entry.ts".into(),
                "arg".into(),
            ],
            false,
        );
        let Command::Run(Entry::File(entry), args, conditions, exec_argv) = command else {
            panic!("expected a file command");
        };
        assert_eq!(entry, "entry.ts");
        assert_eq!(args, ["arg"]);
        assert_eq!(conditions, ["first", "second"]);
        assert_eq!(exec_argv, ["--conditions", "first", "--conditions=second"]);
    }

    #[test]
    fn conditions_work_for_node_file_operands() {
        let command = node_command(vec!["--conditions=vitest".into(), "entry.ts".into()]);
        let Command::Run(Entry::File(entry), _, conditions, exec_argv) = command else {
            panic!("expected a node file command");
        };
        assert!(entry.ends_with("/entry.ts"));
        assert_eq!(conditions, ["vitest"]);
        assert_eq!(exec_argv, ["--conditions=vitest"]);
    }
}
