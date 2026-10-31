//! [`Engine`] on QuickJS-ng (through rquickjs; the QuickJS sources carry a
//! few bun-wasm helpers, see third_party/rquickjs-sys).
//!
//! The whole program runs in one context, so engine values are
//! `rquickjs::Value<'static>`: the `'js` lifetime is erased once, here, and
//! never escapes this file in any other form.

use std::cell::{Cell, RefCell};
use std::ffi::CString;
use std::rc::{Rc, Weak};

use rquickjs::function::{Rest, This};
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::object::Property;
use rquickjs::{
    Array, BigInt, Context, Ctx, Function, Module, Object, Runtime, TypedArray, Value, qjs,
};

use crate::engine::{Engine, ErrorKind, ModuleHost, NativeError, PromiseState, Val, ValueFn};

type V = Value<'static>;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct QuickJsMemoryTelemetry {
    pub abi_version: u64,
    pub byte_size: u64,
    pub refresh_sequence: u64,
    pub malloc_size: u64,
    pub memory_used_size: u64,
    pub array_buffer_size: u64,
    pub array_buffer_count: u64,
    pub wasm_capacity: u64,
    pub failed_size: u64,
    pub failed_category: u64,
    pub failed_size_known: u64,
    pub counters_valid: u64,
    pub automatic_gc_count: u64,
    pub malloc_size_after_automatic_gc: u64,
    pub malloc_gc_threshold: u64,
    pub current_malloc_size: u64,
}

const _: () = assert!(std::mem::size_of::<QuickJsMemoryTelemetry>() == 128);
static NO_MEMORY_TELEMETRY: QuickJsMemoryTelemetry = QuickJsMemoryTelemetry {
    abi_version: 1,
    byte_size: 128,
    refresh_sequence: 0,
    malloc_size: u64::MAX,
    memory_used_size: u64::MAX,
    array_buffer_size: u64::MAX,
    array_buffer_count: u64::MAX,
    wasm_capacity: u64::MAX,
    failed_size: u64::MAX,
    failed_category: 0,
    failed_size_known: 0,
    counters_valid: 0,
    automatic_gc_count: 0,
    malloc_size_after_automatic_gc: u64::MAX,
    malloc_gc_threshold: u64::MAX,
    current_malloc_size: u64::MAX,
};

thread_local! {
    static TELEMETRY_RUNTIME: Cell<*mut qjs::JSRuntime> = const { Cell::new(std::ptr::null_mut()) };
}

/// Cached bytes only. Does not enter JS, allocate, or walk the heap.
#[unsafe(no_mangle)]
pub extern "C" fn quickjs_memory_telemetry() -> *const QuickJsMemoryTelemetry {
    TELEMETRY_RUNTIME.with(|runtime| {
        if runtime.get().is_null() {
            return std::ptr::addr_of!(NO_MEMORY_TELEMETRY);
        }
        // SAFETY: Inner clears this thread's pointer before its runtime is freed.
        unsafe { JS_bunwasm_MemoryTelemetry(runtime.get()) }
    })
}

/// Refresh only at a normal boundary. Never call this after a trap or OOM.
#[unsafe(no_mangle)]
pub extern "C" fn quickjs_memory_telemetry_refresh() -> *const QuickJsMemoryTelemetry {
    TELEMETRY_RUNTIME.with(|runtime| {
        if runtime.get().is_null() {
            return std::ptr::addr_of!(NO_MEMORY_TELEMETRY);
        }
        // SAFETY: caller stops guest execution at a normal boundary; runtime is live.
        unsafe { JS_bunwasm_RefreshMemoryTelemetry(runtime.get()) }
    })
}

unsafe extern "C" {
    fn JS_bunwasm_MemoryTelemetry(rt: *mut qjs::JSRuntime) -> *const QuickJsMemoryTelemetry;
    fn JS_bunwasm_RefreshMemoryTelemetry(rt: *mut qjs::JSRuntime) -> *const QuickJsMemoryTelemetry;
    fn JS_bunwasm_GetAllocationFailure(
        rt: *mut qjs::JSRuntime,
        size: *mut u64,
        size_known: *mut bool,
    ) -> u32;
    fn JS_bunwasm_IsArrayBufferLike(value: qjs::JSValue) -> bool;
    fn JS_bunwasm_IsDetachableArrayBuffer(value: qjs::JSValue) -> bool;
    /// A WebAssembly.Memory buffer over bytes QuickJS never frees (new reference).
    fn JS_bunwasm_NewWasmMemoryBuffer(
        ctx: *mut qjs::JSContext,
        data: *mut u8,
        length: usize,
    ) -> qjs::JSValue;
    fn JS_bunwasm_DetachWasmMemoryBuffer(ctx: *mut qjs::JSContext, value: qjs::JSValue) -> bool;
    /// Added to QuickJS by bun-wasm (third_party/rquickjs-sys): remaining
    /// entries of a Map/Set iterator, without advancing it.
    fn JS_bunwasm_IteratorEntries(ctx: *mut qjs::JSContext, value: qjs::JSValue) -> qjs::JSValue;
    /// Own keys in JSC's console order (index keys, then insertion order with
    /// symbols interleaved); undefined for exotic objects.
    fn JS_bunwasm_OwnKeysInOrder(ctx: *mut qjs::JSContext, value: qjs::JSValue) -> qjs::JSValue;
    /// The async context promise reactions capture and restore (new reference).
    fn JS_bunwasm_GetAsyncContext(ctx: *mut qjs::JSContext) -> qjs::JSValue;
    fn JS_bunwasm_SetAsyncContext(ctx: *mut qjs::JSContext, value: qjs::JSValue);
}

/// Erase a value's lifetime (all values belong to the one context).
fn erase(v: Value<'_>) -> V {
    // SAFETY: Value<'js> and Value<'static> have the same layout; the context
    // outlives every value (it is never torn down).
    unsafe { std::mem::transmute::<Value<'_>, V>(v) }
}

struct Inner {
    _runtime: Runtime,
    runtime_raw: *mut qjs::JSRuntime,
    _context: Context,
    ctx: Ctx<'static>,
    host: Rc<dyn ModuleHost<QuickJs>>,
    /// Rejected promises without a handler yet: (promise, reason).
    rejections: RefCell<Vec<(V, V)>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        TELEMETRY_RUNTIME.with(|runtime| {
            if runtime.get() == self.runtime_raw {
                runtime.set(std::ptr::null_mut());
            }
        });
    }
}

// QuickJS already polls every 10,000 backedges/calls. Amortize host crossings
// over eight such polls; no clocks, allocations, or JS calls on the idle path.
const INTERRUPT_POLLS: u32 = 8;

/// QuickJS-ng. Cheap to clone (a reference to the engine).
#[derive(Clone)]
pub struct QuickJs(Rc<Inner>);

impl QuickJs {
    fn ctx(&self) -> &Ctx<'static> {
        &self.0.ctx
    }

    fn raw(&self) -> *mut qjs::JSContext {
        self.0.ctx.as_raw().as_ptr()
    }

    /// The pending exception (after `Error::Exception`) or an Error for any
    /// other rquickjs failure.
    fn caught(&self, err: rquickjs::Error) -> V {
        match err {
            rquickjs::Error::Exception => self.ctx().catch(),
            other => self.error_value(&NativeError::error(other.to_string())),
        }
    }

    fn wrap(&self, raw: qjs::JSValue) -> Result<V, V> {
        // SAFETY: `raw` is a new reference returned by a QuickJS call.
        unsafe {
            if qjs::JS_IsException(raw) {
                return Err(self.ctx().catch());
            }
            Ok(Value::from_raw(self.ctx().clone(), raw))
        }
    }

    fn helper(
        &self,
        v: &V,
        f: unsafe extern "C" fn(*mut qjs::JSContext, qjs::JSValue) -> qjs::JSValue,
    ) -> Option<V> {
        // SAFETY: the helpers borrow `v` and return a new reference.
        let out = self.wrap(unsafe { f(self.raw(), v.as_raw()) }).ok()?;
        (!out.is_undefined()).then_some(out)
    }

    fn object(&self, v: &V) -> Result<Object<'static>, V> {
        if let Some(obj) = v.as_object() {
            return Ok(obj.clone());
        }
        if let Some(obj) = v.as_function().and_then(|f| f.as_object()) {
            return Ok(obj.clone());
        }
        Err(self.error_value(&NativeError::type_error("expected an object")))
    }

    /// `first_line` is where the source's first line is numbered from (1
    /// normally; QuickJS treats 0 as "default", so the CommonJS wrapper
    /// starts at -1).
    fn eval_at(&self, source: &str, filename: &str, first_line: i32) -> Result<V, V> {
        let c_source = CString::new(source)
            .map_err(|_| self.error_value(&NativeError::syntax_error("source contains NUL")))?;
        let c_filename = CString::new(filename).unwrap_or_default();
        let mut options = qjs::JSEvalOptions {
            version: qjs::JS_EVAL_OPTIONS_VERSION as i32,
            eval_flags: qjs::JS_EVAL_TYPE_GLOBAL as i32,
            filename: c_filename.as_ptr(),
            line_num: first_line,
        };
        // SAFETY: the source is NUL-terminated as JS_Eval2 requires.
        let raw = unsafe {
            qjs::JS_Eval2(
                self.raw(),
                c_source.as_ptr(),
                source.len() as _,
                &mut options,
            )
        };
        self.wrap(raw)
    }

    fn declare(&self, name: &str, source: String) -> rquickjs::Result<Module<'static, Declared>> {
        Module::declare(self.ctx().clone(), name, source)
    }
}

/// Bytes of C shadow stack QuickJS may use before it throws RangeError. It must
/// trip before the host's separate wasm call stack runs out. The default fits
/// wasmtime's default 512 KiB stack and Chromium; hosts set `BUN_WASM_STACK_KIB`
/// for their own stack: the launcher and the Node host raise it, browsers off
/// V8 lower it (see docs/stack-limits.md).
fn stack_budget() -> usize {
    // The shadow stack is 8 MiB (crates/bunwasm-cli/build.rs). A larger budget would never
    // trip, and `kib * 1024` must not wrap to 0, which QuickJS reads as "no limit".
    const MAX_KIB: usize = 7 * 1024;
    let kib = std::env::var("BUN_WASM_STACK_KIB")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok());
    kib.filter(|&kib| kib > 0).unwrap_or(152).min(MAX_KIB) * 1024
}

impl Engine for QuickJs {
    type Value = V;

    fn new(host: Rc<dyn ModuleHost<QuickJs>>) -> QuickJs {
        let runtime = Runtime::new().expect("create QuickJS runtime");
        runtime.set_max_stack_size(stack_budget());
        let context = Context::full(&runtime).expect("create QuickJS context");
        // SAFETY: single-threaded; the context lives as long as the process.
        let ctx: Ctx<'static> = unsafe { Ctx::from_raw(context.as_raw()) };
        // SAFETY: the context and its runtime are live and retained by Inner.
        let runtime_raw = unsafe { qjs::JS_GetRuntime(ctx.as_raw().as_ptr()) };
        TELEMETRY_RUNTIME.with(|active| active.set(runtime_raw));
        let has_interrupt_handler = host.has_interrupt_handler();
        let engine = QuickJs(Rc::new(Inner {
            _runtime: runtime.clone(),
            runtime_raw,
            _context: context,
            ctx,
            host,
            rejections: RefCell::new(Vec::new()),
        }));
        if has_interrupt_handler {
            let weak = Rc::downgrade(&engine.0);
            let mut countdown = INTERRUPT_POLLS;
            runtime.set_interrupt_handler(Some(Box::new(move || {
                countdown -= 1;
                if countdown != 0 {
                    return false;
                }
                countdown = INTERRUPT_POLLS;
                // Never enter JS: QuickJS also invokes this during native regexp
                // matching. Handled signals stay in the host pending set until the event loop.
                weak.upgrade().is_some_and(|inner| inner.host.interrupt())
            })));
        }

        let weak = Rc::downgrade(&engine.0);
        runtime.set_host_promise_rejection_tracker(Some(Box::new(
            move |_ctx, promise, reason, is_handled| {
                let Some(inner) = weak.upgrade() else { return };
                let mut list = inner.rejections.borrow_mut();
                let promise = erase(promise);
                if is_handled {
                    list.retain(|(p, _)| *p != promise);
                } else {
                    list.push((promise, erase(reason)));
                }
            },
        )));
        runtime.set_loader(
            QjsResolver(Rc::downgrade(&engine.0)),
            QjsLoader(Rc::downgrade(&engine.0)),
        );
        engine
    }

    fn name(&self) -> &'static str {
        "quickjs"
    }

    fn undefined(&self) -> V {
        Value::new_undefined(self.ctx().clone())
    }

    fn is_undefined(&self, v: &V) -> bool {
        v.is_undefined()
    }

    fn to_val(&self, v: &V) -> Val {
        to_val(v)
    }

    fn value_from(&self, v: Val) -> V {
        value_from(self.ctx(), v).unwrap_or_else(|_| self.undefined())
    }

    fn new_object(&self) -> V {
        Object::new(self.ctx().clone())
            .map(|o| o.into_value())
            .unwrap_or_else(|_| self.undefined())
    }

    fn get(&self, obj: &V, key: &str) -> Result<V, V> {
        self.object(obj)?
            .get::<_, Value>(key)
            .map(erase)
            .map_err(|e| self.caught(e))
    }

    fn set(&self, obj: &V, key: &str, value: V) -> Result<(), V> {
        self.object(obj)?
            .set(key, value)
            .map_err(|e| self.caught(e))
    }

    fn keys(&self, obj: &V) -> Vec<String> {
        let Ok(obj) = self.object(obj) else {
            return Vec::new();
        };
        obj.keys::<String>().filter_map(|k| k.ok()).collect()
    }

    fn error_value(&self, err: &NativeError) -> V {
        let ctor = match err.kind {
            ErrorKind::Error => "Error",
            ErrorKind::TypeError => "TypeError",
            ErrorKind::RangeError => "RangeError",
            ErrorKind::SyntaxError => "SyntaxError",
        };
        let build = || -> rquickjs::Result<V> {
            // Calling the constructor gives a non-enumerable `message`, like
            // `new Error(message)`.
            let f: Function = self.ctx().globals().get(ctor)?;
            let e: Object = f.call((err.message.as_str(),))?;
            for (k, v) in &err.props {
                if k == "name" {
                    e.prop(
                        "name",
                        Property::from(value_from(self.ctx(), v.clone())?)
                            .writable()
                            .configurable(),
                    )?;
                    continue;
                }
                e.set(k.as_str(), value_from(self.ctx(), v.clone())?)?;
            }
            if let Some(name) = &err.name {
                e.prop(
                    "name",
                    Property::from(name.as_str()).writable().configurable(),
                )?;
            }
            Ok(e.into_value())
        };
        build().unwrap_or_else(|_| self.undefined())
    }

    fn new_function(&self, name: &str, f: ValueFn<Self>) -> V {
        let engine = self.clone();
        let func = Function::new(
            self.ctx().clone(),
            move |args: Rest<Value<'static>>| -> rquickjs::Result<Value<'static>> {
                match f(&engine, &args.0) {
                    Ok(v) => Ok(v),
                    Err(thrown) => Err(engine.ctx().throw(thrown)),
                }
            },
        );
        func.and_then(|f| f.with_name(name))
            .map(|f| f.into_value())
            .unwrap_or_else(|_| self.undefined())
    }

    fn call(&self, f: &V, this: &V, args: &[V]) -> Result<V, V> {
        let Some(func) = f.as_function() else {
            return Err(self.error_value(&NativeError::type_error("not a function")));
        };
        func.call::<_, Value>((This(this.clone()), Rest(args.to_vec())))
            .map(erase)
            .map_err(|e| self.caught(e))
    }

    fn eval_script(&self, source: &str, filename: &str, first_line: i32) -> Result<V, V> {
        self.eval_at(source, filename, first_line)
    }

    fn import_module(&self, specifier: &str) -> Result<V, V> {
        Module::import(self.ctx(), specifier)
            .map(|p| erase(p.into_value()))
            .map_err(|e| self.caught(e))
    }

    fn eval_module(&self, name: &str, source: &str) -> Result<V, V> {
        let module = self
            .declare(name, source.to_owned())
            .map_err(|e| self.caught(e))?;
        let meta = module.meta().map_err(|e| self.caught(e))?;
        self.0.host.init_meta(self, name, &meta.into_value())?;
        let (_, promise) = module.eval().map_err(|e| self.caught(e))?;
        Ok(erase(promise.into_value()))
    }

    fn run_jobs(&self) -> bool {
        self.ctx().execute_pending_job()
    }

    fn promise_state(&self, v: &V) -> Option<PromiseState> {
        use rquickjs::promise::PromiseState as S;
        Some(match v.as_promise()?.state() {
            S::Pending => PromiseState::Pending,
            S::Resolved => PromiseState::Fulfilled,
            S::Rejected => PromiseState::Rejected,
        })
    }

    fn promise_result(&self, v: &V) -> V {
        if v.as_promise().is_none() {
            return v.clone();
        }
        // SAFETY: JS_PromiseResult returns a new reference.
        unsafe {
            Value::from_raw(
                self.ctx().clone(),
                qjs::JS_PromiseResult(self.raw(), v.as_raw()),
            )
        }
    }

    fn promise_then(&self, promise: &V, fulfilled: &V, rejected: &V) -> Result<V, V> {
        // SAFETY: the embedding API borrows the inputs and returns a new reference.
        self.wrap(unsafe {
            qjs::JS_PromiseThen(
                self.raw(),
                promise.as_raw(),
                fulfilled.as_raw(),
                rejected.as_raw(),
            )
        })
    }

    fn take_unhandled_rejections(&self) -> Vec<(V, V)> {
        self.0.rejections.borrow_mut().drain(..).collect()
    }

    fn same_value(&self, a: &V, b: &V) -> bool {
        a == b
    }

    fn is_promise(&self, v: &V) -> bool {
        v.is_promise()
    }

    fn is_proxy(&self, v: &V) -> bool {
        v.is_proxy()
    }

    fn is_detachable_buffer(&self, v: &V) -> bool {
        // SAFETY: the helper only inspects the buffer class and detached flag.
        unsafe { JS_bunwasm_IsDetachableArrayBuffer(v.as_raw()) }
    }

    fn detach_buffer(&self, v: &V) {
        // SAFETY: the transfer native validated every buffer before detaching any.
        unsafe { qjs::JS_DetachArrayBuffer(self.raw(), v.as_raw()) }
    }

    unsafe fn wasm_memory_buffer(&self, data: *mut u8, length: usize) -> V {
        // SAFETY: the caller keeps the bytes valid until the buffer is detached.
        unsafe {
            Value::from_raw(
                self.ctx().clone(),
                JS_bunwasm_NewWasmMemoryBuffer(self.raw(), data, length),
            )
        }
    }

    fn detach_wasm_memory_buffer(&self, v: &V) -> bool {
        // SAFETY: the helper checks the buffer class and WebAssembly.Memory flag.
        unsafe { JS_bunwasm_DetachWasmMemoryBuffer(self.raw(), v.as_raw()) }
    }

    fn proxy_target(&self, v: &V) -> V {
        if !v.is_proxy() {
            return self.undefined();
        }
        // SAFETY: returns a new reference to the proxy's target.
        self.wrap(unsafe { qjs::JS_GetProxyTarget(self.raw(), v.as_raw()) })
            .unwrap_or_else(|_| self.undefined())
    }

    fn is_error(&self, v: &V) -> bool {
        // SAFETY: JS_IsError only inspects the value's class.
        unsafe { qjs::JS_IsError(v.as_raw()) }
    }

    fn iterator_entries(&self, v: &V) -> Option<V> {
        self.helper(v, JS_bunwasm_IteratorEntries)
    }

    fn own_keys_in_order(&self, v: &V) -> Option<V> {
        self.helper(v, JS_bunwasm_OwnKeysInOrder)
    }

    fn async_context(&self) -> V {
        // SAFETY: returns a new reference.
        unsafe { Value::from_raw(self.ctx().clone(), JS_bunwasm_GetAsyncContext(self.raw())) }
    }

    fn set_async_context(&self, v: &V) {
        // SAFETY: takes its own reference to `v`.
        unsafe { JS_bunwasm_SetAsyncContext(self.raw(), v.as_raw()) }
    }

    fn gc(&self) {
        self.ctx().run_gc();
    }

    fn memory_usage(&self) -> Val {
        let mut usage = std::mem::MaybeUninit::<qjs::JSMemoryUsage>::zeroed();
        // SAFETY: the runtime pointer is live for the duration of this call.
        let usage = unsafe {
            qjs::JS_ComputeMemoryUsage(qjs::JS_GetRuntime(self.raw()), usage.as_mut_ptr());
            usage.assume_init()
        };
        crate::engine::Record::new()
            .set("rss", Val::Null)
            .set("heapTotal", usage.malloc_size as f64)
            .set("heapUsed", usage.memory_used_size as f64)
            .set("external", Val::Null)
            .set("arrayBuffers", usage.array_buffer_size as f64)
            .set("arrayBufferCount", usage.array_buffer_count as f64)
            .set("failedAllocation", allocation_failure(self.raw()))
            .set("wasmCapacity", wasm_memory_bytes())
            .into()
    }
}

fn allocation_failure(ctx: *mut qjs::JSContext) -> Val {
    let mut size = 0;
    let mut known = false;
    // SAFETY: the runtime is live and both output pointers refer to stack values.
    let category =
        unsafe { JS_bunwasm_GetAllocationFailure(qjs::JS_GetRuntime(ctx), &mut size, &mut known) };
    let category = match category {
        1 => "quickjs.malloc",
        2 => "quickjs.calloc",
        3 => "quickjs.realloc",
        4 => "quickjs.arrayBuffer",
        _ => return Val::Null,
    };
    let size = if known {
        Val::Num(size as f64)
    } else {
        Val::Null
    };
    crate::engine::Record::new()
        .set("size", size)
        .set("category", category)
        .into()
}

fn wasm_memory_bytes() -> Val {
    #[cfg(target_arch = "wasm32")]
    {
        Val::Num((core::arch::wasm32::memory_size(0) * 65536) as f64)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Val::Null
    }
}

fn utf16_string_val(value: &Value<'_>) -> Val {
    let mut len = 0;
    // SAFETY: value is a live string in this context; QuickJS owns the returned buffer.
    let ptr = unsafe {
        qjs::JS_ToCStringLenUTF16(value.ctx().as_raw().as_ptr(), &mut len, value.as_raw())
    };
    if ptr.is_null() {
        return Val::Undefined;
    }
    // SAFETY: the buffer contains len UTF-16 units and remains alive until FreeCStringUTF16.
    let text = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len as usize)) };
    // SAFETY: ptr is the buffer returned by QuickJS in this context, freed exactly once.
    unsafe { qjs::JS_FreeCStringUTF16(value.ctx().as_raw().as_ptr(), ptr) };
    Val::Str(text)
}

/// JS -> plain data.
fn to_val(v: &Value<'_>) -> Val {
    if v.is_undefined() {
        return Val::Undefined;
    }
    if v.is_null() {
        return Val::Null;
    }
    if let Some(b) = v.as_bool() {
        return Val::Bool(b);
    }
    if let Some(n) = v.as_number() {
        return Val::Num(n);
    }
    if let Some(s) = v.as_string() {
        return s
            .to_string()
            .map(Val::Str)
            .unwrap_or_else(|_| utf16_string_val(v));
    }
    if let Some(b) = v.as_big_int() {
        return b
            .clone()
            .to_i64()
            .map(Val::BigInt)
            .unwrap_or(Val::Undefined);
    }
    let Some(obj) = v.as_object() else {
        return Val::Undefined;
    };
    if let Ok(arr) = TypedArray::<u8>::from_value(v.clone()) {
        // SAFETY: no JS runs while the slice is alive; it is copied at once.
        return Val::Bytes(unsafe { arr.as_bytes() }.unwrap_or(&[]).to_vec());
    }
    // SAFETY: v is live; the tag query does not call JavaScript or throw.
    let is_buffer = unsafe { JS_bunwasm_IsArrayBufferLike(v.as_raw()) };
    if is_buffer && let Some(buf) = rquickjs::ArrayBuffer::from_object(obj.clone()) {
        // SAFETY: as above.
        return Val::Bytes(unsafe { buf.as_bytes() }.unwrap_or(&[]).to_vec());
    }
    if let Some(arr) = obj.as_array() {
        return Val::Array(
            arr.iter::<Value>()
                .map(|item| item.map(|i| to_val(&i)).unwrap_or(Val::Undefined))
                .collect(),
        );
    }
    if v.is_function() {
        return Val::Undefined;
    }
    let fields = obj
        .props::<String, Value>()
        .filter_map(|p| p.ok())
        .map(|(k, item)| (k, to_val(&item)))
        .collect();
    Val::Object(fields)
}

/// Plain data -> JS.
fn value_from(ctx: &Ctx<'static>, v: Val) -> rquickjs::Result<V> {
    Ok(match v {
        Val::Undefined => Value::new_undefined(ctx.clone()),
        Val::Null => Value::new_null(ctx.clone()),
        Val::Bool(b) => Value::new_bool(ctx.clone(), b),
        // new_number would store -0 as the integer 0.
        Val::Num(n) if n == 0.0 && n.is_sign_negative() => Value::new_float(ctx.clone(), n),
        Val::Num(n) => Value::new_number(ctx.clone(), n),
        Val::BigInt(n) => BigInt::from_i64(ctx.clone(), n)?.into_value(),
        Val::BigUint(n) => BigInt::from_u64(ctx.clone(), n)?.into_value(),
        Val::Str(s) => rquickjs::String::from_str(ctx.clone(), &s)?.into_value(),
        Val::Bytes(b) => TypedArray::<u8>::new(ctx.clone(), b)?.into_value(),
        Val::Array(items) => {
            let arr = Array::new(ctx.clone())?;
            for (i, item) in items.into_iter().enumerate() {
                arr.set(i, value_from(ctx, item)?)?;
            }
            arr.into_value()
        }
        Val::Object(fields) => {
            let obj = Object::new(ctx.clone())?;
            for (k, item) in fields {
                obj.set(k, value_from(ctx, item)?)?;
            }
            obj.into_value()
        }
    })
}

struct QjsResolver(Weak<Inner>);

impl Resolver for QjsResolver {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let engine = QuickJs(self.0.upgrade().ok_or(rquickjs::Error::Unknown)?);
        engine
            .0
            .host
            .clone()
            .resolve(&engine, name, base)
            .map_err(|thrown| ctx.throw(unerase(thrown)))
    }
}

struct QjsLoader(Weak<Inner>);

impl Loader for QjsLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        let engine = QuickJs(self.0.upgrade().ok_or(rquickjs::Error::Unknown)?);
        let host = engine.0.host.clone();
        let source = host
            .load(&engine, name)
            .map_err(|thrown| ctx.throw(unerase(thrown)))?;
        let module = Module::declare(ctx.clone(), name, source)?;
        let meta = erase(module.meta()?.into_value());
        host.init_meta(&engine, name, &meta)
            .map_err(|thrown| ctx.throw(unerase(thrown)))?;
        Ok(module)
    }
}

/// Give an erased value back the caller's lifetime.
fn unerase<'js>(v: V) -> Value<'js> {
    // SAFETY: see `erase`.
    unsafe { std::mem::transmute::<V, Value<'js>>(v) }
}

#[cfg(test)]
mod tests {
    use super::*;

    enum InterruptMode {
        Continue,
        Terminate,
        OneShot(Rc<std::cell::Cell<bool>>),
    }

    struct InterruptHost {
        polls: std::cell::Cell<u32>,
        mode: InterruptMode,
    }

    impl InterruptHost {
        fn new(mode: InterruptMode) -> Self {
            Self {
                polls: std::cell::Cell::new(0),
                mode,
            }
        }
    }

    impl ModuleHost<QuickJs> for InterruptHost {
        fn uncaught(&self, engine: &QuickJs, error: &V) {
            panic!(
                "unexpected uncaught interrupt-test error: {:?}",
                engine.to_val(error)
            );
        }
        fn resolve(&self, _: &QuickJs, _: &str, _: &str) -> Result<String, V> {
            unreachable!()
        }
        fn load(&self, _: &QuickJs, _: &str) -> Result<String, V> {
            unreachable!()
        }
        fn init_meta(&self, _: &QuickJs, _: &str, _: &V) -> Result<(), V> {
            Ok(())
        }
        fn has_interrupt_handler(&self) -> bool {
            true
        }
        fn interrupt(&self) -> bool {
            self.polls.set(self.polls.get() + 1);
            match &self.mode {
                InterruptMode::Continue => false,
                InterruptMode::Terminate => true,
                InterruptMode::OneShot(armed) => armed.replace(false),
            }
        }
    }

    fn memory_field(snapshot: &Val, key: &str) -> Val {
        let Val::Object(fields) = snapshot else {
            panic!("memory snapshot is an object");
        };
        fields
            .iter()
            .find(|(name, _)| name == key)
            .unwrap()
            .1
            .clone()
    }

    #[test]
    fn memory_telemetry_reports_owned_bytes_and_original_failure() {
        let engine = QuickJs::new(Rc::new(InterruptHost::new(InterruptMode::Continue)));
        // SAFETY: the bound runtime is live for this test; accessors return fixed cached data.
        let initial = unsafe { *quickjs_memory_telemetry() };
        assert_eq!(initial.byte_size, 128);
        assert_eq!(initial.counters_valid, 0);
        let baseline = engine.memory_usage();
        assert_eq!(memory_field(&baseline, "rss"), Val::Null);
        assert_eq!(memory_field(&baseline, "external"), Val::Null);
        assert_eq!(memory_field(&baseline, "wasmCapacity"), Val::Null);
        assert_eq!(memory_field(&baseline, "failedAllocation"), Val::Null);
        let buffer = engine
            .eval_script("new ArrayBuffer(1048576)", "buffer", 1)
            .unwrap();
        let live = engine.memory_usage();
        // SAFETY: refresh occurs at a normal boundary, with no JS executing.
        let cached = unsafe { *quickjs_memory_telemetry_refresh() };
        assert_eq!(cached.counters_valid, 1);
        assert_eq!(cached.array_buffer_size, 1048576);
        assert_eq!(cached.array_buffer_count, 1);
        assert_eq!(memory_field(&live, "arrayBuffers"), Val::Num(1048576.0));
        assert_eq!(memory_field(&live, "arrayBufferCount"), Val::Num(1.0));
        let Val::Num(base_heap) = memory_field(&baseline, "heapTotal") else {
            panic!("heap bytes")
        };
        let Val::Num(live_heap) = memory_field(&live, "heapTotal") else {
            panic!("heap bytes")
        };
        assert!(live_heap >= base_heap + 1048576.0);
        drop(buffer);
        assert_eq!(
            memory_field(&engine.memory_usage(), "arrayBuffers"),
            Val::Num(0.0)
        );
        // SAFETY: the runtime is live; the limit leaves room to construct the error.
        unsafe { qjs::JS_SetMemoryLimit(qjs::JS_GetRuntime(engine.raw()), live_heap as _) };
        let Val::Num(limited_heap) = memory_field(&engine.memory_usage(), "heapTotal") else {
            panic!("heap bytes")
        };
        assert!(
            limited_heap < live_heap,
            "configured limit is not allocated bytes"
        );
        assert!(
            engine
                .eval_script("new ArrayBuffer(2097152)", "failure", 1)
                .is_err()
        );
        // SAFETY: cached read performs no heap traversal after the failed request.
        let failed_cache = unsafe { *quickjs_memory_telemetry() };
        assert_eq!(failed_cache.refresh_sequence, cached.refresh_sequence);
        assert_eq!(failed_cache.array_buffer_size, cached.array_buffer_size);
        assert_eq!(failed_cache.failed_size, 2097152);
        assert_eq!(failed_cache.failed_category, 4);
        let failure = memory_field(&engine.memory_usage(), "failedAllocation");
        assert_eq!(memory_field(&failure, "size"), Val::Num(2097152.0));
        assert_eq!(
            memory_field(&failure, "category"),
            Val::Str("quickjs.arrayBuffer".into())
        );
        std::mem::forget(engine);
    }

    #[test]
    fn memory_telemetry_identifies_quickjs_module_reload_floor() {
        let engine = QuickJs::new(Rc::new(InterruptHost::new(InterruptMode::Continue)));
        for _ in 0..10_000 {
            let value = engine
                .eval_script(
                    "(() => { const a = {}; a.self = a; a.payload = 'x'.repeat(4096); return a; })()",
                    "automatic-gc-warmup",
                    1,
                )
                .unwrap();
            drop(value);
            // SAFETY: this is a cached, allocation-free readout.
            if unsafe { (*quickjs_memory_telemetry()).automatic_gc_count } > 0 {
                break;
            }
        }
        let mut samples = Vec::new();
        for generation in 0..6 {
            let name = format!("/reload/{generation}.mjs");
            let payload = "x".repeat(16 * 1024);
            let source = format!(
                "export const generation = {generation}; export const payload = {payload:?};"
            );
            let promise = engine.eval_module(&name, &source).unwrap();
            drop(promise);
            while engine.run_jobs() {}
            engine.gc();
            // SAFETY: the runtime is live and the refresh is after a normal module turn.
            let telemetry = unsafe { *quickjs_memory_telemetry_refresh() };
            samples.push((
                name,
                telemetry.malloc_size,
                telemetry.memory_used_size,
                telemetry.automatic_gc_count,
                telemetry.malloc_size_after_automatic_gc,
                telemetry.malloc_gc_threshold,
                telemetry.current_malloc_size,
            ));
        }
        for (name, malloc, structural, gc_count, after_gc, threshold, current) in &samples {
            println!(
                "{{\"path\":{name:?},\"mallocBytes\":{malloc},\"structuralBytes\":{structural},\"automaticGcCount\":{gc_count},\"mallocBytesAfterAutomaticGc\":{after_gc},\"mallocGcThreshold\":{threshold},\"currentMallocBytes\":{current}}}"
            );
        }
        let mut changed_path_samples = Vec::new();
        for generation in 0..4 {
            let source = format!(
                "export const generation = {generation}; export const payload = {payload:?};",
                payload = "y".repeat(16 * 1024)
            );
            let result = engine.eval_module("/reload/changed.mjs", &source);
            let Ok(promise) = result else {
                break;
            };
            drop(promise);
            while engine.run_jobs() {}
            engine.gc();
            // SAFETY: the runtime is live and the refresh is after a normal module turn.
            let telemetry = unsafe { *quickjs_memory_telemetry_refresh() };
            changed_path_samples.push((
                generation,
                telemetry.malloc_size,
                telemetry.memory_used_size,
                telemetry.automatic_gc_count,
                telemetry.malloc_size_after_automatic_gc,
                telemetry.current_malloc_size,
            ));
        }
        for (generation, malloc, structural, gc_count, after_gc, current) in &changed_path_samples {
            println!(
                "{{\"path\":\"/reload/changed.mjs\",\"generation\":{generation},\"mallocBytes\":{malloc},\"structuralBytes\":{structural},\"automaticGcCount\":{gc_count},\"mallocBytesAfterAutomaticGc\":{after_gc},\"currentMallocBytes\":{current}}}"
            );
        }
        let valid = !changed_path_samples.is_empty()
            && samples
                .iter()
                .all(|sample| sample.3 > 0 && sample.4 != u64::MAX && sample.6 >= sample.4)
            && samples.windows(2).all(|pair| pair[1].3 >= pair[0].3)
            && changed_path_samples.windows(2).all(|pair| {
                pair[1].1 > pair[0].1
                    && pair[1].2 > pair[0].2
                    && pair[1].3 == pair[0].3
                    && pair[1].4 == pair[0].4
            });
        std::mem::forget(engine);
        assert!(valid);
    }

    #[test]
    fn cpu_bound_script_polls_and_resumes_without_js_dispatch() {
        let host = Rc::new(InterruptHost::new(InterruptMode::Continue));
        let engine = QuickJs::new(host.clone());
        let value = engine
            .eval_script(
                "let value = 0; for (let i = 0; i < 1000000; i++) value++; value;",
                "loop",
                1,
            )
            .unwrap();
        assert_eq!(engine.to_val(&value), Val::Num(1000000.0));
        assert!(host.polls.get() > 0);
        let previous = host.polls.get();
        engine
            .eval_script("for (let i = 0; i < 100000; i++) {}", "later", 1)
            .unwrap();
        assert!(host.polls.get() > previous);
        std::mem::forget(engine);
    }

    #[test]
    fn cpu_bound_interrupt_bypasses_catch_and_finally() {
        let host = Rc::new(InterruptHost::new(InterruptMode::Terminate));
        let engine = QuickJs::new(host.clone());
        let result = engine.eval_script("globalThis.caught = false; globalThis.finalized = false; try { while (true) {} } catch { caught = true; } finally { finalized = true; }", "loop", 1);
        assert!(result.is_err());
        assert!(host.polls.get() > 0);
        assert_eq!(
            engine.to_val(&engine.ctx().globals().get::<_, V>("caught").unwrap()),
            Val::Bool(false)
        );
        assert_eq!(
            engine.to_val(&engine.ctx().globals().get::<_, V>("finalized").unwrap()),
            Val::Bool(false)
        );
        std::mem::forget(engine);
    }

    #[test]
    fn cpu_bound_one_shot_interrupt_bypasses_nested_catch_finally_and_continuation() {
        // Cover both direct evaluation and Rust entering a JS function, as the
        // CommonJS module wrapper does. The host returns true exactly once.
        for call_from_rust in [false, true] {
            let armed = Rc::new(std::cell::Cell::new(false));
            let host = Rc::new(InterruptHost::new(InterruptMode::OneShot(armed.clone())));
            let engine = QuickJs::new(host.clone());
            engine.eval_script(r#"
                globalThis.markers = { innerCatch: 0, innerFinally: 0, outerCatch: 0, outerFinally: 0, after: 0 };
                function interruptedInner() {
                    try { while (true) {} }
                    catch { markers.innerCatch++; }
                    finally { markers.innerFinally++; }
                }
                function interruptedOuter() {
                    try { interruptedInner(); }
                    catch { markers.outerCatch++; }
                    finally { markers.outerFinally++; }
                    markers.after++;
                }
            "#, "nested-interrupt", 1).unwrap();
            armed.set(true);
            let result = if call_from_rust {
                let function = engine
                    .ctx()
                    .globals()
                    .get::<_, V>("interruptedOuter")
                    .unwrap();
                engine.call(&function, &engine.undefined(), &[])
            } else {
                engine.eval_script("interruptedOuter();", "nested-entry", 1)
            };
            assert!(
                result.is_err(),
                "one native true return must unwind the current entry"
            );
            assert!(host.polls.get() > 0);
            assert!(!armed.get(), "native interrupt request was consumed");
            let markers = engine.ctx().globals().get::<_, V>("markers").unwrap();
            for key in [
                "innerCatch",
                "innerFinally",
                "outerCatch",
                "outerFinally",
                "after",
            ] {
                assert_eq!(
                    engine.to_val(&engine.get(&markers, key).unwrap()),
                    Val::Num(0.0),
                    "{key}; call_from_rust={call_from_rust}"
                );
            }
            // A native interrupt aborts this entry, not all future VM entries.
            let resumed = engine.eval_script("6 * 7", "after-interrupt", 1).unwrap();
            assert_eq!(engine.to_val(&resumed), Val::Num(42.0));
            std::mem::forget(engine);
        }
    }

    #[test]
    fn data_arrays_leave_no_exception() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            let array = ctx.eval::<Value, _>("[1, 2]").unwrap();
            assert_eq!(
                to_val(&array),
                Val::Array(vec![Val::Num(1.0), Val::Num(2.0)])
            );
            assert!(
                !ctx.has_exception(),
                "array conversion left an exception pending"
            );
            let object = ctx.eval::<Value, _>("({ answer: 3 })").unwrap();
            assert_eq!(
                to_val(&object),
                Val::Object(vec![("answer".into(), Val::Num(3.0))])
            );
            assert!(
                !ctx.has_exception(),
                "object conversion left an exception pending"
            );
            let bytes = ctx
                .eval::<Value, _>("new Uint8Array([4, 5]).buffer")
                .unwrap();
            assert_eq!(to_val(&bytes), Val::Bytes(vec![4, 5]));
            assert!(
                !ctx.has_exception(),
                "buffer conversion left an exception pending"
            );
            if ctx
                .eval::<bool, _>("typeof SharedArrayBuffer === 'function'")
                .unwrap()
            {
                let shared = ctx.eval::<Value, _>("new SharedArrayBuffer(2)").unwrap();
                assert_eq!(to_val(&shared), Val::Bytes(vec![0, 0]));
                assert!(
                    !ctx.has_exception(),
                    "shared buffer conversion left an exception pending"
                );
            }
        });
    }

    fn function_bytes(runtime: &Runtime) -> i64 {
        runtime.run_gc();
        runtime.memory_usage().js_func_size
    }

    #[test]
    fn nested_functions_share_one_source_copy() {
        // A module wrapper around nested functions, like a webpack chunk: each
        // level used to keep a private copy of its whole text for toString.
        let depth = 24;
        let body = format!("var padding = {:?};", "x".repeat(16 * 1024));
        let mut source = String::new();
        for level in 0..depth {
            source.push_str(&format!("function level{level}() {{ {body} return "));
        }
        source.push_str("1;");
        for _ in 0..depth {
            source.push_str(" }");
        }
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let before = function_bytes(&runtime);
        context.with(|ctx| {
            ctx.eval::<(), _>(format!(
                "globalThis.keep = (function () {{ {source}\n return level0; }})();"
            ))
            .unwrap();
        });
        let retained = function_bytes(&runtime) - before;
        assert!(
            retained < 2 * source.len() as i64,
            "{depth} nested functions retained {retained} bytes of function data for {} source bytes",
            source.len()
        );
        context.with(|ctx| {
            let text: String = ctx.eval("String(keep)").unwrap();
            assert!(text.starts_with("function level0() {") && text.ends_with(" }"));
            let inner: String = ctx
                .eval("String(new Function('return ' + String(keep))()())")
                .unwrap();
            assert!(inner.starts_with("function level1() {"));
        });
    }

    #[test]
    fn function_source_survives_its_parse_input() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            ctx.eval::<(), _>(
                "globalThis.fns = [eval('(x => x)'), new Function('a', 'return a'), \
                 eval('(class A { m() { return () => 1; } })'), eval('({ get g() { return 1; } })')];",
            )
            .unwrap();
        });
        // Collect the eval inputs and strings before reading the sources back.
        runtime.run_gc();
        context.with(|ctx| {
            let text: String = ctx
                .eval("[String(fns[0]), String(fns[1]), String(fns[2]), String(new fns[2]().m()), String(Object.getOwnPropertyDescriptor(fns[3], 'g').get)].join('|')")
                .unwrap();
            assert_eq!(
                text,
                "x => x|function anonymous(a\n) {\nreturn a\n}|class A { m() { return () => 1; } }|() => 1|get g() { return 1; }"
            );
        });
    }

    fn alive_after_gc(script: &str, check: &str) -> String {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| ctx.eval::<(), _>(script).unwrap());
        runtime.run_gc();
        context.with(|ctx| ctx.eval::<String, _>(check).unwrap())
    }

    #[test]
    fn weak_map_value_dies_with_its_map() {
        // webpack keys each compilation's ModuleGraph WeakMap by long-lived
        // dependencies; the value reaches the graph that owns the map.
        let alive = alive_after_gc(
            "globalThis.dependency = {}; globalThis.graphs = [];
             for (let generation = 0; generation < 5; generation++) {
               const graph = { dependencyMap: new WeakMap(), payload: new Array(1000).fill(generation) };
               graph.dependencyMap.set(dependency, { condition: () => graph });
               graphs.push(new WeakRef(graph));
             }",
            "String(graphs.filter(ref => ref.deref()).length)",
        );
        assert_eq!(
            alive, "0",
            "old graphs stayed alive through their own WeakMap"
        );
    }

    #[test]
    fn weak_map_values_follow_ephemeron_reachability() {
        let result = alive_after_gc(
            "globalThis.cases = [];
             const check = (name, value, expected) => cases.push([name, new WeakRef(value), expected]);
             globalThis.both = { key: {}, map: new WeakMap() };
             { const value = { tag: 1 }; both.map.set(both.key, value); check('key and map live', value, true); }
             globalThis.selfMap = { key: {}, map: new WeakMap() };
             { const value = { map: selfMap.map }; selfMap.map.set(selfMap.key, value); check('value reaches a live map', value, true); }
             globalThis.liveKey = {};
             { const map = new WeakMap(); const value = { map }; map.set(liveKey, value); check('map only through its value', value, false); }
             globalThis.chain = { root: {}, first: new WeakMap(), second: new WeakMap() };
             { const middle = {}; const value = { tag: 4 }; chain.first.set(chain.root, middle); chain.second.set(middle, value); check('chained entries', value, true); }
             globalThis.deadKeyMap = new WeakMap();
             { const key = {}; const value = { key }; deadKeyMap.set(key, value); check('key only through its value', value, false); }",
            "cases.filter(([, ref, expected]) => (ref.deref() !== undefined) !== expected).map(([name]) => name).join(',') +
             '|' + [both.map.get(both.key).tag, selfMap.map.has(selfMap.key), chain.second.get(chain.first.get(chain.root)).tag].join(',')",
        );
        assert_eq!(result, "|1,true,4");
    }

    #[test]
    fn parser_lookahead_leaves_no_exception() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            // The arrow-function lookahead reads `/ v,` after the `else` keyword
            // as a regexp, which fails at the line end (@vercel/nft static-eval).
            let source =
                "var l = { else: 6 }, v = 2;\n(\n  { else: l.else / v,\n    then: 1 }\n).else";
            let value = ctx.eval::<Value, _>(source).unwrap();
            assert_eq!(to_val(&value), Val::Num(3.0));
            assert!(
                !ctx.has_exception(),
                "a failed parser lookahead left its SyntaxError pending"
            );
        });
    }
}
