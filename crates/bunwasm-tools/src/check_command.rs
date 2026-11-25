//! `bun check` and `bun typecheck`: Bun's TypeScript type checker (`bun_sema_driver`) on WASI.
//!
//! Adapted from upstream `src/cli/check_command.rs`; `docs/bun-patches/tools-check-command.md`
//! records what changed. Argument parsing is by hand instead of `bun_clap`'s tables, the check runs
//! on this one thread, and a `check` script in `package.json` is not run first, as for `bun lint`.

use std::io::Write;

use bun_core::Output;
use bun_sema_driver::format::{self, Layout, Style};
use bun_sema_driver::host::Provided;
use bun_sema_driver::{CommandLine, FlagError, Libs, PlanOptions, RejectedFlag, Report, Request};

#[derive(Default)]
struct Options {
    command_line: CommandLine,
    /// `--pretty`, `--no-pretty`. If neither is given, it depends on the output destination.
    pretty: Option<bool>,
    /// `--all`: never group identical errors.
    all: bool,
    timing: bool,
    help: bool,
    cwd: Option<String>,
}

/// Returns the options, or the usage error to print.
fn parse(args: &[String], cwd: &[u8]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut flags: Vec<&[u8]> = Vec::new();
    let mut paths: Vec<Vec<u8>> = Vec::new();
    let mut project = None;
    let mut no_pretty = false;
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        at += 1;
        match arg.as_str() {
            "--" => {
                paths.extend(args[at..].iter().map(|path| path.as_bytes().to_vec()));
                break;
            }
            "-h" | "--help" => options.help = true,
            "--all" => options.all = true,
            "--timing" => options.timing = true,
            "--no-pretty" => no_pretty = true,
            // Nothing is ever emitted, and no `check` script is run first.
            "--no-emit" | "--no-script" => {}
            "--cwd" | "--threads" | "--tsconfig-override" => {
                let value = args.get(at).ok_or_else(|| format!("{arg} needs a value"))?;
                at += 1;
                take_value(&mut options, &mut project, arg, value)?;
            }
            _ => match arg.split_once('=') {
                Some((name @ ("--cwd" | "--threads" | "--tsconfig-override"), value)) => {
                    take_value(&mut options, &mut project, name, value)?;
                }
                _ => flags.push(arg.as_bytes()),
            },
        }
    }
    if options.help {
        return Ok(options);
    }
    let mut command_line = bun_sema_driver::parse_command_line(&flags, cwd);
    if let Some(rejected) = command_line.rejected.first() {
        return Err(rejection(rejected));
    }
    command_line.paths.extend(paths);
    if project.is_some() {
        command_line.project = project;
    }
    let projects = usize::from(command_line.project.is_some()) + command_line.paths.len();
    if command_line.build && projects > 1 {
        return Err("--build takes one project".to_owned());
    }
    options.pretty = match no_pretty {
        true => Some(false),
        false => bun_sema_driver::tristate(&command_line.compiler_options, b"pretty"),
    };
    options.command_line = command_line;
    Ok(options)
}

fn take_value(
    options: &mut Options,
    project: &mut Option<Vec<u8>>,
    name: &str,
    value: &str,
) -> Result<(), String> {
    match name {
        "--cwd" => options.cwd = Some(value.to_owned()),
        "--tsconfig-override" => *project = Some(value.as_bytes().to_vec()),
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
    if let Some(cwd) = cwd_before
        && let Err(code) = change_dir(cwd)
    {
        return code;
    }
    let Ok(cwd) = current_dir() else { return 1 };
    let options = match parse(args, &cwd) {
        Ok(options) => options,
        Err(message) => return usage_error(&message),
    };
    if options.help {
        print_help();
        return 0;
    }
    let cwd = match options.cwd.as_deref() {
        Some(cwd) => match change_dir(cwd).and_then(|()| current_dir()) {
            Ok(cwd) => cwd,
            Err(code) => return code,
        },
        None => cwd,
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

const HELP: &str = "Usage: bun check [flags] [...files or directories]
  Type-check a TypeScript project, like tsc --noEmit.

Flags:
  -p, --project PATH    Path to a tsconfig.json or its directory
  -b, --build           Check the projects in references too, like tsc -b
  --pretty              Show source code around each error (default in a terminal)
  --no-pretty           One line per error, like tsc --pretty false (default when piped)
  --all                 Show every error (above 50, identical errors are grouped)
  --timing              Print load and check times
  --cwd PATH            Set the working directory
  -h, --help            Print this help menu

Compiler options such as --strict or --target es2022 override the tsconfig.json.

Examples:
  bun check
  bun check --project tsconfig.build.json
  bun check src/index.ts --strict

Full documentation is available at https://bun.com/docs/check
";

fn print_help() {
    print!("{HELP}");
}
