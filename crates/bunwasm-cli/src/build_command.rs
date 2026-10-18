//! `bun build`: Bun's real bundler (crates/bunwasm-build). The flag parsing
//! follows crates/bunwasm-build/src/bin/bun-build.rs, which the bundler lane
//! verified byte for byte against native `bun build`; keep the two in sync.
use std::io::{IsTerminal as _, Write as _};

use bunwasm_build::{BuildArgs, Format, Packages, SourceMap, Target};

const USAGE: &str = "usage: bun build <entrypoint>... [--outdir dir | --outfile file] [--minify] \
[--minify-syntax] [--minify-whitespace] [--minify-identifiers] [--format esm|cjs|iife] \
[--target browser|bun|node] [--sourcemap[=linked|inline|external|none]] [--splitting] \
[--external pkg] [--packages bundle|external] [--define K=V] [--root dir] [--public-path p] \
[--entry-naming t] [--chunk-naming t] [--asset-naming t] [--banner s] [--footer s] \
[--production] [--react-fast-refresh] [--no-bundle] [--keep-names] [--metafile[=path]] [--conditions c]";

fn fail(msg: &str) -> i32 {
    eprintln!("error: {msg}");
    1
}

/// `bun build <entry>... [flags]`; returns the exit code.
pub fn run(cli_args: Vec<String>) -> i32 {
    let start = std::time::Instant::now();
    let mut args = BuildArgs::default();
    let mut argv = cli_args.into_iter().peekable();
    while let Some(arg) = argv.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| argv.next())
                .ok_or_else(|| format!("{name} needs a value"))
        };
        let r: Result<(), String> = (|| {
            match flag.as_str() {
                "-h" | "--help" => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                "--outdir" => args.outdir = Some(value("--outdir")?),
                "--outfile" => args.outfile = Some(value("--outfile")?),
                "--root" => args.root = Some(value("--root")?),
                // Changes the process cwd (WASI starts at `/`), so relative
                // paths and the `// path` comments match a native run there.
                "--cwd" => {
                    let dir = value("--cwd")?;
                    std::env::set_current_dir(&dir).map_err(|e| format!("--cwd {dir}: {e}"))?;
                }
                "--minify" => args.set_minify(true),
                "--minify-syntax" => args.minify_syntax = true,
                "--minify-whitespace" => args.minify_whitespace = true,
                "--minify-identifiers" => args.minify_identifiers = true,
                "--keep-names" => args.keep_names = true,
                "--splitting" => args.splitting = true,
                "--production" => args.production = true,
                "--react-fast-refresh" => args.react_fast_refresh = true,
                "--no-bundle" => args.no_bundle = true,
                "--format" => {
                    args.format = match value("--format")?.as_str() {
                        "esm" => Format::Esm,
                        "cjs" => Format::Cjs,
                        "iife" => Format::Iife,
                        other => {
                            return Err(format!(
                                "Invalid value for --format: \"{other}\". Must be 'esm', 'cjs', or 'iife'."
                            ));
                        }
                    }
                }
                "--target" => {
                    args.target = Some(match value("--target")?.as_str() {
                        "browser" => Target::Browser,
                        "bun" => Target::Bun,
                        "node" => Target::Node,
                        other => return Err(format!("invalid target \"{other}\"")),
                    })
                }
                "--sourcemap" => {
                    args.sourcemap = match inline.as_deref() {
                        None | Some("") | Some("linked") => SourceMap::Linked,
                        Some("inline") => SourceMap::Inline,
                        Some("external") => SourceMap::External,
                        Some("none") => SourceMap::None,
                        Some(other) => {
                            return Err(format!("Invalid sourcemap setting: \"{other}\""));
                        }
                    }
                }
                "--packages" => {
                    args.packages = Some(match value("--packages")?.as_str() {
                        "bundle" => Packages::Bundle,
                        "external" => Packages::External,
                        other => return Err(format!("Invalid packages setting: \"{other}\"")),
                    })
                }
                "-e" | "--external" => args.external.push(value("--external")?),
                "--define" => {
                    let d = value("--define")?;
                    let (k, v) = d
                        .split_once(['=', ':'])
                        .ok_or("--define expects KEY=VALUE")?;
                    args.define.push((k.to_string(), v.to_string()));
                }
                "--drop" => args.drop.push(value("--drop")?),
                "--conditions" => args.conditions.push(value("--conditions")?),
                "--public-path" => args.public_path = Some(value("--public-path")?),
                "--banner" => args.banner = Some(value("--banner")?),
                "--footer" => args.footer = Some(value("--footer")?),
                "--entry-naming" => args.entry_naming = Some(value("--entry-naming")?),
                "--chunk-naming" => args.chunk_naming = Some(value("--chunk-naming")?),
                "--asset-naming" => args.asset_naming = Some(value("--asset-naming")?),
                "--metafile" => args.metafile = Some(inline.clone().unwrap_or_default()),
                f if f.starts_with('-') => return Err(format!("unknown flag {f}\n{USAGE}")),
                _ => args.entry_points.push(arg.clone()),
            }
            Ok(())
        })();
        if let Err(e) = r {
            return fail(&e);
        }
    }

    // Bun colors terminal output unless NO_COLOR is set.
    let colors = |tty: bool| tty && std::env::var_os("NO_COLOR").is_none();
    let stdout_colors = colors(std::io::stdout().is_terminal());
    bunwasm_build::set_log_colors(colors(std::io::stderr().is_terminal()));

    match bunwasm_build::build(&args) {
        Ok(out) => {
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
            for e in &out.write_errors {
                eprintln!("{e}");
            }
            eprint!("{}", out.log);
            if out.write_errors.is_empty() { 0 } else { 1 }
        }
        Err(e) => {
            eprint!("{e}");
            if !e.ends_with('\n') {
                eprintln!();
            }
            1
        }
    }
}
