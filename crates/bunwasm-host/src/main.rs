//! `bun-wasm`: runs bun.wasm on wasmtime with WASI preview1 and the
//! `bun_wasm` networking host ABI (docs/host-abi.md).

mod net;
mod process;
mod slots;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use wasmtime::{Cache, CacheConfig, Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, UpdateDeadline};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
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
    pub processes: process::Processes,
    pub limits: StoreLimits,
    pub functions: Vec<wasmtime::Func>,
    pub cancel: Arc<process::Cancellation>,
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

/// Host call stack for wasm frames. wasmtime's 512 KiB default holds about
/// 1,000 QuickJS calls; this launcher can afford far more (docs/stack-limits.md).
pub(crate) const WASM_STACK: usize = 16 << 20;
/// Native stack of every thread that runs an instance: the wasm stack plus room
/// for the host functions it calls. The main thread's 8 MiB is too small.
pub(crate) const THREAD_STACK: usize = WASM_STACK + (8 << 20);
/// The guest engines' stack budget (`BUN_WASM_STACK_KIB`) that fits in
/// `WASM_STACK`: every measured recursion path throws RangeError before it.
const GUEST_STACK_KIB: &str = "4096";

fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.epoch_interruption(true);
    config.max_wasm_stack(WASM_STACK);
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

    let mut env = if options.inherit_env { std::env::vars().collect::<Vec<_>>() } else { Vec::new() };
    let explicit_pwd = options.env.iter().any(|(k, _)| k == "PWD");
    if !explicit_pwd && let Some(pwd) = guest_pwd(&cwd, &dirs) { env.push(("PWD".into(), pwd)); }
    env.extend(options.env);
    let runtime = process::Runtime::new(engine.clone(), module, dirs);
    let running = Arc::new(AtomicBool::new(true));
    let tick = running.clone();
    let ticker = std::thread::spawn(move || {
        while tick.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(10));
            engine.increment_epoch();
        }
    });
    let args = std::iter::once("bun".into()).chain(options.args).collect();
    let result = std::thread::Builder::new()
        .name("bun-wasm".into())
        .stack_size(THREAD_STACK)
        .spawn(move || run_instance(runtime, args, env, process::Stdio::inherited(), Arc::default()))
        .context("starting the guest thread")?
        .join()
        // A guest-thread panic has printed its message; panic here too, so the exit code stays 101.
        .unwrap_or_else(|payload| std::panic::resume_unwind(payload));
    running.store(false, Ordering::Relaxed);
    let _ = ticker.join();
    result.map(process::FinalOutcome::code)
}

fn run_instance(runtime: Arc<process::Runtime>, argv: Vec<String>, mut env: Vec<(String, String)>, stdio: process::Stdio, cancel: Arc<process::Cancellation>) -> Result<process::FinalOutcome> {
    if !env.iter().any(|(k, _)| k == "BUN_WASM_STACK_KIB") {
        env.push(("BUN_WASM_STACK_KIB".into(), GUEST_STACK_KIB.into()));
    }
    let mut wasi = WasiCtxBuilder::new();
    wasi.args(&argv).envs(&env);
    stdio.install(&mut wasi, cancel.clone());
    for (host, guest) in &runtime.dirs {
        wasi.preopened_dir(host, guest, DirPerms::all(), FilePerms::all())
            .with_context(|| format!("preopening {}", host.display()))?;
    }
    let net = net::Net::new();
    let memory_limit = stdio.memory_limit;
    let processes = process::Processes::new(runtime.clone(), stdio, net.notify());
    let host = Host {
        wasi: wasi.build_p1(),
        net,
        functions: Vec::new(),
        cancel: cancel.clone(),
        processes,
        limits: StoreLimitsBuilder::new().memory_size(memory_limit).instances(1).build(),
        memory: None,
        trace: std::env::var("BUN_WASM_TRACE").is_ok_and(|v| !v.is_empty() && v != "0"),
    };
    let mut store = Store::new(&runtime.engine, host);
    store.limiter(|host| &mut host.limits);
    store.set_epoch_deadline(1);
    let interruption = cancel.clone();
    store.epoch_deadline_callback(move |_| {
        interruption.check()?;
        Ok(UpdateDeadline::Continue(1))
    });
    let mut linker: Linker<Host> = Linker::new(&runtime.engine);
    p1::add_to_linker_sync(&mut linker, |host| &mut host.wasi)?;
    // Wasmtime's preview1 proc_exit rejects statuses >=126. This process host
    // instead uses the native byte-sized status, including ordinary exit143.
    // Normalizing here also keeps negative status values out of child_wait's
    // control-code range; signal provenance comes only from Cancellation.
    linker.allow_shadowing(true);
    linker.func_wrap("wasi_snapshot_preview1", "proc_exit", |status: i32| -> Result<()> {
        Err(I32Exit(i32::from(status as u8)).into())
    })?;
    linker.allow_shadowing(false);
    slots::add_import(&mut linker)?;
    let instance = linker.instantiate(&mut store, &runtime.module)?;
    store.data_mut().memory = instance.get_memory(&mut store, "memory");
    slots::install(&mut store, &instance)?;

    let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
    let result = start.call(&mut store, ());
    let outcome = select_instance_outcome(result, &cancel);
    if matches!(outcome, process::FinalOutcome::Exit(_)) {
        store.data_mut().net.flush_closed(std::time::Duration::from_secs(2));
    }
    Ok(outcome)
}

fn select_instance_outcome(result: Result<()>, cancel: &process::Cancellation) -> process::FinalOutcome {
    use process::FinalOutcome;
    match result {
        Ok(()) => cancel.select(FinalOutcome::Exit(0)),
        Err(error) => match error.downcast_ref::<I32Exit>() {
            Some(exit) => cancel.select(FinalOutcome::Exit(exit.0)),
            None => {
                // Preserve the ordinary trap status unless KILL or an interruption
                // observed by epoch, poll, or stdio already selected signal death.
                let outcome = cancel.select(FinalOutcome::Exit(134));
                if matches!(outcome, FinalOutcome::Exit(_)) {
                    eprintln!("bun-wasm: bun.wasm trapped: {error:?}");
                }
                outcome
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use process::{Cancellation, FinalOutcome};

    /// Original minimal guest: import proc_exit, export memory, and call the
    /// import from _start. Encode directly so the test needs no WAT dependency.
    fn proc_exit_guest(status: i32) -> Vec<u8> {
        fn section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
            assert!(payload.len() < 128);
            module.extend_from_slice(&[id, payload.len() as u8]);
            module.extend_from_slice(payload);
        }
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        section(&mut module, 1, &[2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]);
        let mut import = vec![1, 22];
        import.extend_from_slice(b"wasi_snapshot_preview1");
        import.push(9);
        import.extend_from_slice(b"proc_exit");
        import.extend_from_slice(&[0, 0]);
        section(&mut module, 2, &import);
        section(&mut module, 3, &[1, 1]);
        section(&mut module, 5, &[1, 0, 1]);
        let mut exports = vec![2, 6];
        exports.extend_from_slice(b"_start");
        exports.extend_from_slice(&[0, 1, 6]);
        exports.extend_from_slice(b"memory");
        exports.extend_from_slice(&[2, 0]);
        section(&mut module, 7, &exports);
        let mut body = vec![0, 0x41]; // no locals; i32.const (signed LEB128)
        let mut remaining = status;
        loop {
            let byte = (remaining & 0x7f) as u8;
            remaining >>= 7;
            let done = (remaining == 0 && byte & 0x40 == 0)
                || (remaining == -1 && byte & 0x40 != 0);
            body.push(if done { byte } else { byte | 0x80 });
            if done { break; }
        }
        body.extend_from_slice(&[0x10, 0, 0x0b]); // call proc_exit; end
        let mut code = vec![1, body.len() as u8];
        code.extend_from_slice(&body);
        section(&mut module, 10, &code);
        module
    }

    #[test]
    fn real_wasi_proc_exit_preserves_ordinary_native_statuses() {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config).unwrap();
        for (status, expected) in [(23, 23), (126, 126), (143, 143), (255, 255), (-1, 255), (256, 0)] {
            let module = Module::new(&engine, proc_exit_guest(status)).unwrap();
            let runtime = process::Runtime::new(engine.clone(), module, Vec::new());
            let outcome = run_instance(runtime, Vec::new(), Vec::new(), process::Stdio::inherited(), Arc::default()).unwrap();
            assert_eq!(outcome, FinalOutcome::Exit(expected), "proc_exit({status})");
            assert_eq!(outcome.signal(), 0);
        }
    }

    #[test]
    fn explicit_exit_143_is_not_a_requested_term() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(15, 2), 0);
        assert!(cancel.kill(15));
        assert_eq!(select_instance_outcome(Err(I32Exit(143).into()), &cancel), FinalOutcome::Exit(143));
        assert!(!cancel.kill(9));
    }

    #[test]
    fn observed_term_survives_guest_error_conversion() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(15));
        assert!(cancel.check().is_err());
        assert_eq!(select_instance_outcome(Err(I32Exit(1).into()), &cancel), FinalOutcome::Signal(15));
    }

    #[test]
    fn accepted_kill_wins_before_an_explicit_exit() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(9));
        assert_eq!(select_instance_outcome(Err(I32Exit(143).into()), &cancel), FinalOutcome::Signal(9));
    }

    #[test]
    fn handled_term_does_not_relabel_an_unrelated_trap() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(15, 2), 0);
        assert!(cancel.kill(15));
        assert_eq!(select_instance_outcome(Err(anyhow::anyhow!("unreachable")), &cancel), FinalOutcome::Exit(134));
    }

    #[test]
    fn default_int_preserves_signal_kind_even_if_guest_returns_zero() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(2));
        let outcome = select_instance_outcome(Err(I32Exit(0).into()), &cancel);
        assert_eq!(outcome, FinalOutcome::Signal(2));
        assert_eq!(outcome.code(), 130);
    }

    #[test]
    fn handled_int_preserves_the_guests_own_zero_exit() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(2, 2), 0);
        assert!(cancel.kill(2));
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.signal(0, 0), 2);
        assert_eq!(select_instance_outcome(Err(I32Exit(0).into()), &cancel), FinalOutcome::Exit(0));
    }

    #[test]
    fn selected_success_rejects_late_kill() {
        let cancel = Cancellation::default();
        assert_eq!(select_instance_outcome(Ok(()), &cancel), FinalOutcome::Exit(0));
        assert!(!cancel.kill(9));
        assert_eq!(cancel.select(FinalOutcome::Signal(9)), FinalOutcome::Exit(0));
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
