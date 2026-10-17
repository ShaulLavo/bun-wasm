//! The boundary between the runtime and a JavaScript engine.
//!
//! The runtime (event loop, module resolution, transpiling, natives, the JS
//! polyfills in src/js) is engine-agnostic; an [`Engine`] provides values,
//! functions, calls, script and module evaluation (with a per-file
//! resolve/load hook, [`ModuleHost`]), microtasks, promise state and errors.
//! QuickJS-ng (src/engine_quickjs.rs) is the default; JavaScriptCore
//! (src/engine_jsc.rs) is behind the `engine-jsc` feature.
//!
//! Most natives exchange plain data ([`Val`]): strings, numbers, bytes,
//! arrays and records. Only the few natives that inspect JS values
//! (promises, proxies, module loading) touch `Engine::Value` directly.

use std::rc::Rc;

/// Plain data crossing between natives and JS. Engines convert both ways:
/// `Bytes` is a `Uint8Array` in JS, `Object` a plain object, `BigInt` a
/// BigInt.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    BigInt(i64),
    BigUint(u64),
    Str(String),
    Bytes(Vec<u8>),
    Array(Vec<Val>),
    Object(Vec<(String, Val)>),
}

impl From<()> for Val {
    fn from(_: ()) -> Val {
        Val::Undefined
    }
}
impl From<bool> for Val {
    fn from(v: bool) -> Val {
        Val::Bool(v)
    }
}
impl From<f64> for Val {
    fn from(v: f64) -> Val {
        Val::Num(v)
    }
}
impl From<i32> for Val {
    fn from(v: i32) -> Val {
        Val::Num(f64::from(v))
    }
}
impl From<u32> for Val {
    fn from(v: u32) -> Val {
        Val::Num(f64::from(v))
    }
}
impl From<String> for Val {
    fn from(v: String) -> Val {
        Val::Str(v)
    }
}
impl From<&str> for Val {
    fn from(v: &str) -> Val {
        Val::Str(v.to_owned())
    }
}
impl From<Vec<u8>> for Val {
    fn from(v: Vec<u8>) -> Val {
        Val::Bytes(v)
    }
}
impl<T: Into<Val>> From<Option<T>> for Val {
    fn from(v: Option<T>) -> Val {
        v.map_or(Val::Undefined, Into::into)
    }
}
impl From<Vec<Val>> for Val {
    fn from(v: Vec<Val>) -> Val {
        Val::Array(v)
    }
}

/// Builds a `Val::Object` field by field.
#[derive(Default)]
pub struct Record(Vec<(String, Val)>);

impl Record {
    pub fn new() -> Record {
        Record(Vec::new())
    }
    pub fn set(mut self, key: &str, value: impl Into<Val>) -> Record {
        self.0.push((key.to_owned(), value.into()));
        self
    }
    pub fn push(&mut self, key: &str, value: impl Into<Val>) {
        self.0.push((key.to_owned(), value.into()));
    }
}

impl From<Record> for Val {
    fn from(r: Record) -> Val {
        Val::Object(r.0)
    }
}

/// Which built-in error constructor a native error uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Error,
    TypeError,
    RangeError,
    SyntaxError,
}

/// An error thrown by a native: becomes a JS error object with `message`
/// and the extra own properties in `props` (in order; e.g. Node's
/// `path`/`syscall`/`errno`/`code`).
#[derive(Clone, Debug)]
pub struct NativeError {
    pub kind: ErrorKind,
    pub message: String,
    pub name: Option<String>,
    pub props: Vec<(String, Val)>,
}

impl NativeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> NativeError {
        NativeError { kind, message: message.into(), name: None, props: Vec::new() }
    }
    pub fn error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::Error, message)
    }
    pub fn type_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::TypeError, message)
    }
    pub fn range_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::RangeError, message)
    }
    pub fn syntax_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::SyntaxError, message)
    }
    pub fn prop(mut self, key: &str, value: impl Into<Val>) -> NativeError {
        self.props.push((key.to_owned(), value.into()));
        self
    }
    pub fn named(mut self, name: &str) -> NativeError {
        self.name = Some(name.to_owned());
        self
    }
}

pub type NativeResult = Result<Val, NativeError>;

/// Positional arguments of a data native, with conversions that report
/// Bun-style type errors.
pub struct Args<'a>(pub &'a [Val]);

impl<'a> Args<'a> {
    pub fn get(&self, i: usize) -> &'a Val {
        self.0.get(i).unwrap_or(&Val::Undefined)
    }
    pub fn is_missing(&self, i: usize) -> bool {
        matches!(self.get(i), Val::Undefined | Val::Null)
    }
    pub fn str(&self, i: usize) -> Result<&'a str, NativeError> {
        match self.get(i) {
            Val::Str(s) => Ok(s),
            other => Err(NativeError::type_error(format!("expected a string argument, got {}", describe(other)))),
        }
    }
    pub fn string(&self, i: usize) -> Result<String, NativeError> {
        self.str(i).map(str::to_owned)
    }
    pub fn opt_str(&self, i: usize) -> Option<&'a str> {
        match self.get(i) {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
    /// A string (as UTF-8) or a byte buffer.
    pub fn bytes(&self, i: usize) -> Result<&'a [u8], NativeError> {
        match self.get(i) {
            Val::Str(s) => Ok(s.as_bytes()),
            Val::Bytes(b) => Ok(b),
            other => Err(NativeError::type_error(format!(
                "expected a string, Uint8Array or ArrayBuffer, got {}",
                describe(other)
            ))),
        }
    }
    pub fn opt_bytes(&self, i: usize) -> Option<&'a [u8]> {
        if self.is_missing(i) { None } else { self.bytes(i).ok() }
    }
    pub fn num(&self, i: usize) -> Result<f64, NativeError> {
        match self.get(i) {
            Val::Num(n) => Ok(*n),
            Val::Bool(b) => Ok(f64::from(u8::from(*b))),
            Val::BigInt(n) => Ok(*n as f64),
            Val::BigUint(n) => Ok(*n as f64),
            other => Err(NativeError::type_error(format!("expected a number argument, got {}", describe(other)))),
        }
    }
    pub fn opt_num(&self, i: usize) -> Option<f64> {
        self.num(i).ok().filter(|n| !n.is_nan())
    }
    pub fn i32(&self, i: usize) -> Result<i32, NativeError> {
        self.num(i).map(|n| n as i32)
    }
    pub fn u32(&self, i: usize) -> Result<u32, NativeError> {
        self.num(i).map(|n| n as u32)
    }
    pub fn bool(&self, i: usize) -> bool {
        match self.get(i) {
            Val::Bool(b) => *b,
            Val::Num(n) => *n != 0.0,
            Val::Undefined | Val::Null => false,
            _ => true,
        }
    }
    pub fn opt_bool(&self, i: usize) -> Option<bool> {
        match self.get(i) {
            Val::Undefined | Val::Null => None,
            _ => Some(self.bool(i)),
        }
    }
    pub fn array(&self, i: usize) -> Option<&'a [Val]> {
        match self.get(i) {
            Val::Array(items) => Some(items),
            _ => None,
        }
    }
}

fn describe(v: &Val) -> &'static str {
    match v {
        Val::Undefined => "undefined",
        Val::Null => "null",
        Val::Bool(_) => "a boolean",
        Val::Num(_) => "a number",
        Val::BigInt(_) | Val::BigUint(_) => "a bigint",
        Val::Str(_) => "a string",
        Val::Bytes(_) => "a byte buffer",
        Val::Array(_) => "an array",
        Val::Object(_) => "an object",
    }
}

/// A native over plain data.
pub type DataFn = Rc<dyn Fn(Args<'_>) -> NativeResult>;

/// A native over engine values: gets the engine and the raw arguments;
/// `Err` is the value to throw.
pub type ValueFn<E> = Rc<dyn Fn(&E, &[<E as Engine>::Value]) -> Result<<E as Engine>::Value, <E as Engine>::Value>>;

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
    fn has_interrupt_handler(&self) -> bool { false }
    /// Poll fatal cancellation without consuming handled signals or calling JS.
    /// Engines may also poll during native operations: arbitrary JS reentry is
    /// unsafe. True requests an engine-native uncatchable interrupt; a browser
    /// host's selected fatal outcome instead unwinds Wasm directly.
    fn interrupt(&self) -> bool { false }
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
    fn from_val(&self, v: Val) -> Self::Value;
    fn new_object(&self) -> Self::Value;
    fn get(&self, obj: &Self::Value, key: &str) -> Result<Self::Value, Self::Value>;
    fn set(&self, obj: &Self::Value, key: &str, value: Self::Value) -> Result<(), Self::Value>;
    /// Own enumerable string keys.
    fn keys(&self, obj: &Self::Value) -> Vec<String>;
    fn error_value(&self, err: &NativeError) -> Self::Value;

    // --- functions ---
    fn new_function(&self, name: &str, f: ValueFn<Self>) -> Self::Value;
    fn call(&self, f: &Self::Value, this: &Self::Value, args: &[Self::Value]) -> Result<Self::Value, Self::Value>;

    // --- evaluation ---
    /// Evaluate a classic script whose first line is line `first_line` (1 is
    /// normal; the CommonJS wrapper uses -1 so the file starts at line 1).
    fn eval_script(&self, source: &str, filename: &str, first_line: i32) -> Result<Self::Value, Self::Value>;
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
    fn promise_then(&self, promise: &Self::Value, fulfilled: &Self::Value, rejected: &Self::Value) -> Result<Self::Value, Self::Value>;
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
