//! Bun's lint/format drivers, with the WASI process environment.

#[cfg(target_os = "wasi")]
extern crate bunwasm_lint_native;

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use bun_lint_driver::{Environment, Outcome, Script, Stream, bunfig, cli, fmt, git, js_plugin};
use bunwasm_runtime::host;

#[path = "../../../vendor/bun/src/runtime/cli/typescript_libs.rs"]
mod typescript_libs;

pub(super) fn before_command(args: &[String]) -> Option<super::Command> {
    let mut forwarded = Vec::new();
    let mut globals = super::ToolGlobals::default();
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        match arg.as_str() {
            "lint" | "fmt" => {
                forwarded.extend_from_slice(&args[at + 1..]);
                return Some(super::Command::Lint(arg.clone(), forwarded, globals));
            }
            "--cwd" => {
                at += 1;
                globals.cwd_before = Some(args.get(at)?.clone());
            }
            flag if flag.starts_with("--cwd=") => {
                globals.cwd_before = Some(flag.split_once('=')?.1.to_owned());
            }
            "--smol" | "--silent" | "--no-install" | "--bun" => {}
            "-e" | "--eval" | "-p" | "--print" | "-v" | "--version" | "--revision" => return None,
            flag if flag.starts_with("--config=") || flag.starts_with("-c=") => {
                globals.bunfig = Some(flag.split_once('=')?.1.to_owned());
            }
            flag if flag.starts_with('-') => forwarded.push(arg.clone()),
            _ => return None,
        }
        at += 1;
    }
    None
}

enum CommandError {
    Usage(Vec<u8>),
    Config(Vec<u8>),
}

impl From<Vec<u8>> for CommandError {
    fn from(message: Vec<u8>) -> Self {
        Self::Usage(message)
    }
}

fn configure_output() {
    use bun_core::Output;
    use std::sync::atomic::Ordering;
    let force = bun_core::env_var::FORCE_COLOR
        .get()
        .is_some_and(|value| value > 0);
    let disabled = bun_core::env_var::NO_COLOR.get().unwrap_or(false);
    let color = if force {
        Some(true)
    } else if disabled {
        Some(false)
    } else {
        None
    };
    Output::ENABLE_ANSI_COLORS_STDOUT
        .store(color.unwrap_or(Output::is_stdout_tty()), Ordering::Relaxed);
    Output::ENABLE_ANSI_COLORS_STDERR
        .store(color.unwrap_or(Output::is_stderr_tty()), Ordering::Relaxed);
}

pub(super) fn run(command: &str, args: Vec<String>, globals: super::ToolGlobals) -> i32 {
    configure_output();
    let argv: Vec<&[u8]> = args.iter().map(|arg| arg.as_bytes()).collect();
    match execute(command, &argv, &globals) {
        Ok(outcome) => {
            let _ = std::io::stdout().write_all(&outcome.stdout);
            let _ = std::io::stderr().write_all(&outcome.stderr);
            i32::from(outcome.exit_code)
        }
        Err(CommandError::Config(message)) => {
            let _ = std::io::stderr().write_all(&message);
            2
        }
        Err(CommandError::Usage(message)) => {
            eprintln!("error: {}", String::from_utf8_lossy(&message));
            eprintln!("note: run 'bun {command} --help' for more information");
            2
        }
    }
}

fn execute(
    command: &str,
    args: &[&[u8]],
    globals: &super::ToolGlobals,
) -> Result<Outcome, CommandError> {
    let (cwd, help, all, format_required) = match command {
        "lint" => {
            let options = cli::Options::parse(args).map_err(|err| err.0)?;
            let format_required = options.names_a_format_rule();
            (options.cwd, options.help, options.all, format_required)
        }
        _ => {
            let options = fmt::cli::Options::parse(args).map_err(|err| err.0)?;
            (options.cwd, options.help, options.all, false)
        }
    };
    if help {
        print_help(command, all);
        return Ok(Outcome::default());
    }
    if let Some(cwd) = globals.cwd_before.as_deref() {
        std::env::set_current_dir(cwd).map_err(|err| err.to_string().into_bytes())?;
    }
    if let Some(cwd) = cwd {
        let cwd = std::str::from_utf8(&cwd).map_err(|err| err.to_string().into_bytes())?;
        std::env::set_current_dir(cwd).map_err(|err| err.to_string().into_bytes())?;
    }
    let cwd = std::env::current_dir().map_err(|err| err.to_string().into_bytes())?;
    let cwd = cwd.to_string_lossy();
    bun_paths::fs::FileSystem::init(cwd.as_bytes());
    // WASI preview 1 has one thread. This also keeps nested parser regions off Bun's worker pool.
    bun_sema_driver::keep_regions_on_this_thread();
    let process_args: Vec<String> = std::env::args().skip(1).collect();
    let command_line: Vec<&[u8]> = process_args.iter().map(|arg| arg.as_bytes()).collect();
    let environment = Environment {
        cwd: bun_lint_driver::from_native_path(cwd.as_bytes()),
        stdout: Stream {
            is_tty: bun_core::Output::is_stdout_tty(),
            colors: bun_core::Output::enable_ansi_colors_stdout(),
        },
        stderr: Stream {
            is_tty: bun_core::Output::is_stderr_tty(),
            colors: bun_core::Output::enable_ansi_colors_stderr(),
        },
        columns: || 80,
        is_ai_agent: bun_core::Output::is_ai_agent(),
        is_github_action: bun_core::Output::is_github_action(),
        libs: bun_sema_driver::Libs::Bundled(typescript_libs::BUNDLED),
        run_script: &run_script,
        run_git: &|_| Err(git::NotRun::NotFound),
        command_line: &command_line,
        js_engine: &NativeRules,
        version: bunwasm_runtime::BUN_VERSION.as_bytes(),
        memory: 0,
    };
    let (lint, format) = read_bunfigs(
        Path::new(cwd.as_ref()),
        command == "lint",
        globals.bunfig.as_deref(),
        format_required,
    )?;
    if command == "fmt" {
        let options = match format {
            Some(defaults) => fmt::cli::Options::parse_over(defaults, args),
            None => fmt::cli::Options::parse(args),
        }
        .map_err(|err| err.0)?;
        return Ok(fmt::run(&options, &environment));
    }
    let mut defaults = lint.unwrap_or_default();
    defaults.of_bun_format = format.map(Box::new);
    let options = cli::Options::parse_over(defaults, args).map_err(|err| err.0)?;
    Ok(bun_lint_driver::run(&options, &environment))
}

fn config_error(log: &bun_ast::Log) -> CommandError {
    let mut message = String::new();
    log.print(&mut message)
        .expect("formatting diagnostics into a String");
    CommandError::Config(message.into_bytes())
}

fn config_refusal(source: &bun_ast::Source, refusal: bunfig::Refusal) -> CommandError {
    let mut log = bun_ast::Log::init();
    log.add_error(Some(source), refusal.at, refusal.message);
    config_error(&log)
}

fn read_bunfigs(
    cwd: &Path,
    linting: bool,
    named: Option<&str>,
    format_required: bool,
) -> Result<(Option<cli::Options>, Option<fmt::cli::Options>), CommandError> {
    let mut search = BunfigSearch {
        cwd,
        linting,
        named: named.is_some(),
        format_required,
        lint: None,
        format: None,
    };
    let paths = match named {
        Some(path) => vec![(cwd.join(path), path.to_owned())],
        None => cwd
            .ancestors()
            .enumerate()
            .map(|(depth, directory)| {
                (
                    directory.join("bunfig.toml"),
                    format!("{}bunfig.toml", "../".repeat(depth)),
                )
            })
            .collect(),
    };
    let mut above = Above::Needed;
    for (depth, (path, label)) in paths.into_iter().enumerate() {
        if let Err(error) = search.read(&path, &label) {
            if depth > 0 && above == Above::Optional {
                break;
            }
            return Err(error);
        }
        above = search.above();
        if above == Above::Unwanted {
            break;
        }
    }
    Ok((search.lint, search.format))
}

#[derive(PartialEq)]
enum Above {
    Needed,
    Optional,
    Unwanted,
}

struct BunfigSearch<'a> {
    cwd: &'a Path,
    linting: bool,
    named: bool,
    format_required: bool,
    lint: Option<cli::Options>,
    format: Option<fmt::cli::Options>,
}

impl BunfigSearch<'_> {
    fn above(&self) -> Above {
        if !self.linting {
            return if self.format.is_some() {
                Above::Unwanted
            } else {
                Above::Needed
            };
        }
        match (&self.lint, &self.format) {
            (Some(_), Some(_)) => Above::Unwanted,
            (Some(options), None) if options.names_a_format_rule() || self.format_required => {
                Above::Needed
            }
            (Some(_), None) => Above::Optional,
            (None, _) => Above::Needed,
        }
    }

    fn read(&mut self, path: &Path, label: &str) -> Result<(), CommandError> {
        let text = match std::fs::read(&path) {
            Ok(text) => text,
            Err(error) if !self.named && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => {
                return Err(CommandError::Config(
                    format!("error: Cannot read {label}: {error}\n").into_bytes(),
                ));
            }
        };
        let arena = bun_alloc::Arena::new();
        let mut ast = bun_ast::ASTMemoryAllocator::borrowing(&arena);
        let _scope = ast.enter();
        let mut log = bun_ast::Log::init();
        let source = bun_ast::Source::init_path_string(label.as_bytes(), text.as_slice());
        let file = bun_parsers::toml::TOML::parse(&source, &mut log, &arena, false)
            .map_err(|_| config_error(&log))?;
        let refusal = |error| config_refusal(&source, error);
        if self.linting && self.lint.is_none() {
            self.lint = bunfig::lint(&file).map_err(refusal)?.map(|options| {
                options.of_bunfig_at(
                    label.as_bytes(),
                    self.named,
                    self.cwd.as_os_str().as_encoded_bytes(),
                )
            });
        }
        if self.format.is_none() {
            self.format = bunfig::format(&file)
                .map_err(refusal)?
                .map(|options| options.of_bunfig_at(label.as_bytes(), self.named));
        }
        Ok(())
    }
}

fn print_help(command: &str, all: bool) {
    let (help, description, examples, documentation) = if command == "lint" {
        (
            &cli::HELP,
            "Find and fix problems in JavaScript and TypeScript.",
            "  bun lint\n  bun lint --fix src\n  bun lint --rule 'no-console: error'\n",
            "lint",
        )
    } else {
        (
            &fmt::cli::HELP,
            "Format JavaScript, TypeScript, CSS, HTML, JSON, YAML, Markdown and more.",
            "  bun fmt\n  bun fmt src test/a.test.ts\n  bun fmt --check\n",
            "format",
        )
    };
    bun_core::pretty!(
        "Usage: bun {} [flags] [...files, directories or patterns]\n  {}\n",
        command,
        description
    );
    if all {
        for group in help.groups {
            bun_core::pretty!("\n{}:", group.title);
            bun_clap::simple_help(group.params);
            bun_core::pretty!("\n");
        }
    } else {
        bun_core::pretty!("\nFlags:");
        bun_clap::simple_help(&help.common());
        bun_core::pretty!("\n");
    }
    bun_core::pretty!(
        "\nExamples:\n{}\nFull documentation is available at https://bun.com/docs/{}\n",
        examples,
        documentation
    );
    if !all {
        bun_core::pretty!("See every flag with bun {} --help --all\n", command);
    }
    bun_core::Output::flush();
}

fn run_script(script: &Script) -> Result<Vec<u8>, Vec<u8>> {
    let mut source = script.head.to_vec();
    for part in script.source {
        source.extend_from_slice(part.text());
        source.push(b'\n');
    }
    let source = String::from_utf8(source).map_err(|err| err.to_string().into_bytes())?;
    let cwd = std::str::from_utf8(script.cwd).map_err(|err| err.to_string().into_bytes())?;
    let variables: std::collections::HashMap<_, _> = std::env::vars()
        .filter(|(name, _)| !Script::NOT_INHERITED.contains(&name.as_bytes()))
        .collect();
    let meta = serde_json::json!({
        "purpose": "configuration",
        "executable": "bun",
        "argv": ["bun", "--no-install", "-e", source],
        "cwd": cwd,
        "env": variables,
        "stdin": "ignore", "stdout": "pipe", "stderr": "pipe",
    });
    let handle = host::spawn(meta.to_string().as_bytes());
    if handle < 0 {
        return Err(process_error(
            "Could not start a configuration process",
            handle,
            0,
        ));
    }
    let mut child = Child {
        handle,
        pipes: [host::child_pipe(handle, 1), host::child_pipe(handle, 2)],
    };
    let mut output = [Vec::new(), Vec::new()];
    let mut budget = EvaluationBudget {
        started: Instant::now(),
        bytes: 0,
    };
    let mut status = host::AGAIN;
    while status == host::AGAIN || child.pipes.iter().any(|pipe| *pipe > 0) {
        budget.check_time()?;
        for (pipe, bytes) in child.pipes.iter_mut().zip(output.iter_mut()) {
            drain(pipe, bytes, &mut budget)?;
        }
        status = host::child_wait(handle);
        if status < 0 && status != host::AGAIN {
            return Err(process_error(
                "Configuration process failed",
                status,
                handle,
            ));
        }
        if status == host::AGAIN || child.pipes.iter().any(|pipe| *pipe > 0) {
            host::poll(10);
        }
    }
    let [stdout, stderr] = output;
    if status == 0 { Ok(stdout) } else { Err(stderr) }
}

struct EvaluationBudget {
    started: Instant,
    bytes: usize,
}

impl EvaluationBudget {
    fn check_time(&self) -> Result<(), Vec<u8>> {
        if self.started.elapsed() >= Duration::from_secs(5) {
            return Err(b"Configuration evaluation exceeded 5 seconds".to_vec());
        }
        Ok(())
    }

    fn add_output(&mut self, bytes: usize) -> Result<(), Vec<u8>> {
        self.bytes += bytes;
        if self.bytes > 8 * 1024 * 1024 {
            return Err(
                b"Configuration evaluation exceeded 8 MiB of combined stdout and stderr".to_vec(),
            );
        }
        Ok(())
    }
}

fn process_error(context: &str, code: i32, handle: i32) -> Vec<u8> {
    if code == host::UNSUPPORTED {
        return format!("{context}: host subprocess support is not provided").into_bytes();
    }
    let details = host::error(handle)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let message = details
        .as_ref()
        .and_then(|error| error["message"].as_str())
        .unwrap_or("host process error");
    let name = details
        .as_ref()
        .and_then(|error| error["code"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| code.to_string());
    format!("{context}: {name}: {message}").into_bytes()
}

fn drain(
    pipe: &mut i32,
    bytes: &mut Vec<u8>,
    budget: &mut EvaluationBudget,
) -> Result<(), Vec<u8>> {
    if *pipe <= 0 {
        return Ok(());
    }
    match host::read(*pipe, 65536) {
        Ok(chunk) if !chunk.is_empty() => {
            budget.add_output(chunk.len())?;
            bytes.extend_from_slice(&chunk);
        }
        Err(host::AGAIN) => {}
        Ok(_) => {
            host::close(*pipe);
            *pipe = 0;
        }
        Err(code) => {
            return Err(process_error(
                "Cannot read configuration process output",
                code,
                *pipe,
            ));
        }
    }
    Ok(())
}

struct Child {
    handle: i32,
    pipes: [i32; 2],
}

impl Drop for Child {
    fn drop(&mut self) {
        host::child_kill(self.handle, 9);
        for pipe in self.pipes {
            if pipe > 0 {
                host::close(pipe);
            }
        }
        while host::child_wait(self.handle) == host::AGAIN {
            host::poll(10);
        }
        host::close(self.handle);
    }
}

struct NativeRules;

impl js_plugin::Engine for NativeRules {
    fn is_here(&self) -> bool {
        false
    }
    fn with_vm_here(
        &self,
        _: usize,
        _: &mut dyn FnMut(&mut dyn js_plugin::Vm),
    ) -> Result<(), Vec<u8>> {
        Err(b"JavaScript lint plugins require Bun's native lint bindings, which are not yet ported to bun-wasm".to_vec())
    }
    fn with_vm(
        &self,
        size: usize,
        _: &mut (dyn FnMut(&mut dyn js_plugin::Vm) + Send),
    ) -> Result<(), Vec<u8>> {
        self.with_vm_here(size, &mut |_| {})
    }
    fn work_off(
        &self,
        work: &dyn js_plugin::Work,
        meanwhile: &mut dyn FnMut(),
    ) -> Result<(), Vec<u8>> {
        meanwhile();
        work.finish_here();
        Ok(())
    }
    fn busy(&self) -> usize {
        0
    }
}
