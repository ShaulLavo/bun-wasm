//! bun-wasm runtime: a Bun-compatible JavaScript runtime for `wasm32-wasip1`.
//!
//! Rust owns the module loader, the event loop and the native primitives
//! (files, clocks, randomness, hashing, URL parsing, networking). The public
//! Bun/Node/Web APIs are JS polyfills in `src/js/`, built on the `native`
//! object from [`natives`]. The JavaScript engine sits behind the [`Engine`]
//! trait: QuickJS-ng by default, JavaScriptCore with the `engine-jsc` feature.

#![cfg_attr(target_os = "wasi", feature(wasi_ext))]
#![feature(io_error_more)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{self, BufWriter, Write};
use std::rc::Rc;
use std::time::Instant;

mod archive;
mod compression;
mod crypto;
pub(crate) mod data;
mod directory;
mod encoding;
pub mod engine;
#[cfg(feature = "engine-host")]
pub mod engine_host;
#[cfg(feature = "engine-jsc")]
mod engine_natives;
mod glob;
pub mod host;
mod html_rewriter;
pub mod init;
pub mod install;
mod modules;
mod natives;
mod node_path;
#[cfg(any(
    feature = "engine-split",
    feature = "engine-jsc",
    not(feature = "engine-host")
))]
pub(crate) mod ops;
mod resolve;
mod semver;
mod sourcemap;
mod sqlite;
mod streams;
pub mod transpiler;
mod wasm;
mod x509;
mod zlib_ffi;

#[cfg(feature = "engine-jsc")]
mod engine_jsc;
#[cfg(feature = "engine-split")]
mod split;
#[cfg(feature = "engine-split")]
mod split_api;
#[cfg(not(any(
    feature = "engine-split",
    feature = "engine-jsc",
    feature = "engine-host"
)))]
compile_error!("bunwasm-runtime needs an engine: feature engine-split, engine-jsc or engine-host");

pub use engine::{Engine, ModuleHost, NativeError, PromiseState, Val};
pub use transpiler::{
    BuildArtifact, BuildRequest, BuildResult, DevServerFile, DevServerResult, Loader,
    PassthroughTranspiler, Transpiled, Transpiler,
};

/// The engine this build uses.
#[cfg(feature = "engine-jsc")]
pub type ActiveEngine = engine_jsc::Jsc;

/// Bun version this runtime reports (from vendor/bun/package.json).
pub const BUN_VERSION: &str = env!("BUNWASM_BUN_VERSION");
/// Git revision of the vendored Bun sources.
pub const BUN_REVISION: &str = env!("BUNWASM_BUN_REVISION");

/// What to run.
pub enum Entry {
    /// A script path, absolute or relative to the working directory.
    File(String),
    /// Source code from `bun -e`.
    Eval(String),
    /// `bun test`: the arguments after `test` (filters and flags).
    Test(Vec<String>),
}

pub struct Options {
    pub entry: Entry,
    /// Arguments after the entry point, exposed through `process.argv`.
    pub args: Vec<String>,
    /// Custom package-export conditions supplied by the CLI.
    pub conditions: Vec<String>,
    /// Runtime flags exposed through `process.execArgv`.
    pub exec_argv: Vec<String>,
    pub transpiler: Box<dyn Transpiler>,
}

/// Engine-independent process state, shared by the module loader, the
/// natives and the event loop.
pub(crate) struct State {
    resolver: resolve::Resolver,
    transpiler: Box<dyn Transpiler>,
    /// Absolute path of the entry module (for `import.meta.main`).
    main: RefCell<String>,
    /// The entry point as given on the command line (for error messages).
    main_arg: RefCell<String>,
    /// Transpiled sources by path, with their module format.
    sources: RefCell<HashMap<String, (Rc<str>, modules::Format)>>,
    /// Content digest of each file the caches above and below were built from.
    source_digests: RefCell<HashMap<String, u64>>,
    #[cfg(feature = "engine-host")]
    source_imports: RefCell<HashMap<String, Rc<[transpiler::ModuleImport]>>>,
    #[cfg(feature = "engine-host")]
    cjs_sources: RefCell<HashMap<String, transpiler::Transpiled>>,
    /// Stack-position fixups for files whose evaluated code differs from the
    /// file on disk (transpiled code, injected ESM prologue).
    positions: RefCell<HashMap<String, modules::PositionMap>>,
    stdout: RefCell<BufWriter<io::Stdout>>,
    /// Set when `process.nextTick` queued work.
    /// Handled signals dequeued by a synchronous sleep, delivered at the next checkpoint.
    deferred_signals: RefCell<host::DeferredSignals>,
    tick_pending: Cell<bool>,
    fds: RefCell<natives::FdTable>,
    directories: Rc<RefCell<directory::Directories>>,
    start: Instant,
    argv: Vec<String>,
    exec_argv: Vec<String>,
}

impl State {
    #[cfg(test)]
    fn new(argv: Vec<String>, transpiler: Box<dyn Transpiler>) -> Self {
        Self::with_conditions(argv, Vec::new(), Vec::new(), transpiler)
    }

    fn with_conditions(
        argv: Vec<String>,
        conditions: Vec<String>,
        exec_argv: Vec<String>,
        transpiler: Box<dyn Transpiler>,
    ) -> Self {
        State {
            resolver: resolve::Resolver::with_conditions(conditions),
            transpiler,
            main: RefCell::new(String::new()),
            main_arg: RefCell::new(String::new()),
            sources: RefCell::new(HashMap::new()),
            source_digests: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-host")]
            source_imports: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-host")]
            cjs_sources: RefCell::new(HashMap::new()),
            positions: RefCell::new(HashMap::new()),
            stdout: RefCell::new(BufWriter::with_capacity(16 * 1024, io::stdout())),
            deferred_signals: RefCell::new(host::DeferredSignals::default()),
            tick_pending: Cell::new(false),
            fds: RefCell::new(natives::FdTable::default()),
            directories: Rc::new(RefCell::new(directory::Directories::default())),
            start: Instant::now(),
            argv,
            exec_argv,
        }
    }

    pub(crate) fn cwd(&self) -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .ok()
            .filter(|p| p.starts_with('/'))
            .unwrap_or_else(|| "/".to_owned())
    }

    pub(crate) fn write_stdout(&self, bytes: &[u8]) -> io::Result<()> {
        self.stdout.borrow_mut().write_all(bytes)
    }

    pub(crate) fn write_stderr(&self, bytes: &[u8]) -> io::Result<()> {
        // Keep stdout and stderr ordered relative to each other.
        self.flush();
        io::stderr().write_all(bytes)
    }

    pub(crate) fn flush_stdout(&self) -> io::Result<()> {
        self.stdout.borrow_mut().flush()
    }

    pub(crate) fn flush(&self) {
        let _ = self.flush_stdout();
    }

    /// Signal dispositions and delivery live in the process service (`runtime_proc.signal`). Only
    /// signals a synchronous sleep took from its queue are kept here, and they stay observable
    /// through the same operations: dequeue returns them first, and ignoring or restoring the
    /// default disposition withdraws them exactly as it would a pending service signal.
    pub(crate) fn signal(&self, signal: i32, operation: i32) -> i32 {
        if signal == 0 && operation == 0 {
            return host::next_signal(&mut self.deferred_signals.borrow_mut(), || {
                host::signal(0, 0)
            });
        } else if (operation == 0 || operation == 1)
            && self.deferred_signals.borrow_mut().withdraw(signal)
        {
            if operation == 1 {
                return host::signal(signal, 1);
            }
            // A pending delivery whose handler was removed takes the default action at once.
            let result = host::signal(signal, 0);
            return if result < 0 {
                result
            } else {
                host::signal(signal, 3)
            };
        }
        host::signal(signal, operation)
    }

    /// `Bun.sleepSync` and sleeping timers: cancellable by signals, without spinning.
    pub(crate) fn sleep(&self, duration: std::time::Duration) {
        host::sleep_with(
            duration,
            &mut self.deferred_signals.borrow_mut(),
            || host::signal(0, 0),
            host::idle,
        );
    }

    pub(crate) fn exit(&self, code: i32) -> ! {
        self.directories.borrow_mut().close_all();
        self.flush();
        // Skip engine teardown: values are still rooted (and JSC's VM
        // teardown aborts); the process is going away anyway.
        std::process::exit(code)
    }
}

#[cfg(feature = "engine-jsc")]
type ModuleHandoffs<V> = RefCell<HashMap<String, (V, V)>>;

#[cfg(feature = "engine-jsc")]
/// The runtime's engine-facing half: the `internal` object the bootstrap
/// returned, pending wrapper-module handoffs, and the module host.
pub(crate) struct Core<E: Engine> {
    pub(crate) state: Rc<State>,
    internal: RefCell<Option<E::Value>>,
    /// Exports objects of wrapper modules, until their `import.meta` is set.
    handoffs: ModuleHandoffs<E::Value>,
}

#[cfg(feature = "engine-jsc")]
#[path = "../../bunwasm-engine-quickjs/src/loader.rs"]
mod engine_loader;
#[cfg(feature = "engine-jsc")]
#[path = "../../bunwasm-engine-quickjs/src/program.rs"]
mod program;

#[cfg(feature = "engine-jsc")]
impl<E: Engine> Core<E> {
    fn bootstrap(self: &Rc<Self>, e: &E) -> Result<E::Value, E::Value> {
        engine_natives::bootstrap(e, self)
    }
    fn eval_source(&self, code: &str) -> Result<(String, String), NativeError> {
        Ok(modules::eval_entry(&self.state, code))
    }
    fn take_tick(&self) -> bool {
        self.state.tick_pending.replace(false)
    }
    fn flush(&self) {
        self.state.flush();
    }
    fn write_error(&self, text: &str) {
        let _ = self.state.write_stderr(text.as_bytes());
    }
    fn exit(&self, code: i32) -> ! {
        self.state.exit(code)
    }
    fn idle(&self, ms: i32) {
        host::idle(ms);
    }
    fn poll(&self, ms: i32) {
        if host::poll(ms) == host::UNSUPPORTED {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    pub(crate) fn compile_cjs(&self, path: &str) -> Result<(String, i32), NativeError> {
        let (code, _) = self.state.load_source(path)?;
        Ok(modules::cjs_wrapper(&code))
    }
    pub(crate) fn polyfill(&self, name: &str) -> Result<String, NativeError> {
        modules::polyfill_source(name)
            .map(str::to_owned)
            .ok_or_else(|| NativeError::error(format!("bun-wasm: missing internal module {name}")))
    }
    pub(crate) fn resolve_module(
        &self,
        specifier: &str,
        referrer: &str,
    ) -> Result<String, NativeError> {
        let from = if referrer.is_empty() || resolve::builtin_name(referrer).is_some() {
            format!("{}/", self.state.cwd())
        } else {
            referrer.to_owned()
        };
        match self
            .state
            .resolver
            .resolve(specifier, &from, resolve::Kind::Import)
        {
            Ok(resolve::Resolved::Builtin(name) | resolve::Resolved::File(name)) => Ok(name),
            Err(message) => Err(modules::resolve_error(
                &message,
                specifier,
                &from,
                resolve::Kind::Import,
                self.state.resolver.notes(),
            )),
        }
    }
    pub(crate) fn module_source(&self, name: &str) -> Result<(String, String), NativeError> {
        if resolve::builtin_name(name).is_some() {
            return Ok(("builtin".into(), String::new()));
        }
        let (code, format) = self.state.load_source(name)?;
        let source = if format == modules::Format::Esm {
            modules::esm_source(&self.state, name, &code)
        } else {
            code.to_string()
        };
        Ok((format.name().into(), source))
    }
    pub(crate) fn wrapper_source(&self, keys: Vec<String>) -> Result<String, NativeError> {
        Ok(modules::wrapper_source(&keys))
    }
    pub(crate) fn is_main(&self, name: &str) -> Result<bool, NativeError> {
        Ok(*self.state.main.borrow() == name)
    }
    pub(crate) fn has_interrupt_handler(&self) -> bool {
        host::PROCESS_ABI
    }
    pub(crate) fn interrupt(&self) -> bool {
        host::signal(0, 4) < 0
    }
}

/// Run a program to completion; returns the process exit code. With the
/// host engine (`engine-host`) this only sets the program up: the host runs
/// it after `_start` returns (see [`host_engine_ready`]).
#[cfg(feature = "engine-jsc")]
pub fn run(options: Options) -> i32 {
    run_with::<ActiveEngine>(options)
}

#[cfg(all(
    feature = "engine-host",
    not(any(feature = "engine-split", feature = "engine-jsc"))
))]
pub fn run(options: Options) -> i32 {
    let Options {
        entry,
        args,
        conditions,
        exec_argv,
        transpiler,
    } = options;
    let (state, main_path) = new_state(&entry, &args, &conditions, &exec_argv, transpiler);
    engine_host::init(entry, state, main_path)
}

#[cfg(feature = "engine-split")]
pub fn run(options: Options) -> i32 {
    split::run(options)
}

/// True when `run` handed the program to the host engine (the binary must
/// then return from `main` instead of exiting).
pub fn host_engine_ready() -> bool {
    #[cfg(feature = "engine-host")]
    {
        engine_host::bunwasm_ready() == 1
    }
    #[cfg(not(feature = "engine-host"))]
    {
        false
    }
}

/// The process state for a program, and the entry's absolute path.
fn new_state(
    entry: &Entry,
    args: &[String],
    conditions: &[String],
    exec_argv: &[String],
    transpiler: Box<dyn Transpiler>,
) -> (Rc<State>, String) {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    let main_path = match entry {
        Entry::File(path) if path == "-" => format!("{}/[stdin]", cwd.trim_end_matches('/')),
        Entry::File(path) => resolve::join(&cwd, path),
        Entry::Eval(_) => format!("{}/[eval]", cwd.trim_end_matches('/')),
        Entry::Test(_) => format!("{}/", cwd.trim_end_matches('/')),
    };
    // Like Bun, `-e` code gets no script path in argv.
    let script = match entry {
        Entry::File(path) if path == "-" => Some("-".to_owned()),
        Entry::File(_) => Some(main_path.clone()),
        Entry::Eval(_) => None,
        Entry::Test(_) => Some("test".to_owned()),
    };
    let argv = std::iter::once(std::env::args().next().unwrap_or_else(|| "bun".into()))
        .chain(script)
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let state = Rc::new(State::with_conditions(
        argv,
        conditions.to_vec(),
        exec_argv.to_vec(),
        transpiler,
    ));
    *state.main.borrow_mut() = main_path.clone();
    if let Entry::File(arg) = entry {
        *state.main_arg.borrow_mut() = arg.clone();
    }
    (state, main_path)
}

#[cfg(feature = "engine-jsc")]
fn run_with<E: Engine>(options: Options) -> i32 {
    let Options {
        entry,
        args,
        conditions,
        exec_argv,
        transpiler,
    } = options;
    let (state, main_path) = new_state(&entry, &args, &conditions, &exec_argv, transpiler);
    let options = Options {
        entry,
        args,
        conditions: Vec::new(),
        exec_argv: Vec::new(),
        transpiler: Box::new(PassthroughTranspiler),
    };

    let core = Rc::new(Core::<E> {
        state: state.clone(),
        internal: RefCell::new(None),
        handoffs: RefCell::new(HashMap::new()),
    });
    let engine = E::new(core.clone());
    let code = program::run_in_engine(&engine, &core, &options.entry, &main_path);
    state.directories.borrow_mut().close_all();
    state.flush();
    // Skip teardown (see State::exit).
    std::mem::forget(engine);
    code
}
