//! bun-wasm runtime: a Bun-compatible JavaScript runtime on QuickJS-ng
//! (through rquickjs), built for `wasm32-wasip1`.
//!
//! Rust owns the engine, the module loader, the event loop and the native
//! primitives (files, clocks, randomness, hashing, URL parsing). The public
//! Bun/Node/Web APIs are JS polyfills in `src/js/`, built on the `native`
//! object from [`natives`].

#![cfg_attr(target_os = "wasi", feature(wasi_ext))]
#![feature(io_error_more)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{self, BufWriter, Write};
use std::rc::Rc;
use std::time::Instant;

use rquickjs::{Context, Ctx, Function, Object, Persistent, Promise, Runtime, Value};

mod encoding;
mod modules;
mod natives;
mod resolve;
pub mod transpiler;

pub use transpiler::{Loader, PassthroughTranspiler, Transpiler};

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
}

pub struct Options {
    pub entry: Entry,
    /// Arguments after the entry point, exposed through `process.argv`.
    pub args: Vec<String>,
    pub transpiler: Box<dyn Transpiler>,
}

type SavedValue = Persistent<Value<'static>>;

/// Shared by the module loader, the natives and the event loop.
pub(crate) struct State {
    resolver: resolve::Resolver,
    transpiler: Box<dyn Transpiler>,
    /// Absolute path of the entry module (for `import.meta.main`).
    main: RefCell<String>,
    /// Transpiled sources by path, with their module format.
    sources: RefCell<HashMap<String, (Rc<str>, modules::Format)>>,
    stdout: RefCell<BufWriter<io::Stdout>>,
    /// Set when `process.nextTick` queued work.
    tick_pending: Cell<bool>,
    /// Rejected promises without a handler yet: (promise, reason).
    rejections: RefCell<Vec<(SavedValue, SavedValue)>>,
    internal: RefCell<Option<Persistent<Object<'static>>>>,
    fds: RefCell<natives::FdTable>,
    start: Instant,
    argv: Vec<String>,
}

impl State {
    fn new(argv: Vec<String>, transpiler: Box<dyn Transpiler>) -> Self {
        State {
            resolver: resolve::Resolver::new(),
            transpiler,
            main: RefCell::new(String::new()),
            sources: RefCell::new(HashMap::new()),
            stdout: RefCell::new(BufWriter::with_capacity(16 * 1024, io::stdout())),
            tick_pending: Cell::new(false),
            rejections: RefCell::new(Vec::new()),
            internal: RefCell::new(None),
            fds: RefCell::new(natives::FdTable::default()),
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

    pub(crate) fn write_stdout(&self, bytes: &[u8]) {
        let _ = self.stdout.borrow_mut().write_all(bytes);
    }

    pub(crate) fn write_stderr(&self, bytes: &[u8]) {
        // Keep stdout and stderr ordered relative to each other.
        self.flush();
        let _ = io::stderr().write_all(bytes);
    }

    pub(crate) fn flush(&self) {
        let _ = self.stdout.borrow_mut().flush();
    }

    pub(crate) fn exit(&self, code: i32) -> ! {
        self.flush();
        // Skip runtime teardown: QuickJS would assert on objects still held
        // by persistent handles, and the process is going away anyway.
        std::process::exit(code)
    }

    /// Run `process.nextTick` callbacks and promise jobs until both queues
    /// are empty. Returns whether anything ran.
    pub(crate) fn drain_jobs(&self, ctx: &Ctx<'_>) -> bool {
        let mut ran = false;
        loop {
            if self.tick_pending.replace(false) {
                ran = true;
                if let Err(err) = self.call_internal::<()>(ctx, "runTicks", ()) {
                    self.uncaught(ctx, err);
                }
                continue;
            }
            if !ctx.execute_pending_job() {
                break;
            }
            ran = true;
        }
        ran
    }

    fn call_internal<'js, R: rquickjs::FromJs<'js>>(
        &self,
        ctx: &Ctx<'js>,
        name: &str,
        args: impl rquickjs::function::IntoArgs<'js>,
    ) -> rquickjs::Result<R> {
        let internal = self.internal.borrow().clone().ok_or(rquickjs::Error::Unknown)?.restore(ctx)?;
        let f: Function = internal.get(name)?;
        f.call(args)
    }

    /// Turn a thrown rquickjs error into the JS value that was thrown.
    fn take_exception<'js>(&self, ctx: &Ctx<'js>, err: rquickjs::Error) -> Value<'js> {
        match err {
            rquickjs::Error::Exception => ctx.catch(),
            other => {
                self.write_stderr(format!("error: {other}\n").as_bytes());
                self.exit(1);
            }
        }
    }

    /// An uncaught error: `process.on("uncaughtException")` handlers get it
    /// first, otherwise it is printed the way Bun does and the process exits 1.
    fn uncaught(&self, ctx: &Ctx<'_>, err: rquickjs::Error) {
        let value = self.take_exception(ctx, err);
        self.uncaught_value(ctx, "handleUncaught", value);
    }

    fn uncaught_value<'js>(&self, ctx: &Ctx<'js>, handler: &str, value: Value<'js>) {
        match self.call_internal::<bool>(ctx, handler, (value,)) {
            Ok(true) => return,
            Ok(false) => {}
            Err(_) => {
                let fallback = ctx.catch();
                let text = fallback.as_string().and_then(|s| s.to_string().ok()).unwrap_or_default();
                self.write_stderr(format!("error: {text}\n").as_bytes());
            }
        }
        self.exit(1)
    }

    /// Report promises that are still unhandled once the microtask queue
    /// drained (Bun treats an unhandled rejection as fatal).
    fn check_rejections(&self, ctx: &Ctx<'_>) {
        let pending: Vec<_> = self.rejections.borrow_mut().drain(..).collect();
        for (_, reason) in pending {
            let Ok(reason) = reason.restore(ctx) else { continue };
            self.uncaught_value(ctx, "handleRejection", reason);
        }
    }
}

/// Run a program to completion; returns the process exit code.
pub fn run(options: Options) -> i32 {
    let rt = Runtime::new().expect("create QuickJS runtime");
    // The default 256 KiB native stack limit is far below what wasm gives
    // us; QuickJS checks against it to throw RangeError instead of crashing.
    rt.set_max_stack_size(4 * 1024 * 1024);
    let ctx = Context::full(&rt).expect("create QuickJS context");

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    let main_path = match &options.entry {
        Entry::File(path) => resolve::join(&cwd, path),
        Entry::Eval(_) => format!("{}/[eval]", cwd.trim_end_matches('/')),
    };
    let argv = [String::from("bun"), main_path.clone()]
        .into_iter()
        .chain(options.args.iter().cloned())
        .collect::<Vec<_>>();
    let state = Rc::new(State::new(argv, options.transpiler));
    *state.main.borrow_mut() = main_path.clone();

    let tracker_state = state.clone();
    rt.set_host_promise_rejection_tracker(Some(Box::new(move |ctx, promise, reason, is_handled| {
        let mut list = tracker_state.rejections.borrow_mut();
        if is_handled {
            list.retain(|(p, _)| p.clone().restore(&ctx).map(|p| p != promise).unwrap_or(false));
        } else {
            list.push((Persistent::save(&ctx, promise), Persistent::save(&ctx, reason)));
        }
    })));
    rt.set_loader(
        modules::ModuleResolver { state: state.clone() },
        modules::ModuleLoader { state: state.clone() },
    );

    ctx.with(|ctx| {
        let code = run_in_context(&ctx, &state, &options.entry, &main_path);
        state.flush();
        code
    })
}

fn run_in_context(ctx: &Ctx<'_>, state: &Rc<State>, entry: &Entry, main_path: &str) -> i32 {
    let internal = natives::install(ctx, state).and_then(|native| modules::run_bootstrap(ctx, native));
    let internal = match internal {
        Ok(internal) => internal,
        Err(err) => {
            let detail = match err {
                rquickjs::Error::Exception => format!("{:?}", ctx.catch()),
                other => other.to_string(),
            };
            eprintln!("bun-wasm: bootstrap failed: {detail}");
            return 70;
        }
    };
    *state.internal.borrow_mut() = Some(Persistent::save(ctx, internal));

    let started = match entry {
        Entry::Eval(code) => modules::eval_main(ctx, state, code).map(|p| p.into_value()),
        Entry::File(_) => state.call_internal::<Value>(ctx, "runMain", (main_path,)),
    };
    let main_promise = match started {
        Ok(v) => v.into_promise(),
        Err(err) => {
            state.uncaught(ctx, err);
            None
        }
    };
    run_event_loop(ctx, state, main_promise);
    state.call_internal::<i32>(ctx, "beforeExit", ()).unwrap_or_else(|err| {
        state.uncaught(ctx, err);
        0
    })
}

/// The event loop: microtasks and ticks, then one due timer at a time;
/// sleeps (WASI `poll_oneoff`) until the next timer when idle.
fn run_event_loop<'js>(ctx: &Ctx<'js>, state: &Rc<State>, main: Option<Promise<'js>>) {
    let mut main = main;
    loop {
        state.drain_jobs(ctx);
        if let Some(promise) = main.take() {
            main = check_main_promise(ctx, state, promise);
        }
        state.check_rejections(ctx);
        // runTimers returns: 0 = a timer ran (loop again), >0 = ms until the
        // next timer, <0 = nothing left keeping the loop alive.
        let next = match state.call_internal::<f64>(ctx, "runTimers", ()) {
            Ok(next) => next,
            Err(err) => {
                state.uncaught(ctx, err);
                0.0
            }
        };
        if next == 0.0 {
            continue;
        }
        if next < 0.0 {
            if state.drain_jobs(ctx) {
                continue;
            }
            if let Some(promise) = main.take() {
                // Top-level await that can never finish: Bun exits quietly.
                main = check_main_promise(ctx, state, promise);
            }
            // `beforeExit` listeners may schedule more work.
            match state.call_internal::<bool>(ctx, "emitBeforeExit", ()) {
                Ok(true) => continue,
                _ => break,
            }
        }
        state.flush();
        std::thread::sleep(std::time::Duration::from_secs_f64(next / 1000.0));
    }
}

/// Surface a rejected entry module; keep pending ones around.
fn check_main_promise<'js>(ctx: &Ctx<'js>, state: &State, promise: Promise<'js>) -> Option<Promise<'js>> {
    use rquickjs::promise::PromiseState;
    match promise.state() {
        PromiseState::Pending => Some(promise),
        PromiseState::Resolved => None,
        PromiseState::Rejected => {
            let reason = modules::promise_result(ctx, &promise);
            // The rejection tracker saw this promise too; don't report twice.
            let promise_value = promise.into_value();
            state
                .rejections
                .borrow_mut()
                .retain(|(p, _)| p.clone().restore(ctx).map(|p| p != promise_value).unwrap_or(false));
            state.uncaught_value(ctx, "handleUncaught", reason);
            None
        }
    }
}
