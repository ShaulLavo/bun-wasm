//! [`Engine`] on Bun's JavaScriptCore (crates/bunwasm-jsc: the C API plus
//! cpp/helpers.cpp for module loading, script evaluation and microtasks).
//!
//! GC: JSC finds live values by scanning the native stack conservatively,
//! which works on wasm only after `wasm-opt --spill-pointers` (jsc/finalize.sh).
//! Values the runtime keeps anywhere else (the heap, statics) are [`JsVal`]s,
//! which hold a `JSValueProtect` reference while they exist.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::ptr;
use std::rc::Rc;

use bunwasm_jsc::JsString;
use bunwasm_jsc::sys::*;

use crate::engine::{Engine, ErrorKind, ModuleHost, NativeError, PromiseState, Val, ValueFn};

thread_local! {
    static CTX: Cell<JSContextRef> = const { Cell::new(ptr::null()) };
    /// Natives by function object (one C callback dispatches them all).
    static NATIVES: RefCell<HashMap<usize, ValueFn<Jsc>>> = RefCell::new(HashMap::new());
    static HOST: RefCell<Option<Rc<dyn ModuleHost<Jsc>>>> = const { RefCell::new(None) };
    /// Module sources registered by `eval_module` (bun -e), served by fetch.
    static VIRTUAL: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    static REJECTIONS: RefCell<Vec<(JsVal, JsVal)>> = const { RefCell::new(Vec::new()) };
}

fn ctx() -> JSContextRef {
    CTX.with(Cell::get)
}

/// A protected JS value: kept alive (and not collected) while it exists.
pub struct JsVal(JSValueRef);

impl JsVal {
    fn new(v: JSValueRef) -> JsVal {
        let v = if v.is_null() {
            unsafe { JSValueMakeUndefined(ctx()) }
        } else {
            v
        };
        // SAFETY: a live value of the one context.
        unsafe { JSValueProtect(ctx(), v) };
        JsVal(v)
    }
    fn raw(&self) -> JSValueRef {
        self.0
    }
    fn object(&self) -> JSObjectRef {
        self.0 as JSObjectRef
    }
}

impl Clone for JsVal {
    fn clone(&self) -> JsVal {
        JsVal::new(self.0)
    }
}

impl Drop for JsVal {
    fn drop(&mut self) {
        // SAFETY: we hold one protect reference.
        unsafe { JSValueUnprotect(ctx(), self.0) }
    }
}

/// JavaScriptCore. A unit handle: the context is per thread (one per process).
#[derive(Clone, Copy)]
pub struct Jsc;

fn checked(exc: JSValueRef, v: JSValueRef) -> Result<JsVal, JsVal> {
    if exc.is_null() {
        Ok(JsVal::new(v))
    } else {
        Err(JsVal::new(exc))
    }
}

fn js_string(s: &str) -> JSValueRef {
    let s = JsString::new(s);
    // SAFETY: JSValueMakeString retains the string.
    unsafe { JSValueMakeString(ctx(), s.raw()) }
}

fn to_rust_string(v: JSValueRef) -> Option<String> {
    let mut exc = ptr::null();
    // SAFETY: valid context and value; the copy is released by JsString.
    let s = unsafe { JSValueToStringCopy(ctx(), v, &mut exc) };
    if !exc.is_null() || s.is_null() {
        return None;
    }
    Some(own_string(s).to_rust())
}

fn own_string(s: JSStringRef) -> JsString {
    // SAFETY: JSValueToStringCopy returned a reference we own.
    unsafe { JsString::from_owned(s) }
}

fn get_raw(obj: JSObjectRef, key: &str) -> Result<JSValueRef, JSValueRef> {
    let name = JsString::new(key);
    let mut exc = ptr::null();
    // SAFETY: valid context, object and name.
    let v = unsafe { JSObjectGetProperty(ctx(), obj, name.raw(), &mut exc) };
    if exc.is_null() { Ok(v) } else { Err(exc) }
}

fn global_function(name: &str) -> JSObjectRef {
    // SAFETY: valid context.
    let global = unsafe { JSContextGetGlobalObject(ctx()) };
    get_raw(global, name)
        .map(|v| v as JSObjectRef)
        .unwrap_or(ptr::null_mut())
}

/// `Object.keys(obj)` (cached).
fn object_keys(obj: JSValueRef) -> Vec<String> {
    thread_local! {
        static KEYS: Cell<JSObjectRef> = const { Cell::new(ptr::null_mut()) };
    }
    let f = KEYS.with(|k| {
        if k.get().is_null() {
            let object = global_function("Object");
            let keys = get_raw(object, "keys").unwrap_or(ptr::null()) as JSObjectRef;
            // SAFETY: kept for the life of the process.
            unsafe { JSValueProtect(ctx(), keys) };
            k.set(keys);
        }
        k.get()
    });
    let mut exc = ptr::null();
    // SAFETY: valid function; one argument.
    let arr = unsafe { JSObjectCallAsFunction(ctx(), f, ptr::null_mut(), 1, &obj, &mut exc) };
    if !exc.is_null() || arr.is_null() {
        return Vec::new();
    }
    let items = array_items(arr);
    items
        .iter()
        .filter_map(|item| to_rust_string(item.raw()))
        .collect()
}

fn array_items(arr: JSValueRef) -> Vec<JsVal> {
    let arr = JsVal::new(arr);
    let obj = arr.object();
    let len = get_raw(obj, "length")
        .map(|v| unsafe { JSValueToNumber(ctx(), v, ptr::null_mut()) })
        .unwrap_or(0.0) as u32;
    // SAFETY: valid array object.
    (0..len)
        .map(|i| JsVal::new(unsafe { JSObjectGetPropertyAtIndex(ctx(), obj, i, ptr::null_mut()) }))
        .collect()
}

// The JSC C API's enum constants (kJSType*) are used as match patterns.
#[allow(non_upper_case_globals)]
fn to_val(v: JSValueRef) -> Val {
    let c = ctx();
    // SAFETY: valid context and value throughout.
    unsafe {
        match JSValueGetType(c, v) {
            kJSTypeUndefined => return Val::Undefined,
            kJSTypeNull => return Val::Null,
            kJSTypeBoolean => return Val::Bool(JSValueToBoolean(c, v)),
            kJSTypeNumber => return Val::Num(JSValueToNumber(c, v, ptr::null_mut())),
            kJSTypeString => return to_rust_string(v).map_or(Val::Undefined, Val::Str),
            kJSTypeSymbol => return Val::Undefined,
            _ => {}
        }
        if JSValueIsBigInt(c, v) {
            return Val::BigInt(JSValueToInt64(c, v, ptr::null_mut()));
        }
        if JSValueGetTypedArrayType(c, v, ptr::null_mut()) != kJSTypedArrayTypeNone {
            return bunwasm_jsc::Js { ctx: c }
                .bytes(v)
                .map_or(Val::Undefined, Val::Bytes);
        }
        if JSValueIsArray(c, v) {
            let items = array_items(v);
            return Val::Array(items.iter().map(|item| to_val(item.raw())).collect());
        }
        if JSObjectIsFunction(c, v as JSObjectRef) {
            return Val::Undefined;
        }
        let fields = object_keys(v)
            .into_iter()
            .map(|k| {
                let item = get_raw(v as JSObjectRef, &k)
                    .map(to_val)
                    .unwrap_or(Val::Undefined);
                (k, item)
            })
            .collect();
        Val::Object(fields)
    }
}

/// A Uint8Array filled with `bytes`, made by `new Uint8Array(len)`: arrays
/// made by the C API (JSObjectMakeTypedArray*) read `arr.buffer` as
/// undefined in this C-loop build (the getter itself works), which breaks
/// `bytes.buffer.slice(...)`.
fn uint8_array(bytes: &[u8]) -> JSValueRef {
    thread_local! {
        static CTOR: Cell<JSObjectRef> = const { Cell::new(ptr::null_mut()) };
    }
    let c = ctx();
    let ctor = CTOR.with(|k| {
        if k.get().is_null() {
            let f = global_function("Uint8Array");
            // SAFETY: kept for the life of the process.
            unsafe { JSValueProtect(c, f) };
            k.set(f);
        }
        k.get()
    });
    // SAFETY: a fresh array of `len` bytes; its storage is written before any JS runs.
    // bunjsc_buffer_bytes leaves it unpinned, so the result stays transferable.
    unsafe {
        let len = JSValueMakeNumber(c, bytes.len() as f64);
        let arr = JSObjectCallAsConstructor(c, ctor, 1, &len, ptr::null_mut());
        if !bytes.is_empty() {
            let mut size = 0;
            let data = bunjsc_buffer_bytes(c, arr, &mut size);
            ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len().min(size));
        }
        arr
    }
}

fn value_from(v: Val) -> JSValueRef {
    let c = ctx();
    // SAFETY: valid context throughout.
    unsafe {
        match v {
            Val::Undefined => JSValueMakeUndefined(c),
            Val::Null => JSValueMakeNull(c),
            Val::Bool(b) => JSValueMakeBoolean(c, b),
            Val::Num(n) => JSValueMakeNumber(c, n),
            Val::BigInt(n) => JSBigIntCreateWithInt64(c, n, ptr::null_mut()),
            Val::BigUint(n) => JSBigIntCreateWithUInt64(c, n, ptr::null_mut()),
            Val::Str(s) => js_string(&s),
            Val::Bytes(b) => uint8_array(&b),
            Val::Array(items) => {
                // Keep the items reachable while the array is built.
                let items: Vec<JsVal> = items
                    .into_iter()
                    .map(|i| JsVal::new(value_from(i)))
                    .collect();
                let raw: Vec<JSValueRef> = items.iter().map(JsVal::raw).collect();
                JSObjectMakeArray(c, raw.len(), raw.as_ptr(), ptr::null_mut())
            }
            Val::Object(fields) => {
                let obj = JsVal::new(JSObjectMake(c, ptr::null_mut(), ptr::null_mut()));
                for (k, item) in fields {
                    let name = JsString::new(&k);
                    JSObjectSetProperty(
                        c,
                        obj.object(),
                        name.raw(),
                        value_from(item),
                        kJSPropertyAttributeNone,
                        ptr::null_mut(),
                    );
                }
                obj.raw()
            }
        }
    }
}

/// A non-enumerable own property (like `name` on built-in errors). The C
/// API's attribute flags don't apply here, so use Object.defineProperty.
fn define_hidden(obj: &JsVal, key: &str, value: JSValueRef) {
    thread_local! {
        static DEFINE: Cell<JSObjectRef> = const { Cell::new(ptr::null_mut()) };
    }
    let f = DEFINE.with(|d| {
        if d.get().is_null() {
            let src = "(function (o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); })";
            if let Ok(v) = Jsc.eval_script(src, "bun-wasm:define", 1) {
                // SAFETY: kept for the life of the process.
                unsafe { JSValueProtect(ctx(), v.raw()) };
                d.set(v.object());
            }
        }
        d.get()
    });
    let args = [obj.raw(), js_string(key), value];
    // SAFETY: valid function; the arguments are live on the stack.
    unsafe { JSObjectCallAsFunction(ctx(), f, ptr::null_mut(), 3, args.as_ptr(), ptr::null_mut()) };
}

/// The one C callback behind every native: finds the closure by function.
unsafe extern "C" fn dispatch(
    _ctx: JSContextRef,
    function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *const JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let Some(f) = NATIVES.with(|n| n.borrow().get(&(function as usize)).cloned()) else {
        return unsafe { JSValueMakeUndefined(ctx()) };
    };
    // SAFETY: JSC passes argc valid values.
    let raw: &[JSValueRef] = if argc == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(argv, argc) }
    };
    let args: Vec<JsVal> = raw.iter().map(|v| JsVal::new(*v)).collect();
    match f(&Jsc, &args) {
        Ok(v) => v.raw(),
        Err(thrown) => {
            // SAFETY: JSC's out-parameter.
            unsafe { *exception = thrown.raw() };
            ptr::null()
        }
    }
}

fn with_host<R>(f: impl FnOnce(&Rc<dyn ModuleHost<Jsc>>) -> R) -> R {
    let host = HOST
        .with(|h| h.borrow().clone())
        .expect("module host installed");
    f(&host)
}

fn c_string_out(s: String) -> *mut c_char {
    CString::new(s).unwrap_or_default().into_raw()
}

fn cstr(p: *const c_char) -> String {
    // SAFETY: helpers.cpp passes NUL-terminated UTF-8.
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_uncaught(context: JSContextRef, value: JSValueRef) {
    assert_eq!(
        context,
        ctx(),
        "uncaught value belongs to the active context"
    );
    let value = JsVal::new(value);
    with_host(|host| host.uncaught(&Jsc, &value));
}

// Called at saved C-loop trap points. This only polls fatal host cancellation;
// handled signals stay pending and guest JavaScript must never run from here.
#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_interrupt() -> bool {
    with_host(|host| host.interrupt())
}

#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_resolve(
    specifier: *const c_char,
    referrer: *const c_char,
    exception: *mut JSValueRef,
) -> *mut c_char {
    let specifier = cstr(specifier);
    if VIRTUAL.with(|v| v.borrow().contains_key(&specifier)) {
        return c_string_out(specifier);
    }
    match with_host(|h| h.resolve(&Jsc, &specifier, &cstr(referrer))) {
        Ok(key) => c_string_out(key),
        Err(thrown) => {
            // SAFETY: helpers.cpp's out-parameter.
            unsafe { *exception = thrown.raw() };
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_fetch(key: *const c_char, exception: *mut JSValueRef) -> *mut c_char {
    let key = cstr(key);
    if let Some(source) = VIRTUAL.with(|v| v.borrow().get(&key).cloned()) {
        return c_string_out(source);
    }
    match with_host(|h| h.load(&Jsc, &key)) {
        Ok(source) => c_string_out(source),
        Err(thrown) => {
            // SAFETY: helpers.cpp's out-parameter.
            unsafe { *exception = thrown.raw() };
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_init_meta(
    meta: JSValueRef,
    key: *const c_char,
    exception: *mut JSValueRef,
) {
    let meta = JsVal::new(meta);
    if let Err(thrown) = with_host(|h| h.init_meta(&Jsc, &cstr(key), &meta)) {
        // SAFETY: helpers.cpp's out-parameter.
        unsafe { *exception = thrown.raw() };
    }
}

#[unsafe(no_mangle)]
extern "C" fn bunjsc_host_free(p: *mut c_char) {
    if !p.is_null() {
        // SAFETY: made by c_string_out.
        drop(unsafe { CString::from_raw(p) });
    }
}

impl Engine for Jsc {
    type Value = JsVal;

    fn new(host: Rc<dyn ModuleHost<Jsc>>) -> Jsc {
        // SAFETY: plain constructor (cpp/helpers.cpp).
        let c = unsafe { bunjsc_create_context() };
        CTX.with(|x| x.set(c));
        // Hold the API lock so microtasks only run in run_jobs.
        unsafe { bunjsc_enter(c) };
        let has_interrupt_handler = host.has_interrupt_handler();
        HOST.with(|h| *h.borrow_mut() = Some(host));
        let tracker = Jsc.new_function(
            "unhandledRejection",
            Rc::new(|e: &Jsc, args: &[JsVal]| {
                let promise = args.first().cloned().unwrap_or_else(|| e.undefined());
                let reason = args.get(1).cloned().unwrap_or_else(|| e.undefined());
                REJECTIONS.with(|r| r.borrow_mut().push((promise, reason)));
                Ok(e.undefined())
            }),
        );
        // SAFETY: the context was created by bunjsc_create_context.
        unsafe {
            JSGlobalContextSetUnhandledRejectionCallback(
                c as JSGlobalContextRef,
                tracker.object(),
                ptr::null_mut(),
            )
        };
        std::mem::forget(tracker);
        if has_interrupt_handler {
            // SAFETY: the context and its host are fully installed; the C++
            // adapter enables polling only at saved interpreter trap points.
            unsafe { bunjsc_set_interrupt_handler(c, true) };
        }
        #[cfg(test)]
        install_regression_natives(&Jsc);
        Jsc
    }

    fn name(&self) -> &'static str {
        "jsc"
    }

    fn undefined(&self) -> JsVal {
        JsVal::new(unsafe { JSValueMakeUndefined(ctx()) })
    }

    fn is_undefined(&self, v: &JsVal) -> bool {
        unsafe { JSValueIsUndefined(ctx(), v.raw()) }
    }

    fn to_val(&self, v: &JsVal) -> Val {
        to_val(v.raw())
    }

    fn value_from(&self, v: Val) -> JsVal {
        JsVal::new(value_from(v))
    }

    fn new_object(&self) -> JsVal {
        JsVal::new(unsafe { JSObjectMake(ctx(), ptr::null_mut(), ptr::null_mut()) })
    }

    fn get(&self, obj: &JsVal, key: &str) -> Result<JsVal, JsVal> {
        if !unsafe { JSValueIsObject(ctx(), obj.raw()) } {
            return Err(self.error_value(&NativeError::type_error(format!(
                "cannot read property '{key}' of a primitive"
            ))));
        }
        get_raw(obj.object(), key)
            .map(JsVal::new)
            .map_err(JsVal::new)
    }

    fn set(&self, obj: &JsVal, key: &str, value: JsVal) -> Result<(), JsVal> {
        let name = JsString::new(key);
        let mut exc = ptr::null();
        // SAFETY: valid context, object, name and value.
        unsafe {
            JSObjectSetProperty(
                ctx(),
                obj.object(),
                name.raw(),
                value.raw(),
                kJSPropertyAttributeNone,
                &mut exc,
            )
        };
        if exc.is_null() {
            Ok(())
        } else {
            Err(JsVal::new(exc))
        }
    }

    fn keys(&self, obj: &JsVal) -> Vec<String> {
        if !unsafe { JSValueIsObject(ctx(), obj.raw()) } {
            return Vec::new();
        }
        object_keys(obj.raw())
    }

    fn error_value(&self, err: &NativeError) -> JsVal {
        let ctor = match err.kind {
            ErrorKind::Error => "Error",
            ErrorKind::TypeError => "TypeError",
            ErrorKind::RangeError => "RangeError",
            ErrorKind::SyntaxError => "SyntaxError",
        };
        let message = js_string(&err.message);
        // SAFETY: valid constructor; one argument.
        let e = JsVal::new(unsafe {
            JSObjectCallAsConstructor(ctx(), global_function(ctor), 1, &message, ptr::null_mut())
        });
        for (k, v) in &err.props {
            if k == "name" {
                define_hidden(&e, k, value_from(v.clone()));
                continue;
            }
            let name = JsString::new(k);
            unsafe {
                JSObjectSetProperty(
                    ctx(),
                    e.object(),
                    name.raw(),
                    value_from(v.clone()),
                    kJSPropertyAttributeNone,
                    ptr::null_mut(),
                )
            };
        }
        if let Some(n) = &err.name {
            define_hidden(&e, "name", js_string(n));
        }
        e
    }

    fn new_function(&self, name: &str, f: ValueFn<Self>) -> JsVal {
        let n = JsString::new(name);
        // SAFETY: `dispatch` has the C API callback signature.
        let func =
            JsVal::new(unsafe { JSObjectMakeFunctionWithCallback(ctx(), n.raw(), dispatch) });
        // Natives live for the process: keep them protected (and their address stable).
        unsafe { JSValueProtect(ctx(), func.raw()) };
        NATIVES.with(|m| m.borrow_mut().insert(func.raw() as usize, f));
        func
    }

    fn call(&self, f: &JsVal, this: &JsVal, args: &[JsVal]) -> Result<JsVal, JsVal> {
        let c = ctx();
        if !unsafe { JSValueIsObject(c, f.raw()) && JSObjectIsFunction(c, f.object()) } {
            return Err(self.error_value(&NativeError::type_error("not a function")));
        }
        let raw: Vec<JSValueRef> = args.iter().map(JsVal::raw).collect();
        let this = if unsafe { JSValueIsObject(c, this.raw()) } {
            this.object()
        } else {
            ptr::null_mut()
        };
        let mut exc = ptr::null();
        // SAFETY: valid function; the arguments are protected by `args`.
        let v = unsafe {
            JSObjectCallAsFunction(c, f.object(), this, raw.len(), raw.as_ptr(), &mut exc)
        };
        checked(exc, v)
    }

    fn eval_script(&self, source: &str, filename: &str, first_line: i32) -> Result<JsVal, JsVal> {
        let src = CString::new(source).unwrap_or_default();
        let name = CString::new(filename).unwrap_or_default();
        let mut exc = ptr::null();
        // SAFETY: NUL-terminated strings.
        let v = unsafe {
            bunjsc_evaluate_script(ctx(), src.as_ptr(), name.as_ptr(), first_line, &mut exc)
        };
        checked(exc, v)
    }

    fn import_module(&self, specifier: &str) -> Result<JsVal, JsVal> {
        let spec = CString::new(specifier).unwrap_or_default();
        let mut exc = ptr::null();
        // SAFETY: NUL-terminated specifier.
        let v = unsafe { bunjsc_import(ctx(), spec.as_ptr(), &mut exc) };
        checked(exc, v)
    }

    fn eval_module(&self, name: &str, source: &str) -> Result<JsVal, JsVal> {
        VIRTUAL.with(|v| v.borrow_mut().insert(name.to_owned(), source.to_owned()));
        self.import_module(name)
    }

    fn run_jobs(&self) -> bool {
        // SAFETY: valid context.
        unsafe { bunjsc_drain_microtasks(ctx()) }
    }

    fn promise_state(&self, v: &JsVal) -> Option<PromiseState> {
        // SAFETY: valid context and value.
        match unsafe { bunjsc_promise_state(ctx(), v.raw()) } {
            0 => Some(PromiseState::Pending),
            1 => Some(PromiseState::Fulfilled),
            2 => Some(PromiseState::Rejected),
            _ => None,
        }
    }

    fn promise_result(&self, v: &JsVal) -> JsVal {
        if self.promise_state(v).is_none() {
            return v.clone();
        }
        JsVal::new(unsafe { bunjsc_promise_result(ctx(), v.raw()) })
    }

    fn promise_then(
        &self,
        promise: &JsVal,
        fulfilled: &JsVal,
        rejected: &JsVal,
    ) -> Result<JsVal, JsVal> {
        let mut exc = ptr::null();
        // SAFETY: the helper holds the VM lock and checks the promise brand.
        let result = unsafe {
            bunjsc_promise_then(
                ctx(),
                promise.raw(),
                fulfilled.raw(),
                rejected.raw(),
                &mut exc,
            )
        };
        checked(exc, result)
    }

    fn take_unhandled_rejections(&self) -> Vec<(JsVal, JsVal)> {
        REJECTIONS.with(|r| r.borrow_mut().drain(..).collect())
    }

    fn same_value(&self, a: &JsVal, b: &JsVal) -> bool {
        unsafe { JSValueIsStrictEqual(ctx(), a.raw(), b.raw()) }
    }

    fn is_promise(&self, v: &JsVal) -> bool {
        self.promise_state(v).is_some()
    }

    fn is_proxy(&self, v: &JsVal) -> bool {
        !unsafe { bunjsc_proxy_target(ctx(), v.raw()) }.is_null()
    }

    fn is_detachable_buffer(&self, v: &JsVal) -> bool {
        // SAFETY: the helper only inspects the buffer under the VM lock.
        unsafe { bunjsc_is_detachable_buffer(ctx(), v.raw()) }
    }

    fn detach_buffer(&self, v: &JsVal) {
        // SAFETY: the transfer native validated every buffer before detaching any.
        unsafe { bunjsc_detach_buffer(ctx(), v.raw()) }
    }

    unsafe fn wasm_memory_buffer(&self, data: *mut u8, length: usize) -> JsVal {
        // SAFETY: the caller keeps the bytes valid until the buffer is detached.
        JsVal::new(unsafe { bunjsc_wasm_memory_buffer(ctx(), data, length) })
    }

    fn detach_wasm_memory_buffer(&self, v: &JsVal) -> bool {
        // SAFETY: the helper checks the value is a wasm memory buffer under the VM lock.
        unsafe { bunjsc_detach_wasm_memory_buffer(ctx(), v.raw()) }
    }

    fn proxy_target(&self, v: &JsVal) -> JsVal {
        let t = unsafe { bunjsc_proxy_target(ctx(), v.raw()) };
        if t.is_null() {
            self.undefined()
        } else {
            JsVal::new(t)
        }
    }

    fn is_error(&self, v: &JsVal) -> bool {
        unsafe { bunjsc_is_error(ctx(), v.raw()) }
    }

    fn iterator_entries(&self, _: &JsVal) -> Option<JsVal> {
        None
    }

    fn own_keys_in_order(&self, _: &JsVal) -> Option<JsVal> {
        // JSC's Reflect.ownKeys order is already what its console prints.
        None
    }

    fn async_context(&self) -> JsVal {
        // SAFETY: valid context.
        JsVal::new(unsafe { bunjsc_get_async_context(ctx()) })
    }

    fn set_async_context(&self, v: &JsVal) {
        // SAFETY: valid context and value (JSC keeps its own reference).
        unsafe { bunjsc_set_async_context(ctx(), v.raw()) }
    }

    fn gc(&self) {
        unsafe { bunjsc_collect_garbage(ctx()) }
    }

    fn memory_usage(&self) -> Val {
        #[cfg(target_arch = "wasm32")]
        let bytes = (core::arch::wasm32::memory_size(0) * 65536) as f64;
        #[cfg(not(target_arch = "wasm32"))]
        let bytes = 0.0;
        crate::engine::Record::new()
            .set("rss", bytes)
            .set("heapTotal", bytes)
            .set("heapUsed", bytes)
            .set("external", 0)
            .set("arrayBuffers", 0)
            .into()
    }
}

#[cfg(test)]
fn install_regression_natives(engine: &Jsc) {
    let global = JsVal::new(unsafe { JSContextGetGlobalObject(ctx()) });
    let convert = engine.new_function(
        "__jsc_test_convert",
        Rc::new(|engine, args| {
            let value = args.first().expect("conversion argument");
            Ok(engine.value_from(engine.to_val(value)))
        }),
    );
    assert!(engine.set(&global, "__jsc_test_convert", convert).is_ok());
    let report = engine.new_function(
        "__jsc_test_report",
        Rc::new(|engine, args| {
            let value = args.first().expect("report argument");
            unsafe { bunjsc_report_unhandled_error(ctx(), value.raw()) };
            Ok(engine.undefined())
        }),
    );
    assert!(engine.set(&global, "__jsc_test_report", report).is_ok());
}
