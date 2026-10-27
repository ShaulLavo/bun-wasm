//! The boundary between the runtime and a JavaScript engine.
//!
//! The runtime (event loop, module resolution, transpiling, natives, the JS
//! polyfills in src/js) is engine-agnostic; an [`Engine`] provides values,
//! functions, calls, script and module evaluation (with a per-file
//! resolve/load hook, [`ModuleHost`]), microtasks, promise state and errors.
//! QuickJS-ng and JavaScriptCore compile this source into their linked
//! engine programs.
//!
//! Most natives exchange plain data ([`Val`]): strings, numbers, bytes,
//! arrays and records. Only the few natives that inspect JS values
//! (promises, proxies, module loading) touch `Engine::Value` directly.

use std::rc::Rc;

pub use crate::data::{Args, DataFn, ErrorKind, NativeError, NativeResult, Record, Val};

/// A native over engine values: gets the engine and the raw arguments;
/// `Err` is the value to throw.
pub type ValueFn<E> =
    Rc<dyn Fn(&E, &[<E as Engine>::Value]) -> Result<<E as Engine>::Value, <E as Engine>::Value>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromiseState {
    Pending,
    Fulfilled,
    Rejected,
}

/// The runtime's side of module loading, called by the engine's loader.
pub trait ModuleHost<E: Engine> {
    /// Whether the host supplies CPU-bound process-signal checkpoints.
    /// Engines without a signal host do not install an interrupt callback.
    fn has_interrupt_handler(&self) -> bool {
        false
    }
    /// Poll fatal cancellation without consuming handled signals or calling JS.
    /// Engines may also poll during native operations: arbitrary JS reentry is
    /// unsafe. True requests an engine-native uncatchable interrupt; a browser
    /// host's selected fatal outcome instead unwinds Wasm directly.
    fn interrupt(&self) -> bool {
        false
    }
    /// Resolve `specifier` imported from the module `referrer` (a path, a
    /// built-in id, or empty for the entry point) to a module name.
    fn resolve(&self, engine: &E, specifier: &str, referrer: &str) -> Result<String, E::Value>;
    /// ES module source for a resolved name (CommonJS, JSON and built-ins
    /// come back as generated wrapper modules).
    fn load(&self, engine: &E, name: &str) -> Result<String, E::Value>;
    /// Fill in `import.meta` for a module created from `load`'s source.
    fn init_meta(&self, engine: &E, name: &str, meta: &E::Value) -> Result<(), E::Value>;
}

/// A JavaScript engine. One instance per process; methods take `&self`
/// (engines use interior mutability) because natives re-enter the engine.
pub trait Engine: Sized + 'static {
    /// A rooted JS value (kept alive while the handle exists).
    type Value: Clone;

    /// Create the engine. Module loading calls back into `host`.
    fn new(host: Rc<dyn ModuleHost<Self>>) -> Self;
    /// Short engine name for `process.versions` ("quickjs", "jsc").
    fn name(&self) -> &'static str;

    // --- values ---
    fn undefined(&self) -> Self::Value;
    fn is_undefined(&self, v: &Self::Value) -> bool;
    fn to_val(&self, v: &Self::Value) -> Val;
    fn value_from(&self, v: Val) -> Self::Value;
    fn new_object(&self) -> Self::Value;
    fn get(&self, obj: &Self::Value, key: &str) -> Result<Self::Value, Self::Value>;
    fn set(&self, obj: &Self::Value, key: &str, value: Self::Value) -> Result<(), Self::Value>;
    /// Own enumerable string keys.
    fn keys(&self, obj: &Self::Value) -> Vec<String>;
    fn error_value(&self, err: &NativeError) -> Self::Value;

    // --- functions ---
    fn new_function(&self, name: &str, f: ValueFn<Self>) -> Self::Value;
    fn call(
        &self,
        f: &Self::Value,
        this: &Self::Value,
        args: &[Self::Value],
    ) -> Result<Self::Value, Self::Value>;

    // --- evaluation ---
    /// Evaluate a classic script whose first line is line `first_line` (1 is
    /// normal; the CommonJS wrapper uses -1 so the file starts at line 1).
    fn eval_script(
        &self,
        source: &str,
        filename: &str,
        first_line: i32,
    ) -> Result<Self::Value, Self::Value>;
    /// `import(specifier)` from the top level: a promise of the namespace.
    fn import_module(&self, specifier: &str) -> Result<Self::Value, Self::Value>;
    /// Evaluate `source` as the ES module `name` (bun -e); `init_meta` runs
    /// for it like for loaded modules. Returns the evaluation promise.
    fn eval_module(&self, name: &str, source: &str) -> Result<Self::Value, Self::Value>;

    // --- jobs and promises ---
    /// Run pending promise jobs; returns whether any ran.
    fn run_jobs(&self) -> bool;
    fn promise_state(&self, v: &Self::Value) -> Option<PromiseState>;
    fn promise_result(&self, v: &Self::Value) -> Self::Value;
    /// Attach reactions without looking up public then, constructor or species.
    fn promise_then(
        &self,
        promise: &Self::Value,
        fulfilled: &Self::Value,
        rejected: &Self::Value,
    ) -> Result<Self::Value, Self::Value>;
    /// Rejections that had no handler when the job queue drained:
    /// (promise, reason) pairs, in order. Drains the list.
    fn take_unhandled_rejections(&self) -> Vec<(Self::Value, Self::Value)>;
    fn same_value(&self, a: &Self::Value, b: &Self::Value) -> bool;

    // --- introspection for console.log / util.types ---
    fn is_promise(&self, v: &Self::Value) -> bool;
    fn is_proxy(&self, v: &Self::Value) -> bool;
    fn is_detachable_buffer(&self, v: &Self::Value) -> bool;
    fn detach_buffer(&self, v: &Self::Value);
    fn proxy_target(&self, v: &Self::Value) -> Self::Value;
    fn is_error(&self, v: &Self::Value) -> bool;
    /// Remaining entries of a Map/Set iterator without advancing it.
    fn iterator_entries(&self, v: &Self::Value) -> Option<Self::Value>;
    /// Own keys in the engine's console order, if it differs from
    /// Reflect.ownKeys.
    fn own_keys_in_order(&self, v: &Self::Value) -> Option<Self::Value>;
    /// The AsyncLocalStorage frame carried across await (if supported).
    fn async_context(&self) -> Self::Value;
    fn set_async_context(&self, v: &Self::Value);

    fn gc(&self);
    fn memory_usage(&self) -> Val;
}
