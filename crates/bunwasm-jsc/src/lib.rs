//! Bun's JavaScriptCore, compiled to wasm32-wasip1 (C loop interpreter), behind its C API.
//!
//! [`sys`] declares the C API; [`Js`] is a thin, copyable handle over a context with the
//! conversions bunwasm-runtime's JSC engine (src/engine_jsc.rs) needs. Values are raw `JSValueRef`s: JSC finds the ones on the
//! stack by scanning it conservatively, which on wasm only works after `wasm-opt --spill-pointers`
//! (jsc/finalize.sh). Values kept anywhere else (statics, heap) must be `protect`ed.
pub mod sys;

use core::ffi::c_void;
use core::ptr;

pub use sys::{JSContextRef, JSObjectRef, JSValueRef};
use sys::*;

/// Bun version the runtime reports (vendor/bun/package.json), like bunwasm-runtime.
pub const BUN_VERSION: &str = env!("BUNWASM_BUN_VERSION");

/// A JS exception value, or a message to throw as an `Error`.
pub enum Thrown {
    Value(JSValueRef),
    Message(String),
}

impl From<String> for Thrown {
    fn from(s: String) -> Self {
        Thrown::Message(s)
    }
}
impl From<&str> for Thrown {
    fn from(s: &str) -> Self {
        Thrown::Message(s.to_owned())
    }
}

pub type JsResult<T> = Result<T, Thrown>;

/// An owned `JSStringRef`.
pub struct JsString(JSStringRef);

impl JsString {
    pub fn new(s: &str) -> Self {
        let units: Vec<u16> = s.encode_utf16().collect();
        // SAFETY: units is a valid UTF-16 buffer of that length; JSC copies it.
        JsString(unsafe { JSStringCreateWithCharacters(units.as_ptr(), units.len()) })
    }
    pub fn raw(&self) -> JSStringRef {
        self.0
    }
    /// Take ownership of one reference to `s` (e.g. from JSValueToStringCopy).
    ///
    /// # Safety
    /// `s` must be a live string whose reference the caller owns.
    pub unsafe fn from_owned(s: JSStringRef) -> Self {
        JsString(s)
    }
    pub fn to_rust(&self) -> String {
        // SAFETY: self.0 is a live string; the pointer is valid for its length.
        unsafe {
            let len = JSStringGetLength(self.0);
            if len == 0 {
                return String::new();
            }
            let units = core::slice::from_raw_parts(JSStringGetCharactersPtr(self.0), len);
            String::from_utf16_lossy(units)
        }
    }
}

impl Drop for JsString {
    fn drop(&mut self) {
        // SAFETY: we own one reference.
        unsafe { JSStringRelease(self.0) }
    }
}

/// A context handle. Copyable: it does not own the context.
#[derive(Clone, Copy)]
pub struct Js {
    pub ctx: JSContextRef,
}

impl Js {
    /// Creates a new global context (a new VM) with an ES module loader that calls back into the
    /// runtime (cpp/helpers.cpp `bunjsc_host_*`). It is never released: VM teardown is not supported on this build
    /// (see jsc/README.md), and Bun never tears its VM down either.
    pub fn new_context() -> Js {
        // SAFETY: plain constructor (cpp/helpers.cpp).
        let ctx = unsafe { bunjsc_create_context() };
        Js { ctx }
    }

    pub fn global(self) -> JSObjectRef {
        // SAFETY: valid context.
        unsafe { JSContextGetGlobalObject(self.ctx) }
    }

    fn check<T>(self, exc: JSValueRef, value: T) -> JsResult<T> {
        if exc.is_null() { Ok(value) } else { Err(Thrown::Value(exc)) }
    }

    pub fn eval(self, source: &str, url: &str) -> JsResult<JSValueRef> {
        let src = JsString::new(source);
        let url = JsString::new(url);
        let mut exc = ptr::null();
        // SAFETY: valid context and strings.
        let v = unsafe { JSEvaluateScript(self.ctx, src.raw(), ptr::null_mut(), url.raw(), 1, &mut exc) };
        self.check(exc, v)
    }

    pub fn call(self, f: JSValueRef, this: JSObjectRef, args: &[JSValueRef]) -> JsResult<JSValueRef> {
        let f = self.to_object(f)?;
        let mut exc = ptr::null();
        // SAFETY: valid context; args outlive the call.
        let v = unsafe { JSObjectCallAsFunction(self.ctx, f, this, args.len(), args.as_ptr(), &mut exc) };
        self.check(exc, v)
    }

    pub fn get(self, obj: JSObjectRef, name: &str) -> JsResult<JSValueRef> {
        let name = JsString::new(name);
        let mut exc = ptr::null();
        // SAFETY: valid context, object and name.
        let v = unsafe { JSObjectGetProperty(self.ctx, obj, name.raw(), &mut exc) };
        self.check(exc, v)
    }

    pub fn set(self, obj: JSObjectRef, name: &str, value: JSValueRef) {
        let name = JsString::new(name);
        // SAFETY: valid context, object, name and value. Plain objects don't throw on set.
        unsafe { JSObjectSetProperty(self.ctx, obj, name.raw(), value, kJSPropertyAttributeNone, ptr::null_mut()) }
    }

    pub fn object(self) -> JSObjectRef {
        // SAFETY: plain object, no class.
        unsafe { JSObjectMake(self.ctx, ptr::null_mut(), ptr::null_mut()) }
    }

    pub fn function(self, name: &str, cb: JSObjectCallAsFunctionCallback) -> JSObjectRef {
        let name = JsString::new(name);
        // SAFETY: cb has the C API callback signature.
        unsafe { JSObjectMakeFunctionWithCallback(self.ctx, name.raw(), cb) }
    }

    pub fn undefined(self) -> JSValueRef {
        // SAFETY: valid context.
        unsafe { JSValueMakeUndefined(self.ctx) }
    }
    pub fn null(self) -> JSValueRef {
        // SAFETY: valid context.
        unsafe { JSValueMakeNull(self.ctx) }
    }
    pub fn bool(self, b: bool) -> JSValueRef {
        // SAFETY: valid context.
        unsafe { JSValueMakeBoolean(self.ctx, b) }
    }
    pub fn number(self, n: f64) -> JSValueRef {
        // SAFETY: valid context.
        unsafe { JSValueMakeNumber(self.ctx, n) }
    }
    pub fn string(self, s: &str) -> JSValueRef {
        let s = JsString::new(s);
        // SAFETY: JSValueMakeString retains the string.
        unsafe { JSValueMakeString(self.ctx, s.raw()) }
    }

    pub fn is_undefined(self, v: JSValueRef) -> bool {
        // SAFETY: valid context and value.
        unsafe { JSValueIsUndefined(self.ctx, v) }
    }
    pub fn is_null_or_undefined(self, v: JSValueRef) -> bool {
        // SAFETY: valid context and value.
        unsafe { JSValueIsUndefined(self.ctx, v) || JSValueIsNull(self.ctx, v) }
    }
    pub fn is_string(self, v: JSValueRef) -> bool {
        // SAFETY: valid context and value.
        unsafe { JSValueIsString(self.ctx, v) }
    }

    pub fn to_bool(self, v: JSValueRef) -> bool {
        // SAFETY: valid context and value.
        unsafe { JSValueToBoolean(self.ctx, v) }
    }
    pub fn to_number(self, v: JSValueRef) -> JsResult<f64> {
        let mut exc = ptr::null();
        // SAFETY: valid context and value.
        let n = unsafe { JSValueToNumber(self.ctx, v, &mut exc) };
        self.check(exc, n)
    }
    pub fn to_string(self, v: JSValueRef) -> JsResult<String> {
        let mut exc = ptr::null();
        // SAFETY: valid context and value.
        let s = unsafe { JSValueToStringCopy(self.ctx, v, &mut exc) };
        self.check(exc, ())?;
        Ok(JsString(s).to_rust())
    }
    pub fn to_object(self, v: JSValueRef) -> JsResult<JSObjectRef> {
        let mut exc = ptr::null();
        // SAFETY: valid context and value.
        let o = unsafe { JSValueToObject(self.ctx, v, &mut exc) };
        self.check(exc, o)
    }

    /// A new `Uint8Array` that owns `bytes`.
    pub fn uint8_array(self, bytes: Vec<u8>) -> JSValueRef {
        unsafe extern "C" fn free_bytes(_bytes: *mut c_void, context: *mut c_void) {
            // SAFETY: context is the Box<Vec<u8>> leaked below.
            drop(unsafe { Box::from_raw(context.cast::<Vec<u8>>()) });
        }
        if bytes.is_empty() {
            // SAFETY: valid context; zero-length array.
            return unsafe { JSObjectMakeTypedArray(self.ctx, kJSTypedArrayTypeUint8Array, 0, ptr::null_mut()) };
        }
        let mut boxed = Box::new(bytes);
        let data = boxed.as_mut_ptr().cast::<c_void>();
        let len = boxed.len();
        let context = Box::into_raw(boxed).cast::<c_void>();
        // SAFETY: data stays valid until JSC calls free_bytes(context).
        unsafe { JSObjectMakeTypedArrayWithBytesNoCopy(self.ctx, kJSTypedArrayTypeUint8Array, data, len, free_bytes, context, ptr::null_mut()) }
    }

    /// The bytes of a typed array, DataView-less ArrayBuffer or nothing.
    pub fn bytes(self, v: JSValueRef) -> Option<Vec<u8>> {
        // SAFETY: valid context and value; the pointer is read before any JS runs.
        unsafe {
            let kind = JSValueGetTypedArrayType(self.ctx, v, ptr::null_mut());
            if kind == kJSTypedArrayTypeNone {
                return None;
            }
            let obj = JSValueToObject(self.ctx, v, ptr::null_mut());
            let (p, len, offset) = if kind == kJSTypedArrayTypeArrayBuffer {
                (JSObjectGetArrayBufferBytesPtr(self.ctx, obj, ptr::null_mut()), JSObjectGetArrayBufferByteLength(self.ctx, obj, ptr::null_mut()), 0)
            } else {
                (
                    JSObjectGetTypedArrayBytesPtr(self.ctx, obj, ptr::null_mut()),
                    JSObjectGetTypedArrayByteLength(self.ctx, obj, ptr::null_mut()),
                    JSObjectGetTypedArrayByteOffset(self.ctx, obj, ptr::null_mut()),
                )
            };
            if len == 0 || p.is_null() {
                return Some(Vec::new());
            }
            // JSC returns the backing buffer pointer, so views need their byte offset.
            Some(core::slice::from_raw_parts(p.cast::<u8>().add(offset), len).to_vec())
        }
    }

    pub fn error(self, message: &str) -> JSValueRef {
        let msg = self.string(message);
        // SAFETY: valid context; one string argument.
        unsafe { JSObjectMakeError(self.ctx, 1, &msg, ptr::null_mut()) }
    }

    pub fn thrown_value(self, t: Thrown) -> JSValueRef {
        match t {
            Thrown::Value(v) => v,
            Thrown::Message(m) => self.error(&m),
        }
    }

    pub fn protect(self, v: JSValueRef) {
        // SAFETY: valid context and value.
        unsafe { JSValueProtect(self.ctx, v) }
    }

    /// Holds the VM lock from now on, so microtasks run only at [`Js::drain_microtasks`].
    pub fn enter(self) {
        // SAFETY: valid context.
        unsafe { bunjsc_enter(self.ctx) }
    }

    /// Runs pending promise jobs; returns whether there were any.
    pub fn drain_microtasks(self) -> bool {
        // SAFETY: valid context.
        unsafe { bunjsc_drain_microtasks(self.ctx) }
    }

    pub fn promise_state(self, v: JSValueRef) -> i32 {
        // SAFETY: valid context and value.
        unsafe { bunjsc_promise_state(self.ctx, v) }
    }
    pub fn promise_result(self, v: JSValueRef) -> JSValueRef {
        // SAFETY: valid context and value.
        unsafe { bunjsc_promise_result(self.ctx, v) }
    }
    pub fn proxy_target(self, v: JSValueRef) -> Option<JSValueRef> {
        // SAFETY: valid context and value.
        let t = unsafe { bunjsc_proxy_target(self.ctx, v) };
        (!t.is_null()).then_some(t)
    }

    pub fn set_unhandled_rejection_callback(self, f: JSObjectRef) {
        // SAFETY: the context was created by JSGlobalContextCreate.
        unsafe { JSGlobalContextSetUnhandledRejectionCallback(self.ctx as JSGlobalContextRef, f, ptr::null_mut()) }
    }
}

/// Defines a C API callback from a Rust body `|js, args| -> JsResult<JSValueRef>`.
#[macro_export]
macro_rules! native {
    ($name:ident, |$js:ident, $args:ident| $body:expr) => {
        unsafe extern "C" fn $name(
            ctx: $crate::sys::JSContextRef,
            _function: $crate::sys::JSObjectRef,
            _this: $crate::sys::JSObjectRef,
            argc: usize,
            argv: *const $crate::sys::JSValueRef,
            exception: *mut $crate::sys::JSValueRef,
        ) -> $crate::sys::JSValueRef {
            let $js = $crate::Js { ctx };
            // SAFETY: JSC passes argc valid values.
            let $args: &[$crate::sys::JSValueRef] = if argc == 0 { &[] } else { unsafe { core::slice::from_raw_parts(argv, argc) } };
            let result: $crate::JsResult<$crate::sys::JSValueRef> = (|| $body)();
            match result {
                Ok(v) => v,
                Err(t) => {
                    // SAFETY: exception is JSC's out-parameter.
                    unsafe { *exception = $js.thrown_value(t) };
                    core::ptr::null()
                }
            }
        }
    };
}
