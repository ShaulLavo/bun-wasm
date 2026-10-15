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
  pm ls                          List installed dependencies
  <file>                         Same as `bun run <file>`
  -e, --eval <code>              Evaluate JavaScript source code
  -p, --print <code>             Evaluate and print the result

Flags:
  -v, --version                  Print version and exit
      --revision                 Print version with revision and exit
  -h, --help                     Display this menu and exit

Not available in bun.wasm: x, create, upgrade.
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

    /// Bun's real parser and printer (crates/bunwasm-transpiler).
    ///
    /// Plain JavaScript skips it: QuickJS runs it as is, and the original
    /// line numbers then show up in stack traces (the printer reformats code
    /// and there are no source maps yet).
    pub struct BunTranspiler;

    impl Transpiler for BunTranspiler {
        fn parse_data(&self, source: &[u8], format: &str) -> Result<String, bunwasm_runtime::engine::NativeError> {
            use bunwasm_runtime::engine::NativeError;
            use bunwasm_transpiler::data::Error;
            bunwasm_transpiler::data::parse(source, format).map_err(|e| match e {
                Error::Syntax(message) => NativeError::syntax_error(message),
                Error::Range(message) => NativeError::range_error(message),
            })
        }

        fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String> {
            self.transpile_with_map(source, path, loader).map(|out| out.code)
        }

        fn transpile_with_map(&self, source: &str, path: &str, loader: Loader) -> Result<Transpiled, String> {
            let loader = match loader {
                // The browser engine needs every `await` printed with its
                // AsyncLocalStorage hooks, plain JavaScript included.
                Loader::Js if AWAIT_HOOKS && source.contains("await") => BunLoader::Js,
                Loader::Js => return Ok(Transpiled { code: source.to_owned(), mappings: None }),
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
            let out = bunwasm_transpiler::with_await_hooks(AWAIT_HOOKS, || {
                bunwasm_transpiler::transpile_with_source_map(source, path, loader)
            })?;
            Ok(Transpiled { code: out.code, mappings: Some(out.mappings) })
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
            let out = bunwasm_transpiler::with_await_hooks(AWAIT_HOOKS, || bunwasm_build::build(&args))
                .map_err(|log| log.trim_end().to_owned())?;
            let code = out.stdout.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
            if code.is_empty() {
                return Err(format!("bun build produced no output for {path}"));
            }
            const MARK: &str = "\n//# sourceMappingURL=data:application/json;base64,";
            let (code, mappings) = match code.rfind(MARK) {
                Some(at) => {
                    let map = base64_decode(code[at + MARK.len()..].trim_end());
                    (code[..at].to_owned(), map.and_then(|json| json_string_field(&json, "mappings")))
                }
                None => (code, None),
            };
            Ok(Transpiled { code, mappings })
        }

        #[cfg(feature = "bun-build")]
        fn build(&self, request: &bunwasm_runtime::BuildRequest) -> Result<bunwasm_runtime::BuildResult, String> {
            build(request)
        }
    }

    /// `Bun.build`: the options map onto `bun build`'s flags. Without an
    /// `outdir` nothing is written: the outputs only come back in memory,
    /// named `./<name>.js` like native Bun's.
    #[cfg(feature = "bun-build")]
    pub(super) fn build(request: &bunwasm_runtime::BuildRequest) -> Result<bunwasm_runtime::BuildResult, String> {
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
            let entry = request.entrypoints.first().map(String::as_str).unwrap_or("out");
            let base = entry.rsplit('/').next().unwrap_or(entry);
            let stem = base.rsplit_once('.').map_or(base, |(stem, _)| stem);
            outputs.push(BuildArtifact { path: format!("./{stem}.js"), kind: "entry-point", contents: bytes });
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
                    let contents = if file.contents.is_empty() { std::fs::read(&path).unwrap_or_default() } else { file.contents };
                    (path, contents)
                }
                None => (format!("./{relative}"), file.contents),
            };
            outputs.push(BuildArtifact { path, kind, contents });
        }
        if let Some(err) = out.write_errors.first() {
            return Err(err.clone());
        }
        Ok(BuildResult { outputs, logs: out.log })
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
        let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
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

enum Command {
    Run(Entry, Vec<String>),
    Build(Vec<String>),
    Install(String, Vec<String>),
    Print(String),
    Exit(i32),
}

fn usage_error(message: &str) -> Command {
    eprintln!("error: {message}\n");
    eprint!("{HELP}");
    Command::Exit(1)
}

fn parse(args: Vec<String>) -> Command {
    let mut rest = args.into_iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "-v" | "--version" => {
                println!("{}", bunwasm_runtime::BUN_VERSION);
                return Command::Exit(0);
            }
            "--revision" => {
                let short = &bunwasm_runtime::BUN_REVISION[..bunwasm_runtime::BUN_REVISION.len().min(9)];
                println!("{}+{short}", bunwasm_runtime::BUN_VERSION);
                return Command::Exit(0);
            }
            "-h" | "--help" | "help" => {
                print!("{HELP}");
                return Command::Exit(0);
            }
            "-e" | "--eval" => {
                let Some(code) = rest.next() else { return usage_error("--eval requires code") };
                return Command::Run(Entry::Eval(code), rest.collect());
            }
            "-p" | "--print" => {
                let Some(code) = rest.next() else { return usage_error("--print requires code") };
                return Command::Print(code);
            }
            "test" => return Command::Run(Entry::Test(rest.collect()), Vec::new()),
            "build" | "bun" => return Command::Build(rest.collect()),
            "install" | "i" | "ci" | "add" | "a" | "remove" | "rm" | "r" | "uninstall" | "pm" =>
                return Command::Install(arg, rest.collect()),
            "x" | "bunx" | "create" | "c" | "init" | "update" | "upgrade" | "link" | "unlink"
            | "outdated" | "publish" | "patch" | "patch-commit" | "repl" | "info" | "why"
            | "audit" | "completions" | "getcompletes" | "discord" | "exec" | "up" | "dedupe" | "prune" | "check" | "lint" | "fmt"
            | "deploy" | "cloud" | "config" | "use" | "auth" | "login" | "logout" => {
                eprintln!("error: bun {arg} is not supported in bun-wasm");
                return Command::Exit(1);
            }
            "run" => {
                let Some(file) = rest.next() else { return usage_error("bun run needs a file to run") };
                return Command::Run(Entry::File(file), rest.collect());
            }
            // Flags native Bun accepts that change nothing here.
            "--bun" | "--silent" | "--smol" | "--no-install" => continue,
            flag if flag.starts_with('-') => return usage_error(&format!("unknown flag {flag}")),
            file => return Command::Run(Entry::File(file.to_owned()), rest.collect()),
        }
    }
    print!("{HELP}");
    Command::Exit(0)
}

// Referenced so the linker keeps the host-engine exports (docs/engine-browser.md).
#[cfg(feature = "engine-host")]
#[used]
static KEEP_HOST_ENGINE: [extern "C" fn() -> i32; 2] =
    [bunwasm_runtime::engine_host::bunwasm_ready, bunwasm_runtime::engine_host::bunwasm_describe];
#[cfg(feature = "engine-host")]
#[used]
static KEEP_HOST_CALL: (extern "C" fn(u32) -> *mut u8, unsafe extern "C" fn(u32, *mut u8, u32) -> i32, extern "C" fn() -> *const u8, extern "C" fn() -> u32) = (
    bunwasm_runtime::engine_host::bunwasm_alloc,
    bunwasm_runtime::engine_host::bunwasm_call,
    bunwasm_runtime::engine_host::bunwasm_result_ptr,
    bunwasm_runtime::engine_host::bunwasm_result_len,
);

// Referenced so the linker keeps the exported slot table (docs/host-abi.md).
#[used]
static KEEP_HOST_SLOTS: extern "C" fn() -> *mut bunwasm_runtime::host::HostSlots = bunwasm_runtime::host::bun_wasm_host_slots;

fn main() {
    // Sets the parser's stack limit and keeps Bun's C/POSIX shims linked.
    #[cfg(all(any(feature = "bun-transpiler", feature = "bun-build"), target_os = "wasi"))]
    bunwasm_glue::init();

    // WASI has no working directory of its own; hosts pass the intended one
    // as $PWD (the browser host and scripts/test.sh do).
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }

    let command = parse(std::env::args().skip(1).collect());
    let (entry, args) = match command {
        Command::Exit(code) => std::process::exit(code),
        Command::Build(args) => std::process::exit(build(args)),
        Command::Install(command, args) => std::process::exit(
            bunwasm_runtime::install::run(&command, args, transpiler().as_ref())
        ),
        Command::Run(entry, args) => (entry, args),
        // `-p`: evaluate an expression and print it like Bun.
        Command::Print(code) => {
            let wrapped = format!(
                "const __bunwasm_print = await (0, eval)({code:?}); \
                 console.log(typeof __bunwasm_print === 'string' ? __bunwasm_print : Bun.inspect(__bunwasm_print));"
            );
            (Entry::Eval(wrapped), Vec::new())
        }
    };
    let code = bunwasm_runtime::run(Options { entry, args, transpiler: transpiler() });
    // The host engine runs the program after `_start` returns.
    if code == 0 && bunwasm_runtime::host_engine_ready() {
        return;
    }
    std::process::exit(code);
}
