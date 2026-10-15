//! `bun-wasm`: runs bun.wasm on wasmtime with WASI preview1 and the
//! `bun_wasm` networking host ABI (docs/host-abi.md).

mod net;
mod slots;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use wasmtime::{Cache, CacheConfig, Config, Engine, Linker, Module, Store};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::{DirPerms, FilePerms, I32Exit, WasiCtxBuilder};

const USAGE: &str = "\
usage: bun-wasm [launcher options] [--] <bun arguments...>

Runs bun.wasm (from --wasm, $BUN_WASM, or the build tree's dist/bun.wasm)
with networking. Launcher options must come before the bun arguments:

  --wasm PATH         bun.wasm to run
  --dir HOST[::GUEST] preopen a directory (repeatable); without any --dir
                      the current directory is preopened at its own path
  --env K=V           set a guest environment variable (repeatable)
  --inherit-env       pass the whole host environment to the guest
  --launcher-help     show this help

Environment: BUN_WASM_TRACE=1 logs every host ABI call to stderr;
BUN_WASM_CACHE_DIR sets the compiled-module cache directory (default:
wasmtime's cache, BUN_WASM_CACHE_DIR=off disables it).
";

pub struct Host {
    pub wasi: WasiP1Ctx,
    pub net: net::Net,
    pub memory: Option<wasmtime::Memory>,
    pub trace: bool,
}

#[derive(Default)]
struct Options {
    wasm: Option<PathBuf>,
    dirs: Vec<(PathBuf, String)>,
    env: Vec<(String, String)>,
    inherit_env: bool,
    args: Vec<String>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Options> {
    let mut options = Options::default();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| -> Result<String> {
            match inline.clone() {
                Some(value) => Ok(value),
                None => args.next().with_context(|| format!("{name} needs a value")),
            }
        };
        match flag.as_str() {
            "--wasm" => options.wasm = Some(value("--wasm")?.into()),
            "--dir" => {
                let spec = value("--dir")?;
                let (host, guest) = spec.split_once("::").unwrap_or((&spec, &spec));
                options.dirs.push((host.into(), guest.to_string()));
            }
            "--env" => {
                let spec = value("--env")?;
                let Some((key, val)) = spec.split_once('=') else { bail!("--env expects K=V, got {spec:?}") };
                options.env.push((key.into(), val.into()));
            }
            "--inherit-env" => options.inherit_env = true,
            "--launcher-help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--" => {
                options.args.extend(args);
                break;
            }
            _ => {
                options.args.push(arg);
                options.args.extend(args);
                break;
            }
        }
    }
    Ok(options)
}

fn wasm_path(options: &Options) -> PathBuf {
    if let Some(path) = &options.wasm {
        return path.clone();
    }
    if let Some(path) = std::env::var_os("BUN_WASM") {
        return path.into();
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/bun.wasm")
}

fn engine() -> Result<Engine> {
    let mut config = Config::new();
    match std::env::var("BUN_WASM_CACHE_DIR").ok().as_deref() {
        Some("off" | "0") => {}
        Some(dir) => {
            let mut cache = CacheConfig::new();
            cache.with_directory(std::path::absolute(dir)?);
            config.cache(Some(Cache::new(cache)?));
        }
        // wasmtime's own default (~/.cache/wasmtime or its config file).
        None => {
            config.cache(Some(Cache::from_file(None)?));
        }
    }
    Engine::new(&config)
}

/// The guest's `$PWD` (bun.wasm chdirs there at startup): the host cwd as
/// seen through the preopens.
fn guest_pwd(cwd: &Path, dirs: &[(PathBuf, String)]) -> Option<String> {
    dirs.iter().find_map(|(host, guest)| {
        let host = std::path::absolute(host).ok()?;
        let rest = cwd.strip_prefix(&host).ok()?;
        let pwd = if rest.as_os_str().is_empty() { PathBuf::from(guest) } else { Path::new(guest).join(rest) };
        Some(pwd.to_string_lossy().into_owned())
    })
}

fn run(options: Options) -> Result<i32> {
    let wasm = wasm_path(&options);
    let engine = engine()?;
    let module = Module::from_file(&engine, &wasm).with_context(|| format!("loading {}", wasm.display()))?;

    let cwd = std::env::current_dir().context("reading the current directory")?;
    let dirs = if options.dirs.is_empty() {
        vec![(cwd.clone(), cwd.to_string_lossy().into_owned())]
    } else {
        options.dirs.clone()
    };

    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdio().args(&[String::from("bun")].into_iter().chain(options.args.iter().cloned()).collect::<Vec<_>>());
    if options.inherit_env {
        wasi.inherit_env();
    }
    let explicit_pwd = options.env.iter().any(|(k, _)| k == "PWD");
    if !explicit_pwd && let Some(pwd) = guest_pwd(&cwd, &dirs) {
        wasi.env("PWD", pwd);
    }
    for (key, value) in &options.env {
        wasi.env(key, value);
    }
    for (host, guest) in &dirs {
        wasi.preopened_dir(host, guest, DirPerms::all(), FilePerms::all())
            .with_context(|| format!("preopening {}", host.display()))?;
    }

    let host = Host {
        wasi: wasi.build_p1(),
        net: net::Net::new(),
        memory: None,
        trace: std::env::var("BUN_WASM_TRACE").is_ok_and(|v| !v.is_empty() && v != "0"),
    };
    let mut store = Store::new(&engine, host);
    let mut linker: Linker<Host> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |host| &mut host.wasi)?;
    let instance = linker.instantiate(&mut store, &module)?;
    store.data_mut().memory = instance.get_memory(&mut store, "memory");
    slots::install(&mut store, &instance)?;

    let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
    let result = start.call(&mut store, ());
    store.data_mut().net.flush_closed(std::time::Duration::from_secs(2));
    match result {
        Ok(()) => Ok(0),
        Err(error) => match error.downcast_ref::<I32Exit>() {
            Some(exit) => Ok(exit.0),
            None => {
                // A trap (unreachable, out of bounds, stack overflow, ...):
                // report it like a native abort (SIGABRT).
                eprintln!("bun-wasm: bun.wasm trapped: {error:?}");
                Ok(134)
            }
        },
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("bun-wasm: {error:#}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(options) {
        // Exit codes outside 0..=255 are truncated by the OS anyway.
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("bun-wasm: {error:#}");
            ExitCode::from(1)
        }
    }
}
