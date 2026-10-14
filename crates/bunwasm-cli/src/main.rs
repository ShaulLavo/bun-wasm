//! `bun` for wasm32-wasip1: argument parsing and wiring of the transpiler
//! into the runtime.

use bunwasm_runtime::{Entry, Options, Transpiler};

const HELP: &str = "\
Bun is a fast JavaScript runtime. This is bun.wasm: Bun's runtime on WebAssembly (WASI).

Usage: bun <command> [...flags] [...args]

Commands:
  run       ./my-script.ts       Execute a file with Bun
  test      [filters]            Run unit tests with Bun's test runner
  <file>                         Same as `bun run <file>`
  -e, --eval <code>              Evaluate JavaScript source code
  -p, --print <code>             Evaluate and print the result

Flags:
  -v, --version                  Print version and exit
      --revision                 Print version with revision and exit
  -h, --help                     Display this menu and exit

Not available in bun.wasm: install, add, build, x, create, upgrade.
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
    use bunwasm_runtime::{Loader, Transpiler};
    use bunwasm_transpiler::Loader as BunLoader;

    /// Bun's real parser and printer (crates/bunwasm-transpiler).
    ///
    /// Plain JavaScript skips it: QuickJS runs it as is, and the original
    /// line numbers then show up in stack traces (the printer reformats code
    /// and there are no source maps yet).
    pub struct BunTranspiler;

    impl Transpiler for BunTranspiler {
        fn transpile(&self, source: &str, path: &str, loader: Loader) -> Result<String, String> {
            let loader = match loader {
                Loader::Js => return Ok(source.to_owned()),
                Loader::Jsx => BunLoader::Jsx,
                Loader::Ts => BunLoader::Ts,
                Loader::Tsx => BunLoader::Tsx,
                Loader::Json => BunLoader::Json,
                Loader::Toml => BunLoader::Toml,
                Loader::Text => BunLoader::Text,
            };
            bunwasm_transpiler::transpile(source, path, loader)
        }
    }
}

enum Command {
    Run(Entry, Vec<String>),
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

fn main() {
    // Sets the parser's stack limit and keeps Bun's C/POSIX shims linked.
    #[cfg(all(feature = "bun-transpiler", target_os = "wasi"))]
    bunwasm_glue::init();

    // WASI has no working directory of its own; hosts pass the intended one
    // as $PWD (the browser host and scripts/test.sh do).
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }

    let command = parse(std::env::args().skip(1).collect());
    let (entry, args) = match command {
        Command::Exit(code) => std::process::exit(code),
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
    std::process::exit(code);
}
