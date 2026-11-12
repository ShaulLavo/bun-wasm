//! Shared process I/O for the two build entrypoints.
use std::io::{IsTerminal as _, Write as _};
use std::time::Instant;

use crate::{BuildEntrypoint, BuildOutput, parse_build_args};

pub fn run(
    argv: impl IntoIterator<Item = String>,
    entrypoint: BuildEntrypoint,
    start: Instant,
) -> u8 {
    let args = match parse_build_args(argv, entrypoint) {
        Ok(None) => {
            println!("{}", entrypoint.usage());
            return 0;
        }
        Ok(Some(args)) => args,
        Err(message) => {
            eprintln!("error: {message}");
            return 1;
        }
    };
    let colors = |tty: bool| tty && std::env::var_os("NO_COLOR").is_none();
    let stdout_colors = colors(std::io::stdout().is_terminal());
    crate::set_log_colors(colors(std::io::stderr().is_terminal()));
    match crate::build(&args) {
        Ok(out) => print_output(out, start, stdout_colors),
        Err(error) => {
            eprint!("{error}");
            if !error.ends_with('\n') {
                eprintln!();
            }
            1
        }
    }
}

fn print_output(out: BuildOutput, start: Instant, stdout_colors: bool) -> u8 {
    let mut stdout = std::io::stdout().lock();
    if let Some(bytes) = &out.stdout {
        let _ = stdout.write_all(bytes);
    } else {
        let _ = stdout.write_all(
            out.summary(start.elapsed().as_millis(), stdout_colors)
                .as_bytes(),
        );
    }
    let _ = stdout.flush();
    for error in &out.write_errors {
        eprintln!("{error}");
    }
    eprint!("{}", out.log);
    u8::from(!out.write_errors.is_empty())
}
