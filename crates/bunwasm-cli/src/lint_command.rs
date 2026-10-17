//! Bun's lint/format drivers, with the WASI process environment.

#[cfg(target_os = "wasi")]
extern crate bunwasm_lint_native;

use std::io::Write;
use std::path::Path;

use bun_lint_driver::{Environment, Outcome, Script, Stream, bunfig, cli, fmt, git, js_plugin};
use bunwasm_runtime::host;

#[path = "../../../vendor/bun/src/runtime/cli/typescript_libs.rs"]
mod typescript_libs;

pub(super) fn before_command(args: &[String]) -> Option<super::Command> {
    let mut forwarded = Vec::new();
    let mut bunfig = None;
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        match arg.as_str() {
            "lint" | "fmt" => {
                forwarded.extend_from_slice(&args[at + 1..]);
                return Some(super::Command::Lint(arg.clone(), forwarded, bunfig));
            }
            "--cwd" => {
                forwarded.push(arg.clone());
                at += 1;
                forwarded.push(args.get(at)?.clone());
            }
            "--smol" | "--silent" | "--no-install" | "--bun" => {}
            "-e" | "--eval" | "-p" | "--print" | "-v" | "--version" | "--revision" => return None,
            flag if flag.starts_with("--config=") || flag.starts_with("-c=") => {
                bunfig = Some(flag.split_once('=')?.1.to_owned());
            }
            flag if flag.starts_with('-') => forwarded.push(arg.clone()),
            _ => return None,
        }
        at += 1;
    }
    None
}

pub fn run(command: &str, args: Vec<String>, bunfig: Option<String>) -> i32 {
    let argv: Vec<&[u8]> = args.iter().map(|arg| arg.as_bytes()).collect();
    match execute(command, &argv, bunfig.as_deref()) {
        Ok(outcome) => {
            let _ = std::io::stdout().write_all(&outcome.stdout);
            let _ = std::io::stderr().write_all(&outcome.stderr);
            i32::from(outcome.exit_code)
        }
        Err(message) => {
            eprintln!("error: {}", String::from_utf8_lossy(&message));
            eprintln!("note: run 'bun {command} --help' for more information");
            2
        }
    }
}

fn execute(command: &str, args: &[&[u8]], bunfig: Option<&str>) -> Result<Outcome, Vec<u8>> {
    let (cwd, help, all) = match command {
        "lint" => {
            let options = cli::Options::parse(args).map_err(|err| err.0)?;
            (options.cwd, options.help, options.all)
        }
        _ => {
            let options = fmt::cli::Options::parse(args).map_err(|err| err.0)?;
            (options.cwd, options.help, options.all)
        }
    };
    if help {
        print_help(command, all);
        return Ok(Outcome::default());
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
    let command_line = std::iter::once(command.as_bytes())
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
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
    let (lint, format) = read_bunfigs(Path::new(cwd.as_ref()), command == "lint", bunfig)?;
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

fn read_bunfigs(
    cwd: &Path,
    linting: bool,
    named: Option<&str>,
) -> Result<(Option<cli::Options>, Option<fmt::cli::Options>), Vec<u8>> {
    let (mut lint, mut format) = (None, None);
    let paths = match named {
        Some(path) => vec![cwd.join(path)],
        None => cwd
            .ancestors()
            .map(|directory| directory.join("bunfig.toml"))
            .collect(),
    };
    for path in paths {
        let text = match std::fs::read(&path) {
            Ok(text) => text,
            Err(error) if named.is_none() && error.kind() == std::io::ErrorKind::NotFound => {
                continue;
            }
            Err(error) => return Err(error.to_string().into_bytes()),
        };
        let arena = bun_alloc::Arena::new();
        let mut ast = bun_ast::ASTMemoryAllocator::borrowing(&arena);
        let _scope = ast.enter();
        let mut log = bun_ast::Log::init();
        let path = path.to_string_lossy();
        let source = bun_ast::Source::init_path_string(path.as_bytes(), text.as_slice());
        let file = bun_parsers::toml::TOML::parse(&source, &mut log, &arena, false)
            .map_err(|_| format!("failed to parse {path}").into_bytes())?;
        let refusal = |error: bunfig::Refusal| {
            format!("{path}: {}", String::from_utf8_lossy(&error.message)).into_bytes()
        };
        if linting && lint.is_none() {
            lint = bunfig::lint(&file).map_err(refusal)?.map(|options| {
                options.of_bunfig_at(
                    path.as_bytes(),
                    named.is_some(),
                    cwd.as_os_str().as_encoded_bytes(),
                )
            });
        }
        if format.is_none() {
            format = bunfig::format(&file)
                .map_err(refusal)?
                .map(|options| options.of_bunfig_at(path.as_bytes(), named.is_some()));
        }
        if format.is_some() && (!linting || lint.is_some()) {
            break;
        }
    }
    Ok((lint, format))
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
        "executable": "bun",
        "argv": ["bun", "--no-install", "-e", source],
        "cwd": cwd,
        "env": variables,
        "stdin": "ignore", "stdout": "pipe", "stderr": "pipe",
    });
    let handle = host::spawn(meta.to_string().as_bytes());
    if handle < 0 {
        return Err(
            b"Cannot start a configuration process: host subprocess support is required".to_vec(),
        );
    }
    let mut child = Child {
        handle,
        pipes: [host::child_pipe(handle, 1), host::child_pipe(handle, 2)],
    };
    let mut output = [Vec::new(), Vec::new()];
    let mut status = host::AGAIN;
    while status == host::AGAIN || child.pipes.iter().any(|pipe| *pipe > 0) {
        for (pipe, bytes) in child.pipes.iter_mut().zip(output.iter_mut()) {
            drain(pipe, bytes)?;
        }
        status = host::child_wait(handle);
        if status < 0 && status != host::AGAIN {
            return Err(b"Configuration process failed".to_vec());
        }
        if status == host::AGAIN || child.pipes.iter().any(|pipe| *pipe > 0) {
            host::poll(10);
        }
    }
    let [stdout, stderr] = output;
    if status == 0 { Ok(stdout) } else { Err(stderr) }
}

fn drain(pipe: &mut i32, bytes: &mut Vec<u8>) -> Result<(), Vec<u8>> {
    if *pipe <= 0 {
        return Ok(());
    }
    match host::read(*pipe, 65536) {
        Ok(chunk) if !chunk.is_empty() => bytes.extend_from_slice(&chunk),
        Err(host::AGAIN) => {}
        Ok(_) => {
            host::close(*pipe);
            *pipe = 0;
        }
        Err(_) => return Err(b"Cannot read configuration process output".to_vec()),
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
