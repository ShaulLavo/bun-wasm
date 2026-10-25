//! bun-wasm runtime: a Bun-compatible JavaScript runtime for `wasm32-wasip1`.
//!
//! Rust owns the module loader, the event loop and the native primitives
//! (files, clocks, randomness, hashing, URL parsing, networking). The public
//! Bun/Node/Web APIs are JS polyfills in `src/js/`, built on the `native`
//! object from [`natives`]. The JavaScript engine sits behind the [`Engine`]
//! trait: QuickJS-ng by default, JavaScriptCore with the `engine-jsc` feature, Hermes with
//! `engine-hermes`.

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
mod directory;
mod encoding;
pub mod engine;
#[cfg(feature = "engine-host")]
pub mod engine_host;
#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
mod engine_natives;
mod glob;
pub mod host;
mod html_rewriter;
pub mod install;
mod modules;
mod natives;
mod node_path;
mod resolve;
mod semver;
mod sourcemap;
mod sqlite;
mod streams;
pub mod transpiler;
mod wasm;
mod x509;
mod zlib_ffi;

#[cfg(all(feature = "engine-jsc", not(feature = "engine-quickjs")))]
mod engine_jsc;
#[cfg(all(
    feature = "engine-hermes",
    not(any(feature = "engine-quickjs", feature = "engine-jsc"))
))]
mod engine_hermes;
#[cfg(feature = "engine-quickjs")]
mod engine_quickjs;
#[cfg(not(any(
    feature = "engine-quickjs",
    feature = "engine-jsc",
    feature = "engine-hermes",
    feature = "engine-host"
)))]
compile_error!(
    "bunwasm-runtime needs an engine: feature engine-quickjs, engine-jsc, engine-hermes or engine-host"
);

pub use engine::{Engine, ModuleHost, NativeError, PromiseState, Val};
pub use transpiler::{
    BuildArtifact, BuildRequest, BuildResult, DevServerFile, DevServerResult, Loader,
    PassthroughTranspiler, Transpiled, Transpiler,
};

/// The engine this build uses.
#[cfg(feature = "engine-quickjs")]
pub type ActiveEngine = engine_quickjs::QuickJs;
#[cfg(all(feature = "engine-jsc", not(feature = "engine-quickjs")))]
pub type ActiveEngine = engine_jsc::Jsc;
#[cfg(all(
    feature = "engine-hermes",
    not(any(feature = "engine-quickjs", feature = "engine-jsc"))
))]
pub type ActiveEngine = engine_hermes::Hermes;

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
}

impl State {
    fn new(argv: Vec<String>, transpiler: Box<dyn Transpiler>) -> Self {
        State {
            resolver: resolve::Resolver::new(),
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

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
type ModuleHandoffs<V> = RefCell<HashMap<String, (V, V)>>;

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
/// The runtime's engine-facing half: the `internal` object the bootstrap
/// returned, pending wrapper-module handoffs, and the module host.
pub(crate) struct Core<E: Engine> {
    pub(crate) state: Rc<State>,
    internal: RefCell<Option<E::Value>>,
    /// Exports objects of wrapper modules, until their `import.meta` is set.
    handoffs: ModuleHandoffs<E::Value>,
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
impl<E: Engine> Core<E> {
    pub(crate) fn internal(&self, e: &E) -> E::Value {
        self.internal
            .borrow()
            .clone()
            .unwrap_or_else(|| e.undefined())
    }

    pub(crate) fn call_internal(
        &self,
        e: &E,
        name: &str,
        args: &[E::Value],
    ) -> Result<E::Value, E::Value> {
        let internal = self.internal(e);
        let f = e.get(&internal, name)?;
        e.call(&f, &internal, args)
    }

    fn call_internal_num(&self, e: &E, name: &str) -> Result<f64, E::Value> {
        let v = self.call_internal(e, name, &[])?;
        Ok(match e.to_val(&v) {
            Val::Num(n) => n,
            Val::Bool(b) => f64::from(u8::from(b)),
            _ => 0.0,
        })
    }

    /// Run `process.nextTick` callbacks and promise jobs until both queues
    /// are empty. Returns whether anything ran.
    pub(crate) fn drain_jobs(&self, e: &E) -> bool {
        let mut ran = false;
        loop {
            if self.state.tick_pending.replace(false) {
                ran = true;
                if let Err(err) = self.call_internal(e, "runTicks", &[]) {
                    self.uncaught(e, err);
                }
                continue;
            }
            if !e.run_jobs() {
                break;
            }
            ran = true;
        }
        ran
    }

    /// An uncaught error: `process.on("uncaughtException")` handlers get it
    /// first, otherwise it is printed the way Bun does and the process exits 1.
    pub(crate) fn uncaught(&self, e: &E, err: E::Value) {
        self.uncaught_values(e, "handleUncaught", &[err]);
    }

    fn uncaught_values(&self, e: &E, handler: &str, values: &[E::Value]) {
        match self.call_internal(e, handler, values) {
            Ok(handled) if e.to_val(&handled) == Val::Bool(true) => return,
            Ok(_) => {}
            Err(fallback) => {
                let text = match e.to_val(&fallback) {
                    Val::Str(s) => s,
                    _ => String::from("uncaught error while reporting an error"),
                };
                let _ = self
                    .state
                    .write_stderr(format!("error: {text}\n").as_bytes());
            }
        }
        self.state.exit(1)
    }

    /// Report promises that are still unhandled once the microtask queue
    /// drained (Bun treats an unhandled rejection as fatal).
    fn check_rejections(&self, e: &E) {
        for (promise, reason) in e.take_unhandled_rejections() {
            self.uncaught_values(e, "handleRejection", &[reason, promise]);
        }
    }
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
impl<E: Engine> ModuleHost<E> for Core<E> {
    fn has_interrupt_handler(&self) -> bool {
        host::PROCESS_ABI
    }

    fn interrupt(&self) -> bool {
        // Never call guest JS here: QuickJS also polls during native operations,
        // and interpreter checkpoints may interrupt runtime JS bookkeeping.
        // Mode 4 leaves handled signals pending for the next event-loop turn,
        // matching Node. Fatal host outcomes unwind Wasm without catch/finally.
        host::signal(0, 4) < 0
    }

    fn resolve(&self, e: &E, specifier: &str, referrer: &str) -> Result<String, E::Value> {
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
            Ok(resolve::Resolved::Builtin(b)) => Ok(b),
            Ok(resolve::Resolved::File(f)) => Ok(f),
            Err(msg) => Err(e.error_value(&modules::resolve_error(
                &msg,
                specifier,
                &from,
                resolve::Kind::Import,
                self.state.resolver.notes(),
            ))),
        }
    }

    fn load(&self, e: &E, name: &str) -> Result<String, E::Value> {
        if resolve::builtin_name(name).is_some() {
            let exports = self.call_internal(e, "builtin", &[e.value_from(name.into())])?;
            let keys = e.keys(&exports);
            // A builtin marked `__esModule` (bun:sqlite) names its own default
            // export; for the rest the default is the exports object.
            let flagged = e
                .get(&exports, "__esModule")
                .map(|v| e.to_val(&v) == Val::Bool(true))
                .unwrap_or(false);
            let default = if flagged {
                e.get(&exports, "default")?
            } else {
                exports.clone()
            };
            self.handoffs
                .borrow_mut()
                .insert(name.to_owned(), (exports, default));
            return Ok(modules::wrapper_source(&keys));
        }
        let (code, format) = self
            .state
            .load_source(name)
            .map_err(|err| e.error_value(&err))?;
        if format == modules::Format::Esm {
            return Ok(modules::esm_source(&self.state, name, &code));
        }
        // The JS side evaluates it (sharing require's cache) and returns
        // [namespaceObject, defaultExport].
        let args = [
            e.value_from(name.into()),
            e.value_from(format.name().into()),
        ];
        let pair = self.call_internal(e, "importNonEsm", &args)?;
        let (value, default) = (e.get(&pair, "0")?, e.get(&pair, "1")?);
        let keys = e.keys(&value);
        self.handoffs
            .borrow_mut()
            .insert(name.to_owned(), (value, default));
        Ok(modules::wrapper_source(&keys))
    }

    fn init_meta(&self, e: &E, name: &str, meta: &E::Value) -> Result<(), E::Value> {
        let handoff = self.handoffs.borrow_mut().remove(name);
        if let Some((value, default)) = handoff {
            let m = e.new_object();
            e.set(&m, "value", value)?;
            e.set(&m, "default", default)?;
            return e.set(meta, "m", m);
        }
        let is_main = *self.state.main.borrow() == name;
        let args = [
            meta.clone(),
            e.value_from(name.into()),
            e.value_from(is_main.into()),
        ];
        self.call_internal(e, "initImportMeta", &args).map(|_| ())
    }
}

/// Run a program to completion; returns the process exit code. With the
/// host engine (`engine-host`) this only sets the program up: the host runs
/// it after `_start` returns (see [`host_engine_ready`]).
#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
pub fn run(options: Options) -> i32 {
    run_with::<ActiveEngine>(options)
}

#[cfg(all(
    feature = "engine-host",
    not(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))
))]
pub fn run(options: Options) -> i32 {
    let Options {
        entry,
        args,
        transpiler,
    } = options;
    let (state, main_path) = new_state(&entry, &args, transpiler);
    engine_host::init(entry, state, main_path)
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
    transpiler: Box<dyn Transpiler>,
) -> (Rc<State>, String) {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    let main_path = match entry {
        Entry::File(path) => resolve::join(&cwd, path),
        Entry::Eval(_) => format!("{}/[eval]", cwd.trim_end_matches('/')),
        Entry::Test(_) => format!("{}/", cwd.trim_end_matches('/')),
    };
    // Like Bun, `-e` code gets no script path in argv.
    let script = match entry {
        Entry::File(_) => Some(main_path.clone()),
        Entry::Eval(_) => None,
        Entry::Test(_) => Some("test".to_owned()),
    };
    let argv = std::iter::once(std::env::args().next().unwrap_or_else(|| "bun".into()))
        .chain(script)
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let state = Rc::new(State::new(argv, transpiler));
    *state.main.borrow_mut() = main_path.clone();
    if let Entry::File(arg) = entry {
        *state.main_arg.borrow_mut() = arg.clone();
    }
    (state, main_path)
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
fn run_with<E: Engine>(options: Options) -> i32 {
    let Options {
        entry,
        args,
        transpiler,
    } = options;
    let (state, main_path) = new_state(&entry, &args, transpiler);
    let options = Options {
        entry,
        args,
        transpiler: Box::new(PassthroughTranspiler),
    };

    let core = Rc::new(Core::<E> {
        state: state.clone(),
        internal: RefCell::new(None),
        handoffs: RefCell::new(HashMap::new()),
    });
    let engine = E::new(core.clone());
    let code = run_in_engine(&engine, &core, &options.entry, &main_path);
    state.directories.borrow_mut().close_all();
    state.flush();
    // Skip teardown (see State::exit).
    std::mem::forget(engine);
    code
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
fn run_in_engine<E: Engine>(e: &E, core: &Rc<Core<E>>, entry: &Entry, main_path: &str) -> i32 {
    match engine_natives::bootstrap(e, core) {
        Ok(internal) => *core.internal.borrow_mut() = Some(internal),
        Err(err) => {
            eprintln!("bun-wasm: bootstrap failed: {:?}", e.to_val(&err));
            return 70;
        }
    }
    let started = match entry {
        Entry::Eval(code) => {
            let (name, source) = modules::eval_entry(&core.state, code);
            e.eval_module(&name, &source)
        }
        Entry::File(_) => core.call_internal(e, "runMain", &[e.value_from(main_path.into())]),
        Entry::Test(args) => {
            let list = Val::Array(args.iter().map(|a| Val::from(a.as_str())).collect());
            core.call_internal(e, "runTests", &[e.value_from(list)])
        }
    };
    let main_promise = match started {
        Ok(v) => e.promise_state(&v).map(|_| v),
        Err(err) => {
            core.uncaught(e, err);
            None
        }
    };
    run_event_loop(e, core, main_promise, matches!(entry, Entry::Test(_)));
    match core.call_internal_num(e, "beforeExit") {
        Ok(code) => code as i32,
        Err(err) => {
            core.uncaught(e, err);
            0
        }
    }
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
/// The event loop: microtasks and ticks, then one due timer at a time;
/// sleeps (WASI `poll_oneoff`, or the host's poll while sockets are open)
/// until the next timer when idle.
fn run_event_loop<E: Engine>(e: &E, core: &Core<E>, main: Option<E::Value>, test_command: bool) {
    let mut main = main;
    loop {
        // Signal handlers run only at cooperative guest checkpoints. Pending
        // signals do not count as work keeping an otherwise-finished loop alive.
        if let Err(err) = core.call_internal(e, "pumpSignals", &[]) {
            core.uncaught(e, err);
        }
        core.drain_jobs(e);
        if let Some(promise) = main.take() {
            main = check_main_promise(e, core, promise);
        }
        core.check_rejections(e);
        if test_command && main.is_none() {
            break;
        }
        // runTimers returns: 0 = another turn is ready, >0 = ms until the
        // next timer, <0 = nothing left keeping the loop alive.
        let next = match core.call_internal_num(e, "runTimers") {
            Ok(next) => next,
            Err(err) => {
                core.uncaught(e, err);
                0.0
            }
        };
        if next == 0.0 {
            continue;
        }
        // Network handles (docs/host-abi.md): pump them, then sleep in the
        // host's poll until news or the next timer instead of a plain sleep.
        if core.call_internal_num(e, "ioPending").unwrap_or(0.0) > 0.0 {
            match core.call_internal_num(e, "pumpIo") {
                Ok(progressed) if progressed != 0.0 => continue,
                Ok(_) => {}
                Err(err) => {
                    core.uncaught(e, err);
                    continue;
                }
            }
            if core.drain_jobs(e) {
                continue;
            }
            core.state.flush();
            let wait = if next < 0.0 {
                25
            } else {
                (next.ceil() as i32).clamp(1, 25)
            };
            // Waiters that only watch runtime_proc descriptors and children sleep in
            // proc_poll for exactly what they watch; anything else uses the host poll.
            let slept = match core.call_internal(e, "ioWait", &[e.value_from(wait.into())]) {
                Ok(value) => matches!(e.to_val(&value), Val::Bool(true)),
                Err(err) => {
                    core.uncaught(e, err);
                    continue;
                }
            };
            if !slept && host::poll(wait) == host::UNSUPPORTED {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            if let Err(err) = core.call_internal(e, "pumpIo", &[]) {
                core.uncaught(e, err);
            }
            continue;
        }
        if next < 0.0 {
            if core.drain_jobs(e) {
                continue;
            }
            if let Some(promise) = main.take() {
                // Top-level await that can never finish: Bun exits quietly.
                main = check_main_promise(e, core, promise);
            }
            // `beforeExit` listeners may schedule more work.
            match core.call_internal_num(e, "emitBeforeExit") {
                Ok(n) if n != 0.0 => continue,
                _ => break,
            }
        }
        core.state.flush();
        // Reenter the checkpoint after one bounded wait rather than sleeping through the whole
        // timer delay. With no network handle to watch this is the process poll, which a handled
        // signal or interrupt wakes; the network host poll only knows about network events.
        host::idle((next.ceil() as i32).clamp(1, 25));
    }
}

#[cfg(any(feature = "engine-quickjs", feature = "engine-jsc", feature = "engine-hermes"))]
/// Surface a rejected entry module; keep pending ones around.
fn check_main_promise<E: Engine>(e: &E, core: &Core<E>, promise: E::Value) -> Option<E::Value> {
    match e.promise_state(&promise) {
        Some(PromiseState::Pending) => Some(promise),
        Some(PromiseState::Rejected) => {
            let reason = e.promise_result(&promise);
            // The rejection tracker saw this promise too; don't report twice.
            let others: Vec<_> = e
                .take_unhandled_rejections()
                .into_iter()
                .filter(|(p, _)| !e.same_value(p, &promise))
                .collect();
            core.uncaught_values(e, "handleUncaught", &[reason]);
            for (promise, reason) in others {
                core.uncaught_values(e, "handleRejection", &[reason, promise]);
            }
            None
        }
        _ => None,
    }
}
