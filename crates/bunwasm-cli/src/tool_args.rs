//! Whether `bun <args>` is `bun lint`, `bun fmt` or `bun check`, which run in `bun-tools.wasm`.
//! `web/src/tool-command.ts` mirrors this for the browser and Node hosts.

#[derive(Default)]
pub struct ToolGlobals {
    pub cwd_before: Option<String>,
    pub bunfig: Option<String>,
    /// For `bun check`: where among the forwarded arguments the short-flag chain from directly
    /// before `check` is. Its `b` letters are Bun's `--bun`, and it is a chain even when what
    /// remains reads like a compiler option: `bun -bt check` rejects `-t`.
    pub check_chain: Option<usize>,
    /// Flags from `BUN_OPTIONS` before `fmt`/`lint` that Bun itself did not consume; the tool
    /// forwards the ones its own parser recognizes (matching upstream `with_own_flags_before`).
    pub env_flags_before: Vec<String>,
}

/// Bun's long flags whose value is the next argument (`AUTO_PARAMS` in upstream
/// `src/runtime/cli/Arguments.rs`, the `<VALUE>` ones without `?`). A tool word there is a value:
/// `bun --conditions check run x.ts` runs `x.ts`.
const LONG_WITH_VALUE: &[&str] = &[
    "--breakpoint-resolve",
    "--conditions",
    "--console-depth",
    "--cpu-prof-dir",
    "--cpu-prof-interval",
    "--cpu-prof-name",
    "--cron-period",
    "--cron-title",
    "--cwd",
    "--define",
    "--disable-warning",
    "--dns-result-order",
    "--drop",
    "--elide-lines",
    "--env-file",
    "--extension-order",
    "--feature",
    "--fetch-preconnect",
    "--filter",
    "--heap-prof-dir",
    "--heap-prof-interval",
    "--heap-prof-name",
    "--import",
    "--install",
    "--jsx-factory",
    "--jsx-fragment",
    "--jsx-import-source",
    "--jsx-runtime",
    "--loader",
    "--main-fields",
    "--max-http-header-size",
    "--origin",
    "--port",
    "--preload",
    "--redirect-warnings",
    "--require",
    "--shell",
    "--stack-trace-limit",
    "--title",
    "--trace-event-categories",
    "--trace-event-file-pattern",
    "--tsconfig-override",
    "--unhandled-rejections",
    "--user-agent",
    "--watch-kill-signal",
];
/// Bun's short flags with a value: the rest of the chain (`-Fpattern`), or else the next argument.
const SHORT_WITH_VALUE: &[u8] = b"deFlpru";
/// Bun's short flags without one, which a chain like `-be` may continue after.
const SHORT_WITHOUT_VALUE: &[u8] = b"bhv";

/// `node` and `nodejs` run files and have no subcommands.
pub fn is_node(executable: &str) -> bool {
    let name = executable.rsplit('/').next().unwrap_or(executable);
    matches!(name.trim_end_matches(".wasm"), "node" | "nodejs")
}

/// The letter of a chain of Bun's short flags that takes a value, and whether that value is the
/// next argument. `-c` takes an optional value, which is never the next argument.
pub(crate) fn short_with_value(flag: &str) -> Option<(u8, bool)> {
    let shorts = flag.strip_prefix('-')?.as_bytes();
    if shorts.first().is_none_or(|first| *first == b'-') {
        return None;
    }
    for (at, short) in shorts.iter().enumerate() {
        if SHORT_WITH_VALUE.contains(short) {
            return Some((*short, at + 1 == shorts.len()));
        }
        if !SHORT_WITHOUT_VALUE.contains(short) {
            return None;
        }
    }
    None
}

fn evaluates(flag: &str) -> bool {
    let name = flag.split_once('=').map_or(flag, |(name, _)| name);
    matches!(name, "--eval" | "--print") || matches!(short_with_value(flag), Some((b'e' | b'p', _)))
}

/// Whether `flag` selects workspace or multi-script execution rather than a tool subcommand.
pub(crate) fn is_workspace_scope_flag(flag: &str) -> bool {
    let name = flag.split_once('=').map_or(flag, |(name, _)| name);
    matches!(
        name,
        "--filter" | "--workspaces" | "--parallel" | "--sequential"
    ) || matches!(short_with_value(flag), Some((b'F', _)))
}

/// Whether `flag` is one of Bun's whose value is the next argument.
pub fn takes_next_argument(flag: &str) -> bool {
    LONG_WITH_VALUE.contains(&flag) || short_with_value(flag).is_some_and(|(_, next)| next)
}

fn is_tool(word: &str) -> bool {
    matches!(word, "lint" | "fmt" | "check")
}

/// What `bun <args>` passes to the tool. `bun lint` and `bun fmt` get the flags before them that
/// Bun doesn't know. `bun check` gets from there only the options that upstream's check command
/// parses anywhere on the command line (`for_check`); Bun's other flags are Bun's.
fn command(
    word: &str,
    after: &[String],
    unknown: Vec<String>,
    for_check: Vec<String>,
    globals: ToolGlobals,
) -> (String, Vec<String>, ToolGlobals) {
    let before = if word == "check" { for_check } else { unknown };
    (
        word.to_owned(),
        before.into_iter().chain(after.iter().cloned()).collect(),
        globals,
    )
}

/// The options of upstream's `bun check` (`src/runtime/cli/check_command.rs`, `PARAMS`) that can
/// stand before `check` as one argument. Their values can't be the next argument there, where it
/// would be the command: `--project app check` runs `app`. `-b` and `--build` before `check` are
/// `--bun`, as upstream.
fn is_check_option(flag: &str) -> bool {
    matches!(
        flag,
        "-h" | "--help" | "--no-pretty" | "--all" | "--timing" | "--no-script" | "--no-emit"
    ) || flag.starts_with("--project=")
        || flag.starts_with("--threads=")
}

/// Whether `arg`, directly before `check`, is a chain of short flags that upstream's check command
/// parses: one that doesn't take `check` as Bun's own value (`-r check` preloads `check`) or
/// evaluate code. `-p` is the exception, since the check command has `-p` too.
fn is_chain_of_check(arg: &str) -> bool {
    if arg.len() < 2 || arg.starts_with("--") || !arg.starts_with('-') {
        return false;
    }
    match short_with_value(arg) {
        Some((b'p', _)) => true,
        Some((b'e', _)) | Some((_, true)) => false,
        _ => true,
    }
}

/// What the checker gets for a chain directly before `check`: the chain itself, for the checker's
/// own parser to accept or reject, as upstream's parses the whole command line. A `p` that ends
/// the chain takes `check` as its value, as there.
fn check_chain(chain: &str) -> Vec<String> {
    let value = chain.find('p').map_or("", |at| &chain[at..]);
    match value {
        "p" => vec![chain.to_owned(), "check".to_owned()],
        _ => vec![chain.to_owned()],
    }
}

#[allow(dead_code)] // Shared across bunwasm-cli, bunwasm-host, and bunwasm-tools.
pub fn before_command(args: &[String]) -> Option<(String, Vec<String>, ToolGlobals)> {
    before_command_inner(args, 0)
}

#[allow(dead_code)] // Called by bunwasm-host and bunwasm-tools, which share this module.
pub fn before_command_with_env(
    args: &[String],
    bun_options_env: Option<&str>,
) -> Option<(String, Vec<String>, ToolGlobals)> {
    let mut effective = bun_options_env.map(bun_options).unwrap_or_default();
    let env_count = effective.len();
    effective.extend(args.iter().cloned());
    before_command_inner(&effective, env_count)
}

fn before_command_inner(
    args: &[String],
    env_count: usize,
) -> Option<(String, Vec<String>, ToolGlobals)> {
    let mut unknown = Vec::new();
    let mut for_check = Vec::new();
    let mut globals = ToolGlobals::default();
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        let from_env = at < env_count;
        let next = args.get(at + 1).map(String::as_str);
        // `bun -ptsconfig.json check`, `bun -h check`: the check command parses the chain.
        let is_of_check = next == Some("check") && is_chain_of_check(arg);
        match arg.as_str() {
            word if is_tool(word) => {
                return Some(command(word, &args[at + 1..], unknown, for_check, globals));
            }
            // What follows `--` is the command or the file to run, even if it looks like a flag.
            "--" => {
                let word = next.filter(|word| is_tool(word))?;
                return Some(command(word, &args[at + 2..], unknown, for_check, globals));
            }
            // `bun -` runs standard input: `bun - check` passes it `check`.
            "-" => return None,
            "--tsconfig-override" => {
                for_check.extend(args.get(at..at + 2).unwrap_or_default().iter().cloned());
                at += 1;
            }
            flag if flag.starts_with("--tsconfig-override=") => for_check.push(arg.clone()),
            "--cwd" => {
                at += 1;
                globals.cwd_before = Some(args.get(at)?.clone());
            }
            flag if flag.starts_with("--cwd=") => {
                globals.cwd_before = Some(flag.split_once('=')?.1.to_owned());
            }
            "--smol" | "--silent" | "--no-install" | "--bun" | "-b" => {}
            "-v" | "--version" | "--revision" => return None,
            flag if flag.starts_with("--config=") || flag.starts_with("-c=") => {
                globals.bunfig = Some(flag.split_once('=')?.1.to_owned());
            }
            flag if is_workspace_scope_flag(flag) => return None,
            _ if is_of_check => {
                globals.check_chain = Some(for_check.len());
                for_check.extend(check_chain(arg));
            }
            flag if evaluates(flag) => return None,
            flag if takes_next_argument(flag) => at += 1,
            flag if is_check_option(flag) => {
                for_check.push(arg.clone());
                if from_env {
                    globals.env_flags_before.push(arg.clone());
                } else {
                    unknown.push(arg.clone());
                }
            }
            flag if flag.starts_with('-') => {
                if from_env {
                    if flag != "--config" {
                        globals.env_flags_before.push(arg.clone());
                    }
                } else {
                    unknown.push(arg.clone());
                }
            }
            _ => return None,
        }
        at += 1;
    }
    None
}

/// Splits `BUN_OPTIONS` into arguments the way Bun's `append_options_env`
/// (src/bun_core/util.rs) does: `--flag=value`, `--flag "quoted"` and `--flag='quoted'`
/// stay one argument with their quotes, and bare words lose quotes and backslashes.
/// docs/bun-patches/bun-options-env.md records the port.
pub fn bun_options(env: &str) -> Vec<String> {
    let env = env.as_bytes();
    let mut args = Vec::new();
    let mut i = 0;
    while i < env.len() {
        if env[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let (arg, end) = if env[i..].starts_with(b"--") {
            option_argument(env, i)
        } else {
            plain_argument(env, i)
        };
        args.push(arg);
        i = end;
    }
    args
}

pub fn option_argument(env: &[u8], start: usize) -> (String, usize) {
    let mut j = start;
    while j < env.len() && !env[j].is_ascii_whitespace() && env[j] != b'=' {
        j += 1;
    }
    let end_of_flag = j;
    let found_equals = j < env.len() && env[j] == b'=';
    if found_equals {
        j += 1;
    }
    while !found_equals && j < env.len() && env[j].is_ascii_whitespace() {
        j += 1;
    }
    if j < env.len() && (env[j] == b'\'' || env[j] == b'"') {
        let quote = env[j];
        j += 1;
        while j < env.len() && env[j] != quote {
            j += 1;
        }
        j = (j + 1).min(env.len());
    } else if found_equals {
        while j < env.len() && !env[j].is_ascii_whitespace() {
            j += 1;
        }
    } else {
        // `--flag value`: the value becomes an argument of its own.
        j = end_of_flag;
    }
    (String::from_utf8_lossy(&env[start..j]).into_owned(), j)
}

pub fn plain_argument(env: &[u8], start: usize) -> (String, usize) {
    let mut buf = Vec::new();
    let mut quote: Option<u8> = None;
    let mut escape = false;
    let mut i = start;
    while let Some(&ch) = env.get(i) {
        if !escape && quote.is_none() && ch.is_ascii_whitespace() {
            break;
        }
        i += 1;
        if escape {
            buf.push(ch);
            escape = false;
        } else if ch == b'\\' {
            escape = true;
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && (ch == b'\'' || ch == b'"') {
            quote = Some(ch);
        } else {
            buf.push(ch);
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), i)
}

#[allow(dead_code)] // Shared across bunwasm-cli, bunwasm-host, and bunwasm-tools.
pub fn with_bun_options(args: &[String], bun_options_env: Option<&str>) -> Vec<String> {
    let mut effective = bun_options_env.map(bun_options).unwrap_or_default();
    effective.extend(args.iter().cloned());
    effective
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select(args: &[&str]) -> Option<(String, Vec<String>, ToolGlobals)> {
        before_command(
            &args
                .iter()
                .map(|arg| String::from(*arg))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn selects_only_cli_subcommands() {
        for args in [
            &["lint"][..],
            &["--cwd", "lint", "fmt"],
            &["--cwd=project", "lint"],
            &["--config=x.toml", "fmt"],
            &["check"],
            &["--cwd", "app", "check", "--project", "tsconfig.json"],
            &["--conditions", "dev", "check"],
            &["-b", "check"],
            &["-ptsconfig.json", "check"],
            &["--", "check"],
        ] {
            assert!(select(args).is_some(), "{args:?}");
        }
        for args in [
            &["run", "lint"][..],
            &["build", "fmt"],
            &["-e", "lint"],
            &["--cwd", "lint"],
            &["index.ts", "fmt"],
            &["test", "check"],
            &["--conditions", "check", "run", "./entry.ts"],
            &["-r", "check", "entry.ts"],
            &["-brcheck", "entry.ts"],
            &["--print", "1", "check"],
            &["--", "--entry.ts", "check"],
            &["--filter=a", "check"],
            &["--filter", "a", "lint"],
            &["-F", "a", "fmt"],
            &["-Fa", "check"],
            &["--workspaces", "lint"],
            &["--parallel", "lint"],
            &["--sequential", "check"],
        ] {
            assert!(select(args).is_none(), "{args:?}");
        }
    }

    #[test]
    fn node_has_no_subcommands() {
        assert!(is_node("/bin/node"));
        assert!(is_node("nodejs"));
        assert!(is_node("/usr/bin/node.wasm"));
        assert!(!is_node("/bin/bun"));
        assert!(!is_node("node-gyp"));
    }

    #[test]
    fn check_gets_its_own_options_from_before_it() {
        for (args, expected) in [
            (
                &["-papp", "check", "--no-pretty"][..],
                &["-papp", "--no-pretty"][..],
            ),
            (&["-bpapp", "check", "app"], &["-bpapp", "app"]),
            (&["-p=app", "check"], &["-p=app"]),
            (&["-bhpmissing", "check"], &["-bhpmissing"]),
            (&["-bvhpx", "check"], &["-bvhpx"]),
            (&["-hb", "check"], &["-hb"]),
            (&["-bhp", "check"], &["-bhp", "check"]),
            (&["-bp", "check"], &["-bp", "check"]),
            (&["-x", "check"], &["-x"]),
            (&["--project=app", "check"], &["--project=app"]),
            (&["--help", "check"], &["--help"]),
            (&["-h", "check"], &["-h"]),
            (
                &["--no-pretty", "--timing", "check"],
                &["--no-pretty", "--timing"],
            ),
            (
                &["--tsconfig-override", "app/tsconfig.json", "check"],
                &["--tsconfig-override", "app/tsconfig.json"],
            ),
            (
                &["--tsconfig-override=app", "check"],
                &["--tsconfig-override=app"],
            ),
            (&["--title=check", "check", "--no-pretty"], &["--no-pretty"]),
            (&["--no-warnings", "--title", "x", "check"], &[]),
        ] {
            let (command, forwarded, _) = select(args).unwrap();
            assert_eq!(command, "check");
            assert_eq!(forwarded, expected, "{args:?}");
        }
        let (_, forwarded, globals) = select(&["--no-pretty", "-bt", "check", "es2022"]).unwrap();
        assert_eq!(forwarded, ["--no-pretty", "-bt", "es2022"]);
        assert_eq!(globals.check_chain, Some(1));
        let (_, _, globals) = select(&["--no-pretty", "check", "-t", "es2022"]).unwrap();
        assert_eq!(globals.check_chain, None);
        let (_, forwarded, _) =
            select(&["--no-warnings", "--tsconfig-override", "x", "lint"]).unwrap();
        assert_eq!(forwarded, ["--no-warnings"]);
        assert!(select(&["-", "check"]).is_none());
        assert!(select(&["--project", "app", "check"]).is_none());
        assert!(before_command_with_env(&["fmt".into()], Some("--filter=app")).is_none());
        let (cmd, forwarded, globals) = before_command_with_env(
            &["fmt".into(), "--help".into()],
            Some("--no-warnings --disable-warning=DEP2 --cwd project"),
        )
        .unwrap();
        assert_eq!(cmd, "fmt");
        assert_eq!(forwarded, ["--help"]);
        assert_eq!(globals.cwd_before.as_deref(), Some("project"));
        assert_eq!(
            globals.env_flags_before,
            ["--no-warnings", "--disable-warning=DEP2"]
        );
        let (cmd, forwarded, globals) =
            before_command_with_env(&["file.ts".into()], Some("--check fmt")).unwrap();
        assert_eq!(cmd, "fmt");
        assert_eq!(forwarded, ["file.ts"]);
        assert_eq!(globals.env_flags_before, ["--check"]);
        let (cmd, forwarded, globals) =
            before_command_with_env(&["file.ts".into()], Some("-c fmt")).unwrap();
        assert_eq!(cmd, "fmt");
        assert_eq!(forwarded, ["file.ts"]);
        assert_eq!(globals.env_flags_before, ["-c"]);
        assert!(
            before_command_with_env(&["fmt".into()], Some("--no-warnings\x0B--filter=app"))
                .is_some()
        );
    }
}

#[cfg(test)]
mod forwarding_tests {
    #[test]
    fn preserves_tool_operands_and_global_options() {
        let args = [
            "--cwd",
            "project",
            "--config=bunfig.toml",
            "--unknown",
            "lint",
            "--help",
        ]
        .map(String::from);
        let (command, forwarded, globals) = super::before_command(&args).unwrap();
        assert_eq!(command, "lint");
        assert_eq!(forwarded, ["--unknown", "--help"]);
        assert_eq!(globals.cwd_before.as_deref(), Some("project"));
        assert_eq!(globals.bunfig.as_deref(), Some("bunfig.toml"));
    }
}
