use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::rc::Rc;

use crate::client::CoreClient;
use crate::engine::{Engine, NativeError};
use crate::natives;
use crate::program::run_in_engine;

pub(crate) enum Entry {
    File(#[allow(dead_code)] String),
    Eval(String),
    Test(Vec<String>),
}

pub(crate) fn run<E: Engine>(session: u32) -> i32 {
    let client = CoreClient { session };
    let (entry, main) = client.entry().expect("core entry description");
    let core = Rc::new(Core::<E> {
        client,
        internal: RefCell::new(None),
        handoffs: RefCell::new(HashMap::new()),
    });
    let engine = E::new(core.clone());
    let code = run_in_engine(&engine, &core, &entry, &main);
    client.flush();
    // Rooted values live until process disposal, matching the existing driver.
    std::mem::forget(engine);
    code
}

type ModuleHandoffs<V> = RefCell<HashMap<String, (V, V)>>;

/// The runtime's engine-facing half: the `internal` object the bootstrap
/// returned, pending wrapper-module handoffs, and the module host.
pub(crate) struct Core<E: Engine> {
    pub(crate) client: CoreClient,
    pub(crate) internal: RefCell<Option<E::Value>>,
    /// Exports objects of wrapper modules, until their `import.meta` is set.
    pub(crate) handoffs: ModuleHandoffs<E::Value>,
}

impl<E: Engine> Core<E> {
    pub(crate) fn bootstrap(self: &Rc<Self>, e: &E) -> Result<E::Value, E::Value> {
        natives::bootstrap(e, self)
    }

    pub(crate) fn eval_source(&self, code: &str) -> Result<(String, String), NativeError> {
        self.client.eval_source(code)
    }

    pub(crate) fn take_tick(&self) -> bool {
        self.client.take_tick()
    }
    pub(crate) fn flush(&self) {
        self.client.flush();
    }
    pub(crate) fn write_error(&self, text: &str) {
        self.flush();
        // A closed stderr must not replace the primary failure with a panic.
        let _ = std::io::stderr().lock().write_all(text.as_bytes());
    }
    pub(crate) fn exit(&self, code: i32) -> ! {
        self.client.exit(code)
    }
    pub(crate) fn idle(&self, ms: i32) {
        self.client.idle(ms);
    }
    pub(crate) fn poll(&self, ms: i32) {
        self.client.poll(ms);
    }
    pub(crate) fn compile_cjs(&self, path: &str) -> Result<(String, i32), NativeError> {
        self.client.cjs_source(path)
    }
    pub(crate) fn polyfill(&self, name: &str) -> Result<String, NativeError> {
        self.client.polyfill(name)
    }
    pub(crate) fn resolve_module(
        &self,
        specifier: &str,
        referrer: &str,
    ) -> Result<String, NativeError> {
        self.client.resolve(specifier, referrer)
    }
    pub(crate) fn module_source(&self, name: &str) -> Result<(String, String), NativeError> {
        self.client.module_source(name)
    }
    pub(crate) fn wrapper_source(&self, keys: Vec<String>) -> Result<String, NativeError> {
        self.client.wrapper(keys)
    }
    pub(crate) fn is_main(&self, name: &str) -> Result<bool, NativeError> {
        self.client.is_main(name)
    }
    pub(crate) fn has_interrupt_handler(&self) -> bool {
        true
    }
    pub(crate) fn interrupt(&self) -> bool {
        self.client.interrupt()
    }
}
