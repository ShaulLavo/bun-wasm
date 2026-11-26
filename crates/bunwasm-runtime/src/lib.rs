//! bun-wasm runtime: a Bun-compatible JavaScript runtime for `wasm32-wasip1`.
//!
//! Rust owns the module loader, the event loop and the native primitives
//! (files, clocks, randomness, hashing, URL parsing, networking). The public
//! Bun/Node/Web APIs are JS polyfills in `src/js/`, built on the `native`
//! object from [`natives`]. The JavaScript engine sits behind the `Engine`
//! trait in the linked engine program; the core itself remains engine-free.

#![cfg_attr(target_os = "wasi", feature(wasi_ext))]
#![feature(io_error_more)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{self, BufWriter, Write};
use std::rc::Rc;
use std::time::Instant;

mod archive;
mod bun_hash;
mod compression;
mod crypto;
mod crypto_ec;
mod crypto_pqc;
mod csrf;
pub(crate) mod data;
mod directory;
mod encoding;
#[cfg(all(test, feature = "engine-split"))]
#[allow(dead_code, unused_imports)]
mod engine;
#[cfg(feature = "engine-host")]
pub mod engine_host;
mod glob;
pub mod host;
mod hot_run;
mod html_rewriter;
pub mod import_requests;
pub mod init;
pub mod install;
mod intl;
mod mime_types;
mod modules;
mod natives;
mod node_cipher;
mod node_dh;
mod node_digest;
mod node_path;
mod node_rsa;
#[cfg(any(feature = "engine-split", not(feature = "engine-host")))]
pub(crate) mod ops;
mod parse_env;
mod password;
#[cfg(all(test, feature = "engine-split"))]
#[allow(dead_code)]
#[path = "../../bunwasm-engine-quickjs/src/vm.rs"]
mod quickjs_embedding;
#[cfg(all(test, feature = "engine-split"))]
#[path = "../../bunwasm-engine-quickjs/src/rejection_queue.rs"]
mod rejection_queue;
// Bun's diff printer, copied from vendor/bun (docs/bun-patches/test-diff-printer.md).
mod print_diff;
mod resolve;
mod semver;
mod source_column;
mod sourcemap;
mod sqlite;
mod streams;
mod test_diff;
mod time_zone;
mod tls;
pub mod transpiler;
#[cfg(feature = "engine-split")]
mod wasm;
// Declared here and not in `wasm.rs`: `scripts/wasm-tables.test.ts` builds `wasm.rs` into a
// crate of its own, and that crate has no `compression` module, whose test allocator this
// test counts with.
#[cfg(all(test, feature = "engine-split"))]
#[path = "wasm/lane_allocation_tests.rs"]
mod lane_allocation_tests;
mod x509;
mod zlib_ffi;

#[cfg(feature = "engine-split")]
mod split;
#[cfg(feature = "engine-split")]
mod split_api;
#[cfg(not(any(feature = "engine-split", feature = "engine-host")))]
compile_error!("bunwasm-runtime needs an engine: feature engine-split or engine-host");

pub use data::{NativeError, Val};
pub use transpiler::{
    BuildArtifact, BuildRequest, BuildResult, ColorInput, ColorValue, DevServerFile,
    DevServerResult, Loader, MarkdownRequest, PassthroughTranspiler, RecordError, Transpiled,
    Transpiler,
};

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RunMode {
    #[default]
    Once,
    Hot,
}

pub struct Options {
    pub mode: RunMode,
    pub entry: Entry,
    /// Arguments after the entry point, exposed through `process.argv`.
    pub args: Vec<String>,
    /// Custom package-export conditions supplied by the CLI.
    pub conditions: Vec<String>,
    /// Runtime flags exposed through `process.execArgv`.
    pub exec_argv: Vec<String>,
    /// True when `--experimental-stream-iter` was parsed as an explicit runtime option.
    pub experimental_stream_iter: bool,
    pub transpiler: Box<dyn Transpiler>,
}

/// Engine-independent process state, shared by the module loader, the
/// natives and the event loop.
pub(crate) struct State {
    resolver: resolve::Resolver,
    import_requests: RefCell<import_requests::ImportRequests>,
    transpiler: Box<dyn Transpiler>,
    /// Absolute path of the entry module (for `import.meta.main`).
    main: RefCell<String>,
    /// The entry point as given on the command line (for error messages).
    main_arg: RefCell<String>,
    /// Transpiled sources by path, with their module format.
    sources: RefCell<HashMap<String, (Rc<str>, modules::Format)>>,
    /// Content digest of each file the caches above and below were built from.
    source_digests: RefCell<HashMap<String, u64>>,
    /// The CommonJS file the latest `load_source` read, until another load or a path change:
    /// the compile step right after a format check reuses that read (`load_source_once`).
    fresh_source: RefCell<Option<String>>,
    #[cfg(feature = "engine-host")]
    source_imports: RefCell<HashMap<String, Rc<[transpiler::ModuleImport]>>>,
    #[cfg(feature = "engine-host")]
    cjs_sources: RefCell<HashMap<String, transpiler::Transpiled>>,
    /// Stack-position fixups for files whose evaluated code differs from the
    /// file on disk (transpiled code, injected ESM prologue).
    positions: RefCell<HashMap<String, modules::PositionMap>>,
    /// Moves whenever `sources` or `positions` change, so a cache of formatted
    /// stack frames knows when to empty (`sourceGeneration`).
    source_generation: Cell<u32>,
    /// The original file most recently read for an error excerpt.
    last_original: RefCell<Option<(String, Rc<str>)>>,
    /// Cached line spans and UTF-16 column checkpoints for stack-frame lookups.
    source_columns: RefCell<source_column::SourceIndexCache>,
    stdout: RefCell<BufWriter<io::Stdout>>,
    /// Set when `process.nextTick` queued work.
    /// Handled signals dequeued by a synchronous sleep, delivered at the next checkpoint.
    deferred_signals: RefCell<host::DeferredSignals>,
    tick_pending: Cell<bool>,
    fds: RefCell<natives::FdTable>,
    #[cfg(target_os = "wasi")]
    modes: RefCell<HashMap<(u64, u64), u32>>,
    directories: Rc<RefCell<directory::Directories>>,
    tls: tls::SharedRegistry,
    start: Instant,
    argv: Vec<String>,
    exec_argv: Vec<String>,
    experimental_stream_iter: bool,
    mode: RunMode,
}

impl State {
    #[cfg(test)]
    fn new(argv: Vec<String>, transpiler: Box<dyn Transpiler>) -> Self {
        Self::with_conditions(argv, Vec::new(), Vec::new(), false, transpiler)
    }

    fn with_conditions(
        argv: Vec<String>,
        conditions: Vec<String>,
        exec_argv: Vec<String>,
        experimental_stream_iter: bool,
        transpiler: Box<dyn Transpiler>,
    ) -> Self {
        State {
            resolver: resolve::Resolver::with_conditions(conditions)
                .with_experimental_stream_iter(experimental_stream_iter),
            import_requests: RefCell::new(import_requests::ImportRequests::default()),
            transpiler,
            main: RefCell::new(String::new()),
            main_arg: RefCell::new(String::new()),
            sources: RefCell::new(HashMap::new()),
            source_digests: RefCell::new(HashMap::new()),
            fresh_source: RefCell::new(None),
            #[cfg(feature = "engine-host")]
            source_imports: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-host")]
            cjs_sources: RefCell::new(HashMap::new()),
            positions: RefCell::new(HashMap::new()),
            source_generation: Cell::new(0),
            last_original: RefCell::new(None),
            source_columns: RefCell::new(source_column::SourceIndexCache::default()),
            stdout: RefCell::new(BufWriter::with_capacity(16 * 1024, io::stdout())),
            deferred_signals: RefCell::new(host::DeferredSignals::default()),
            tick_pending: Cell::new(false),
            fds: RefCell::new(natives::FdTable::default()),
            #[cfg(target_os = "wasi")]
            modes: RefCell::new(HashMap::new()),
            directories: Rc::new(RefCell::new(directory::Directories::default())),
            tls: tls::new_shared_registry(tls::snapshot_startup_extras()),
            start: Instant::now(),
            argv,
            exec_argv,
            experimental_stream_iter,
            mode: RunMode::Once,
        }
    }

    pub(crate) fn is_builtin_name(&self, name: &str) -> bool {
        self.resolver.builtin_name(name).is_some()
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

    pub(crate) fn dispose_tls(&self) {
        self.tls.borrow_mut().dispose();
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
        self.dispose_tls();
        self.directories.borrow_mut().close_all();
        self.flush();
        // The linked engine program remains rooted until process exit.
        std::process::exit(code)
    }
}

#[cfg(all(feature = "engine-host", not(feature = "engine-split")))]
pub fn run(options: Options) -> i32 {
    let Options {
        entry,
        args,
        conditions,
        exec_argv,
        experimental_stream_iter,
        transpiler,
        mode,
    } = options;
    let (state, main_path) = new_state(
        &entry,
        &args,
        &conditions,
        &exec_argv,
        experimental_stream_iter,
        mode,
        transpiler,
    );
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
    experimental_stream_iter: bool,
    mode: RunMode,
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
    if mode == RunMode::Hot {
        transpiler.use_module_records();
    }
    let mut state = State::with_conditions(
        argv,
        conditions.to_vec(),
        exec_argv.to_vec(),
        experimental_stream_iter,
        transpiler,
    );
    state.mode = mode;
    let state = Rc::new(state);
    *state.main.borrow_mut() = main_path.clone();
    if let Entry::File(arg) = entry {
        *state.main_arg.borrow_mut() = arg.clone();
    }
    (state, main_path)
}
