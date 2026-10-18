#[derive(Default)]
pub struct ToolGlobals {
    pub cwd_before: Option<String>,
    pub bunfig: Option<String>,
}

pub fn before_command(args: &[String]) -> Option<(String, Vec<String>, ToolGlobals)> {
    let mut forwarded = Vec::new();
    let mut globals = ToolGlobals::default();
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        match arg.as_str() {
            "lint" | "fmt" => {
                forwarded.extend_from_slice(&args[at + 1..]);
                return Some((arg.clone(), forwarded, globals));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_cli_subcommands() {
        for args in [
            vec!["lint"],
            vec!["--cwd", "lint", "fmt"],
            vec!["--cwd=project", "lint"],
            vec!["--config=x.toml", "fmt"],
        ] {
            assert!(
                before_command(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_some()
            );
        }
        for args in [
            vec!["run", "lint"],
            vec!["build", "fmt"],
            vec!["-e", "lint"],
            vec!["--cwd", "lint"],
            vec!["index.ts", "fmt"],
        ] {
            assert!(
                before_command(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_none()
            );
        }
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
