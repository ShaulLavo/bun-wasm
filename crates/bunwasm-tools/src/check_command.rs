//! `bun check`: Bun's TypeScript type checker (`bun_sema_driver`) on WASI.
//!
//! Adapted from upstream `src/runtime/cli/check_command.rs`; `docs/bun-patches/check-command.md`
//! records what changed. Argument parsing is by hand instead of `bun_clap`'s tables, the check runs
//! on this one thread, and a `check` script in `package.json` is not run first, as for `bun lint`.

use std::io::Write;

use bun_core::Output;
use bun_sema_driver::format::{self, Layout, Style};
use bun_sema_driver::host::Provided;
use bun_sema_driver::{CommandLine, FlagError, Libs, PlanOptions, RejectedFlag, Report, Request};

/// The arguments after `check`, before the compiler options are parsed. Those are parsed in the
/// directory that `--cwd` selects, which is where response files (`@args.rsp`) are read.
#[derive(Default)]
struct Flags {
    help: bool,
    all: bool,
    timing: bool,
    no_pretty: bool,
    build: bool,
    cwd: Option<String>,
    /// `-p`, `--project` and `--tsconfig-override` are one option. The last one wins.
    project: Option<String>,
    /// Compiler options, response files and paths, for `bun_sema_driver::parse_command_line`.
    rest: Vec<String>,
    /// After `--`: paths, even those that look like flags.
    paths: Vec<String>,
}

struct Options {
    command_line: CommandLine,
    /// `--pretty`, `--no-pretty`. If neither is given, it depends on the output destination.
    pretty: Option<bool>,
    /// `--all`: never group identical errors.
    all: bool,
    timing: bool,
}

/// The options that take a value, with their names as written after `--`.
const WITH_VALUE: &[&str] = &["cwd", "threads", "project", "tsconfig-override"];

/// Returns the flags, or the usage error to print.
fn parse_flags(args: &[String]) -> Result<Flags, String> {
    let mut flags = Flags::default();
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        at += 1;
        match arg.as_str() {
            "--" => {
                flags.paths.extend_from_slice(&args[at..]);
                break;
            }
            "--help" => flags.help = true,
            "--all" => flags.all = true,
            "--timing" => flags.timing = true,
            "--no-pretty" => flags.no_pretty = true,
            "--build" => flags.build = true,
            // Nothing is ever emitted, and no `check` script is run first.
            "--no-emit" | "--no-script" => {}
            _ => at = long_or_short(&mut flags, args, at, arg)?,
        }
    }
    Ok(flags)
}

/// Handles `arg`, the argument before `at`. Returns where the next argument is.
fn long_or_short(
    flags: &mut Flags,
    args: &[String],
    at: usize,
    arg: &str,
) -> Result<usize, String> {
    if let Some(long) = arg.strip_prefix("--") {
        let (name, value) = long
            .split_once('=')
            .map_or((long, None), |(name, value)| (name, Some(value)));
        if !WITH_VALUE.contains(&name) {
            flags.rest.push(arg.to_owned());
            return Ok(at);
        }
        let (value, at) = match value {
            Some(value) => (value, at),
            None => (
                args.get(at)
                    .ok_or_else(|| format!("--{name} needs a value"))?
                    .as_str(),
                at + 1,
            ),
        };
        take_value(flags, name, value)?;
        return Ok(at);
    }
    let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) else {
        flags.rest.push(arg.to_owned());
        return Ok(at);
    };
    // A compiler option with a short name stands alone, like `-t es2022`.
    let is_compiler_short = bun_sema_driver::SHORT_OPTION_NAMES
        .iter()
        .any(|(short, _)| *short == arg.as_bytes() && !matches!(arg, "-b" | "-p"));
    if is_compiler_short {
        flags.rest.push(arg.to_owned());
        return Ok(at);
    }
    short_chain(flags, args, at, shorts)
}

/// A chain of `bun check`'s own letters, as upstream's parser reads it: `-b`, `-h`, `-papp`,
/// `-bp app`. Any other letter is an error, even after `-h`, as is a `-p` without a value. Help
/// wins only over what is checked later: unknown long flags and compiler options.
fn short_chain(
    flags: &mut Flags,
    args: &[String],
    at: usize,
    shorts: &str,
) -> Result<usize, String> {
    for (index, letter) in shorts.char_indices() {
        match letter {
            'b' => flags.build = true,
            'h' => flags.help = true,
            'p' => return project_value(flags, args, at, &shorts[index + 1..]),
            _ => return Err(format!("Invalid Argument '-{letter}'")),
        }
    }
    Ok(at)
}

/// `-papp` and `-p=app` carry the value, and `-p=` an empty one. Otherwise it is the next argument.
fn project_value(
    flags: &mut Flags,
    args: &[String],
    at: usize,
    attached: &str,
) -> Result<usize, String> {
    if !attached.is_empty() {
        set_project(flags, attached.strip_prefix('=').unwrap_or(attached));
        return Ok(at);
    }
    let value = args
        .get(at)
        .ok_or("The argument '--project' requires a value but none was supplied.")?;
    set_project(flags, value);
    Ok(at + 1)
}

/// As upstream, a project given here, even an empty one (`--project=`, which the driver reads as
/// the working directory), replaces one from a response file.
fn set_project(flags: &mut Flags, value: &str) {
    flags.project = Some(value.to_owned());
}

fn take_value(flags: &mut Flags, name: &str, value: &str) -> Result<(), String> {
    match name {
        "cwd" => flags.cwd = Some(value.to_owned()),
        "project" | "tsconfig-override" => set_project(flags, value),
        // WASI preview 1 has one thread, so the count only has to be valid.
        _ => match value.parse::<usize>() {
            Ok(n) if n > 0 => {}
            _ => {
                return Err(format!(
                    "--threads takes a number above zero, not \"{value}\""
                ));
            }
        },
    }
    Ok(())
}

/// Parses the compiler options in `cwd`. Returns the options, or the usage error to print.
fn parse_options(flags: Flags, cwd: &[u8]) -> Result<Options, String> {
    let rest: Vec<&[u8]> = flags.rest.iter().map(|arg| arg.as_bytes()).collect();
    let mut command_line = bun_sema_driver::parse_command_line(&rest, cwd);
    if let Some(rejected) = command_line.rejected.first() {
        return Err(rejection(rejected));
    }
    command_line
        .paths
        .extend(flags.paths.into_iter().map(String::into_bytes));
    if let Some(project) = flags.project {
        command_line.project = Some(project.into_bytes());
    }
    command_line.build |= flags.build;
    let projects = usize::from(command_line.project.is_some()) + command_line.paths.len();
    if command_line.build && projects > 1 {
        return Err("--build takes one project".to_owned());
    }
    let pretty = match flags.no_pretty {
        true => Some(false),
        false => bun_sema_driver::tristate(&command_line.compiler_options, b"pretty"),
    };
    Ok(Options {
        command_line,
        pretty,
        all: flags.all,
        timing: flags.timing,
    })
}

fn rejection(rejected: &RejectedFlag) -> String {
    let flag = String::from_utf8_lossy(&rejected.flag);
    match &rejected.error {
        FlagError::Unknown => format!("Unknown flag \"{flag}\""),
        FlagError::NeedsValue => format!("{flag} needs a value"),
        FlagError::BadValue(allowed) if allowed.is_empty() => format!(
            "{flag} does not take \"{}\"",
            String::from_utf8_lossy(rejected.value.as_deref().unwrap_or_default())
        ),
        FlagError::BadValue(allowed) => {
            let allowed: Vec<_> = allowed
                .iter()
                .map(|it| String::from_utf8_lossy(it))
                .collect();
            format!("{flag} must be one of: {}", allowed.join(", "))
        }
    }
}

fn usage_error(message: &str) -> i32 {
    eprintln!("error: {message}");
    eprintln!("note: run 'bun check --help' for more information");
    1
}

fn current_dir() -> Result<Vec<u8>, i32> {
    match std::env::current_dir() {
        Ok(cwd) => Ok(cwd.into_os_string().into_encoded_bytes()),
        Err(error) => {
            eprintln!("error: Could not read the working directory: {error}");
            Err(1)
        }
    }
}

fn change_dir(cwd: &str) -> Result<(), i32> {
    std::env::set_current_dir(cwd).map_err(|error| {
        eprintln!("error: Could not change directory to \"{cwd}\": {error}");
        1
    })
}

/// Runs `bun check` with the arguments after `check`. Returns the exit code.
pub(super) fn run(
    args: &[String],
    libs: bun_sema_driver::host::BundledLibs,
    cwd_before: Option<&str>,
) -> i32 {
    let flags = match parse_flags(args) {
        Ok(flags) => flags,
        Err(message) => return usage_error(&message),
    };
    if flags.help {
        print_help();
        return 0;
    }
    // `bun --cwd a check --cwd b` checks `a/b`, and compiler options are read from there.
    for cwd in [cwd_before, flags.cwd.as_deref()].into_iter().flatten() {
        if let Err(code) = change_dir(cwd) {
            return code;
        }
    }
    let Ok(cwd) = current_dir() else { return 1 };
    let options = match parse_options(flags, &cwd) {
        Ok(options) => options,
        Err(message) => return usage_error(&message),
    };
    // WASI preview 1 has one thread: parallel regions run here instead of on a pool.
    bun_sema_driver::run_regions_inline_on_this_thread();
    let command_line = &options.command_line;
    let request = Request {
        cwd: &cwd,
        project: command_line.project.as_deref(),
        listed_projects: None,
        build: command_line.build,
        errors: &command_line.errors,
        paths: &command_line.paths,
        are_entry_points: false,
        script_kinds: &[],
        script_kinds_by_extension: &[],
        conditions: &[],
        compiler_options: &command_line.compiler_options,
        threads: 1,
        libs: Libs::Bundled(libs),
        progress: None,
        order: 1,
        plan_options: PlanOptions::default(),
        stops_like_tsc: true,
        uses_typescript_wording: false,
        after_file: None,
    };
    let provided = Provided {
        ends_the_process: true,
        ..Default::default()
    };
    // The closure returns the report so that it's never dropped. The process exits instead.
    let (exit_code, _report) = bun_sema_driver::check_provided_then(&request, provided, |report| {
        (print_report(&report, &options, &cwd), report)
    });
    i32::from(exit_code)
}

/// Where a report is printed.
#[derive(Copy, Clone)]
struct Destination {
    is_tty: bool,
    colors: bool,
}

/// A terminal user gets a source excerpt around each error, and so does an agent, in tags and
/// without colors. A pipe or continuous integration gets one line per error.
fn style_for(cwd: &[u8], pretty: Option<bool>, to: Destination, show_all: bool) -> Style<'_> {
    let layout = match pretty {
        Some(true) => Layout::Pretty,
        Some(false) => Layout::Plain,
        None if Output::is_ai_agent() => Layout::Agent,
        None if to.is_tty => Layout::Pretty,
        None => Layout::Plain,
    };
    Style {
        layout,
        color: layout == Layout::Pretty && to.colors,
        cwd,
        // Overridden with `Report::is_case_sensitive` below.
        is_case_sensitive: true,
        github_annotations: Output::is_github_action(),
        // WASI has no terminal size query; the host's terminal wraps.
        width: 0,
        show_all,
    }
}

/// Prints the report. Returns the exit code.
fn print_report(report: &Report, options: &Options, cwd: &[u8]) -> u8 {
    let display_cwd = bun_sema_driver::host::from_native(cwd);
    let stdout = Destination {
        is_tty: Output::is_stdout_tty(),
        colors: Output::enable_ansi_colors_stdout(),
    };
    let stderr = Destination {
        is_tty: Output::is_stderr_tty(),
        colors: Output::enable_ansi_colors_stderr(),
    };
    // Errors go to stdout, like `tsc`'s. The summary goes to stderr.
    let mut out = Vec::new();
    let style = style_for(&display_cwd, options.pretty, stdout, options.all);
    format::write_diagnostics(
        &mut out,
        report,
        &Style {
            is_case_sensitive: report.is_case_sensitive,
            ..style
        },
    );
    let mut summary = Vec::new();
    let style = style_for(&display_cwd, options.pretty, stderr, options.all);
    format::write_summary(
        &mut summary,
        report,
        &Style {
            color: stderr.colors,
            is_case_sensitive: report.is_case_sensitive,
            ..style
        },
    );
    if options.timing {
        let _ = writeln!(
            summary,
            "  {} files loaded in {:.1}ms, {} checked in {:.1}ms, {} KB of stack at the most",
            report.files_loaded,
            report.load_time.as_secs_f64() * 1000.0,
            report.files_checked,
            report.check_time.as_secs_f64() * 1000.0,
            report.deepest_stack / 1024,
        );
    }
    let _ = std::io::stdout().write_all(&out);
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().write_all(&summary);
    u8::from(!report.is_ok())
}

/// Upstream's help (`Tag::CheckCommand` in `src/runtime/cli/mod.rs`) without colors. The check runs
/// on one thread here, `--threads` is accepted and ignored, and `bun --check` is not available.
const HELP: &str = "Usage: bun check [flags] [...files or directories]
  Type check a TypeScript project.

  Uses the nearest tsconfig.json and reports the same errors as tsc.
  Pass files or directories to check only those and their imports.
  Project references are followed, like tsc -b, and nothing has to be built first.

Flags:
  -p, --project=<val>    Path to a tsconfig.json or its directory
      --pretty=<val>     Show source code around each error (default in a terminal)
  -b, --build            Check the projects in references too, like tsc -b
      --no-pretty        One line per error, like tsc --pretty false (default when piped)
      --all              Show every error (above 50, identical errors are grouped)
      --threads=<val>    Accepted; bun-wasm checks on one thread
      --timing           Print load and check times
      --cwd=<val>        Set the working directory
      --no-script        Accepted; bun-wasm never runs a check script instead
  -h, --help             Print this help menu
      --strict, --target=<val>, ...  Any compiler option, as for tsc. Overrides tsconfig.json

Examples:
  Check the current project
  bun check

  Check one file and everything it imports
  bun check src/index.ts

  Check another project
  bun check -p packages/server

  Try a stricter option without editing tsconfig.json
  bun check --noUncheckedIndexedAccess

Full documentation is available at https://bun.com/docs/runtime/check
";

fn print_help() {
    print!("{HELP}");
}
