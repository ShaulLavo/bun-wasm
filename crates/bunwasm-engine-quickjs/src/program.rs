use std::rc::Rc;

use crate::engine::{Engine, PromiseState, Val};
use crate::{Core, Entry};

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
            if self.take_tick() {
                ran = true;
                self.run_internal(e, "runTicks");
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
                self.report_fallback(e, fallback);
            }
        }
        self.exit(1)
    }

    /// Report promises that are still unhandled once the microtask queue
    /// drained (Bun treats an unhandled rejection as fatal).
    fn check_rejections(&self, e: &E) {
        for (promise, reason) in e.take_unhandled_rejections() {
            self.uncaught_values(e, "handleRejection", &[reason, promise]);
        }
    }
    fn report_fallback(&self, e: &E, fallback: E::Value) {
        let text = match e.to_val(&fallback) {
            Val::Str(s) => s,
            _ => String::from("uncaught error while reporting an error"),
        };
        self.write_error(&format!("error: {text}\n"));
    }

    fn run_internal(&self, e: &E, name: &str) {
        if let Err(err) = self.call_internal(e, name, &[]) {
            self.uncaught(e, err);
        }
    }

    fn turn_number(&self, e: &E, name: &str) -> f64 {
        match self.call_internal_num(e, name) {
            Ok(value) => value,
            Err(err) => {
                self.uncaught(e, err);
                0.0
            }
        }
    }

    fn check_main(&self, e: &E, main: &mut Option<E::Value>) {
        if let Some(promise) = main.take() {
            *main = check_main_promise(e, self, promise);
        }
    }

    fn wait_io(&self, e: &E, next: f64) {
        match self.call_internal_num(e, "pumpIo") {
            Ok(progress) if progress != 0.0 => return,
            Ok(_) => {}
            Err(err) => {
                self.uncaught(e, err);
                return;
            }
        }
        if self.drain_jobs(e) {
            return;
        }
        self.flush();
        let wait = if next < 0.0 {
            25
        } else {
            (next.ceil() as i32).clamp(1, 25)
        };
        // Process-only waiters use proc_poll; other handles use the network host poll.
        let slept = match self.call_internal(e, "ioWait", &[e.value_from(wait.into())]) {
            Ok(value) => matches!(e.to_val(&value), Val::Bool(true)),
            Err(err) => {
                self.uncaught(e, err);
                return;
            }
        };
        if !slept {
            self.poll(wait);
        }
        self.run_internal(e, "pumpIo");
    }
}

pub(crate) fn run_in_engine<E: Engine>(
    e: &E,
    core: &Rc<Core<E>>,
    entry: &Entry,
    main_path: &str,
) -> i32 {
    match core.bootstrap(e) {
        Ok(internal) => *core.internal.borrow_mut() = Some(internal),
        Err(err) => {
            eprintln!("bun-wasm: bootstrap failed: {:?}", e.to_val(&err));
            return 70;
        }
    }
    let started = match entry {
        Entry::Eval(code) => core
            .eval_source(code)
            .map_err(|err| e.error_value(&err))
            .and_then(|(name, source)| e.eval_module(&name, &source)),
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

/// The event loop: microtasks and ticks, then one due timer at a time;
/// sleeps (WASI `poll_oneoff`, or the host's poll while sockets are open)
/// until the next timer when idle.
fn run_event_loop<E: Engine>(e: &E, core: &Core<E>, main: Option<E::Value>, test_command: bool) {
    let mut main = main;
    loop {
        // Signal handlers run only at cooperative guest checkpoints. Pending
        // signals do not count as work keeping an otherwise-finished loop alive.
        core.run_internal(e, "pumpSignals");
        core.drain_jobs(e);
        core.check_main(e, &mut main);
        core.check_rejections(e);
        if test_command && main.is_none() {
            break;
        }
        // runTimers returns: 0 = another turn is ready, >0 = ms until the
        // next timer, <0 = nothing left keeping the loop alive.
        let next = core.turn_number(e, "runTimers");
        // Publish this turn's buffered stdout, as the browser engine's pump does. A loop that
        // always has more work never reaches the idle flushes below.
        core.flush();
        if next == 0.0 {
            continue;
        }
        // Network handles (docs/host-abi.md): pump them, then sleep in the
        // host's poll until news or the next timer instead of a plain sleep.
        if core.call_internal_num(e, "ioPending").unwrap_or(0.0) > 0.0 {
            core.wait_io(e, next);
            continue;
        }
        if next < 0.0 && !resume_idle(e, core, &mut main) {
            break;
        }
        if next < 0.0 {
            continue;
        }
        core.flush();
        // Reenter the checkpoint after one bounded wait rather than sleeping through the whole
        // timer delay. With no network handle to watch this is the process poll, which a handled
        // signal or interrupt wakes; the network host poll only knows about network events.
        core.idle((next.ceil() as i32).clamp(1, 25));
    }
}

fn resume_idle<E: Engine>(e: &E, core: &Core<E>, main: &mut Option<E::Value>) -> bool {
    if core.drain_jobs(e) {
        return true;
    }
    // A top-level await with no remaining work exits quietly.
    core.check_main(e, main);
    // `beforeExit` listeners may schedule work through promise jobs or I/O waiters.
    if core.call_internal_num(e, "emitBeforeExit").unwrap_or(0.0) != 0.0 {
        return true;
    }
    if core.drain_jobs(e) {
        return true;
    }
    core.call_internal_num(e, "ioPending").unwrap_or(0.0) > 0.0
}

/// Surface a rejected entry module; keep pending ones around.
fn check_main_promise<E: Engine>(e: &E, core: &Core<E>, promise: E::Value) -> Option<E::Value> {
    match e.promise_state(&promise) {
        Some(PromiseState::Pending) => Some(promise),
        Some(PromiseState::Rejected) => {
            report_main_rejection(e, core, &promise);
            None
        }
        _ => None,
    }
}

fn report_main_rejection<E: Engine>(e: &E, core: &Core<E>, promise: &E::Value) {
    let reason = e.promise_result(promise);
    // The rejection tracker saw this promise too; don't report twice.
    let others: Vec<_> = e
        .take_unhandled_rejections()
        .into_iter()
        .filter(|(p, _)| !e.same_value(p, promise))
        .collect();
    core.uncaught_values(e, "handleUncaught", &[reason]);
    for (promise, reason) in others {
        core.uncaught_values(e, "handleRejection", &[reason, promise]);
    }
}
