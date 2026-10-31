//! `bun-build <entry>... [flags]`: Bun's `bun build`, in wasm.
use std::process::ExitCode;
use std::time::Instant;

use bunwasm_build::BuildEntrypoint;

fn main() -> ExitCode {
    let start = Instant::now();
    #[cfg(target_os = "wasi")]
    bunwasm_glue::init();

    ExitCode::from(bunwasm_build::cli::run(
        std::env::args().skip(1),
        BuildEntrypoint::Standalone,
        start,
    ))
}
