//! `bun build` through Bun's engine-independent bundler.
use std::time::Instant;

use bunwasm_build::BuildEntrypoint;

/// `bun build <entry>... [flags]`; returns the exit code.
pub fn run(cli_args: Vec<String>) -> i32 {
    i32::from(bunwasm_build::cli::run(
        cli_args,
        BuildEntrypoint::Bun,
        Instant::now(),
    ))
}
