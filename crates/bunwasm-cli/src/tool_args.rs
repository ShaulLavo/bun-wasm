#[derive(Default)]
pub struct ToolGlobals {
    pub cwd_before: Option<String>,
    pub bunfig: Option<String>,
}

pub struct ToolCommand {
    pub command: String,
    pub args: Vec<String>,
    pub globals: ToolGlobals,
}

pub fn before_command(args: &[String]) -> Option<ToolCommand> {
    let mut forwarded = Vec::new();
    let mut globals = ToolGlobals::default();
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        match arg.as_str() {
            "lint" | "fmt" => {
                forwarded.extend_from_slice(&args[at + 1..]);
                return Some(ToolCommand {
                    command: arg.clone(),
                    args: forwarded,
                    globals,
                });
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
