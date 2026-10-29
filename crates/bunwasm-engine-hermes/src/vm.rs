//! [`Engine`] on the Hermes VM (crates/bunwasm-hermes: hermes/build.sh's VM behind
//! cpp/shim.cpp). See docs/hermes-engine.md.
//!
//! Values are [`HVal`]s, shim handles that are GC roots while they exist. Raw Hermes values
//! never leave the shim, and none cross into the core.
//!
//! Promises are Hermes's own JS implementation (lib/InternalJavaScript/01-Promise.js): state
//! `_y` (0 pending, 1 fulfilled, 2 rejected, 3 adopted `_z`), value `_z`, and the static
//! `Promise._C(promise, reason)` / `Promise._B(promise)` hooks it calls on rejection and on
//! every handler it attaches, which feed [`Engine::take_unhandled_rejections`]. Our patch to
//! that file (docs/bun-patches/hermes-async-context.md) adds `Promise._G`/`_S` (the async
//! context carried across reactions) and `_T` (an internal `then`); they are captured here
//! once and deleted before any user code runs.
//!
//! Hermes runs classic scripts only. Until the record loader lands (design section 3),
//! `eval_module` runs module-free `bun -e` code as a script and `import_module` throws.

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::ffi::c_char;
use std::io::Write;
use std::rc::Rc;

use bunwasm_hermes::{self as sys, Handle, kind};

use crate::engine::{
    Engine, ErrorKind, ModuleHost, NativeError, PromiseState, Record, Val, ValueFn,
};

thread_local! {
    static NATIVES: RefCell<HashMap<u32, ValueFn<Hermes>>> = RefCell::new(HashMap::new());
    static NEXT_NATIVE: Cell<u32> = const { Cell::new(1) };
    /// Natives whose function objects were collected; dropped outside the GC. Its capacity
    /// always covers every live native, so the GC-time push never allocates.
    static DEAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static HOST: RefCell<Option<Rc<dyn ModuleHost<Hermes>>>> = const { RefCell::new(None) };
    static REJECTIONS: RefCell<Vec<(HVal, HVal)>> = const { RefCell::new(Vec::new()) };
    static INTRINSICS: OnceCell<Intrinsics> = const { OnceCell::new() };
    /// Attached `WebAssembly.Memory` buffers, until `detach_wasm_memory_buffer`.
    static WASM_BUFFERS: RefCell<Vec<HVal>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "C" {
    // The core's stack bounds (one shared stack), imported through GOT.mem.
    static __stack_low: u8;
    static __stack_high: u8;
    static mut errno: i32;
}

/// Built-ins captured at startup, before user code can replace them.
struct Intrinsics {
    promise: HVal,
    promise_resolve: HVal,
    promise_reject: HVal,
    object_keys: HVal,
    define_property: HVal,
    reflect_own_keys: HVal,
    /// `Promise._T(promise, onFulfilled, onRejected)`: `then` without `constructor`/species.
    then_internal: HVal,
    /// `Promise._G()` / `Promise._S(frame)`: the current async context.
    context_get: HVal,
    context_set: HVal,
}

fn intrinsic(f: impl FnOnce(&Intrinsics) -> &HVal) -> HVal {
    INTRINSICS.with(|i| f(i.get().expect("Hermes engine initialized")).clone())
}

/// A rooted Hermes value.
pub struct HVal(Handle);

impl HVal {
    fn raw(&self) -> Handle {
        self.0
    }
    /// Give the handle's reference to the shim.
    fn into_raw(self) -> Handle {
        let h = self.0;
        std::mem::forget(self);
        h
    }
    fn kind(&self) -> i32 {
        // SAFETY: a live handle.
        unsafe { sys::bh_kind(self.0) }
    }
    fn is_object(&self) -> bool {
        matches!(
            self.kind(),
            kind::OBJECT
                | kind::FUNCTION
                | kind::ARRAY
                | kind::UINT8ARRAY
                | kind::ARRAYBUFFER
                | kind::TYPED_ARRAY
                | kind::DATA_VIEW
        )
    }
}

impl Clone for HVal {
    fn clone(&self) -> HVal {
        // SAFETY: a live handle.
        HVal(unsafe { sys::bh_dup(self.0) })
    }
}

impl Drop for HVal {
    fn drop(&mut self) {
        // SAFETY: we own one reference.
        unsafe { sys::bh_release(self.0) }
    }
}

/// Wrap a shim call's out-parameter: the result, or the thrown value.
fn checked(ok: bool, out: Handle) -> Result<HVal, HVal> {
    if ok { Ok(HVal(out)) } else { Err(HVal(out)) }
}

/// Like [`checked`] for calls whose success has no value.
fn checked_unit(ok: bool, out: Handle) -> Result<(), HVal> {
    if ok { Ok(()) } else { Err(HVal(out)) }
}

fn string(s: &str) -> HVal {
    // SAFETY: a valid UTF-8 buffer.
    HVal(unsafe { sys::bh_string(s.as_ptr().cast::<c_char>(), s.len()) })
}

fn global() -> HVal {
    // SAFETY: plain constructor.
    HVal(unsafe { sys::bh_global() })
}

fn get(obj: &HVal, key: &str) -> Result<HVal, HVal> {
    let mut out = 0;
    // SAFETY: valid handle and key buffer.
    let ok = unsafe {
        sys::bh_get(
            obj.raw(),
            key.as_ptr().cast::<c_char>(),
            key.len(),
            &mut out,
        )
    };
    checked(ok, out)
}

fn set(obj: &HVal, key: &str, value: &HVal) -> Result<(), HVal> {
    let mut out = 0;
    // SAFETY: valid handles and key buffer.
    let ok = unsafe {
        sys::bh_set(
            obj.raw(),
            key.as_ptr().cast::<c_char>(),
            key.len(),
            value.raw(),
            &mut out,
        )
    };
    checked_unit(ok, out)
}

fn call(f: &HVal, this: &HVal, args: &[HVal]) -> Result<HVal, HVal> {
    let raw: Vec<Handle> = args.iter().map(HVal::raw).collect();
    let mut out = 0;
    // SAFETY: valid handles; `args` keeps them alive.
    let ok = unsafe { sys::bh_call(f.raw(), this.raw(), raw.as_ptr(), raw.len(), &mut out) };
    checked(ok, out)
}

fn construct(f: &HVal, args: &[HVal]) -> Result<HVal, HVal> {
    let raw: Vec<Handle> = args.iter().map(HVal::raw).collect();
    let mut out = 0;
    // SAFETY: as in `call`.
    let ok = unsafe { sys::bh_construct(f.raw(), raw.as_ptr(), raw.len(), &mut out) };
    checked(ok, out)
}

fn undefined() -> HVal {
    // SAFETY: plain constructor.
    HVal(unsafe { sys::bh_undefined() })
}

fn to_string(v: &HVal) -> String {
    let mut len = 0;
    let mut ascii = false;
    // SAFETY: a string handle; the data is copied before any VM call.
    unsafe {
        let data = sys::bh_string_data(v.raw(), &mut len, &mut ascii);
        if len == 0 {
            return String::new();
        }
        if ascii {
            let bytes = std::slice::from_raw_parts(data.cast::<u8>(), len);
            return String::from_utf8_lossy(bytes).into_owned();
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(data.cast::<u16>(), len))
    }
}

/// The bytes of an ArrayBuffer or of any view of one (its byteOffset/byteLength window).
fn bytes(v: &HVal) -> Vec<u8> {
    let mut len = 0;
    // SAFETY: a buffer or view handle; copied at once.
    unsafe {
        let data = sys::bh_bytes(v.raw(), &mut len);
        if data.is_null() {
            return Vec::new();
        }
        std::slice::from_raw_parts(data, len).to_vec()
    }
}

fn object_keys(obj: &HVal) -> Vec<String> {
    let keys = intrinsic(|i| &i.object_keys);
    let Ok(list) = call(&keys, &undefined(), std::slice::from_ref(obj)) else {
        return Vec::new();
    };
    array_items(&list)
        .iter()
        .filter(|k| k.kind() == kind::STRING)
        .map(to_string)
        .collect()
}

fn array_items(arr: &HVal) -> Vec<HVal> {
    let Ok(Val::Num(len)) = get(arr, "length").map(|l| to_val(&l)) else {
        return Vec::new();
    };
    (0..len as u32)
        .map(|i| {
            let mut out = 0;
            // SAFETY: a valid object handle.
            let ok = unsafe { sys::bh_get_index(arr.raw(), i, &mut out) };
            checked(ok, out).unwrap_or_else(|_| undefined())
        })
        .collect()
}

fn new_array(items: &[HVal]) -> HVal {
    // SAFETY: plain constructor.
    let arr = HVal(unsafe { sys::bh_array(items.len() as u32) });
    for (i, item) in items.iter().enumerate() {
        let mut out = 0;
        // SAFETY: a fresh array: setting an index cannot throw.
        unsafe { sys::bh_set_index(arr.raw(), i as u32, item.raw(), &mut out) };
    }
    arr
}

fn to_val(v: &HVal) -> Val {
    // SAFETY (all arms): `v` is a live handle of the matching kind.
    match v.kind() {
        kind::NULL => Val::Null,
        kind::BOOL => Val::Bool(unsafe { sys::bh_get_bool(v.raw()) }),
        kind::NUMBER => Val::Num(unsafe { sys::bh_get_number(v.raw()) }),
        kind::STRING => Val::Str(to_string(v)),
        kind::BIGINT => {
            let mut n = 0;
            let lossless = unsafe { sys::bh_get_bigint(v.raw(), &mut n) };
            if lossless {
                Val::BigInt(n)
            } else {
                Val::Undefined
            }
        }
        kind::UINT8ARRAY | kind::ARRAYBUFFER | kind::TYPED_ARRAY | kind::DATA_VIEW => {
            Val::Bytes(bytes(v))
        }
        kind::ARRAY => Val::Array(array_items(v).iter().map(to_val).collect()),
        kind::OBJECT => Val::Object(
            object_keys(v)
                .into_iter()
                .map(|k| {
                    let item = get(v, &k).map(|i| to_val(&i)).unwrap_or(Val::Undefined);
                    (k, item)
                })
                .collect(),
        ),
        _ => Val::Undefined,
    }
}

fn value_from(v: Val) -> HVal {
    // SAFETY (all arms): plain constructors over valid buffers.
    match v {
        Val::Undefined => undefined(),
        Val::Null => HVal(unsafe { sys::bh_null() }),
        Val::Bool(b) => HVal(unsafe { sys::bh_bool(b) }),
        Val::Num(n) => HVal(unsafe { sys::bh_number(n) }),
        Val::BigInt(n) => HVal(unsafe { sys::bh_bigint(n, false) }),
        Val::BigUint(n) => HVal(unsafe { sys::bh_bigint(n as i64, true) }),
        Val::Str(s) => string(&s),
        Val::Bytes(b) => HVal(unsafe { sys::bh_uint8array(b.as_ptr(), b.len()) }),
        Val::Array(items) => {
            let items: Vec<HVal> = items.into_iter().map(value_from).collect();
            new_array(&items)
        }
        Val::Object(fields) => {
            let obj = HVal(unsafe { sys::bh_object() });
            for (k, item) in fields {
                let _ = set(&obj, &k, &value_from(item));
            }
            obj
        }
    }
}

/// `Object.defineProperty(obj, key, { value, writable, configurable })`: a non-enumerable
/// own property, like `name` on built-in errors.
fn define_hidden(obj: &HVal, key: &str, value: HVal) {
    let descriptor = value_from(Val::Object(vec![
        ("writable".into(), Val::Bool(true)),
        ("configurable".into(), Val::Bool(true)),
    ]));
    let _ = set(&descriptor, "value", &value);
    let define = intrinsic(|i| &i.define_property);
    let _ = call(
        &define,
        &undefined(),
        &[obj.clone(), string(key), descriptor],
    );
}

/// Every native function: the shim passes owned handles for `this` and the arguments and
/// takes ownership of `*out`.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_call(
    id: u32,
    this: Handle,
    args: *const Handle,
    count: usize,
    out: *mut Handle,
) -> bool {
    drop(HVal(this));
    // SAFETY: the shim passes `count` handles it gave up.
    let raw: &[Handle] = if count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(args, count) }
    };
    let args: Vec<HVal> = raw.iter().map(|h| HVal(*h)).collect();
    let Some(f) = NATIVES.with(|n| n.borrow().get(&id).cloned()) else {
        // SAFETY: the shim's out-parameter.
        unsafe { *out = undefined().into_raw() };
        return true;
    };
    let (ok, value) = match f(&Hermes, &args) {
        Ok(v) => (true, v),
        Err(thrown) => (false, thrown),
    };
    // SAFETY: the shim's out-parameter.
    unsafe { *out = value.into_raw() };
    ok
}

/// A native's function object was collected. Runs inside the GC: it only records the id, in
/// capacity reserved by `new_function`, so it neither allocates nor enters JS.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_drop(id: u32) {
    DEAD.with(|d| {
        let mut dead = d.borrow_mut();
        // Reserved capacity covers every native; past it the closure is leaked, not freed here.
        if dead.len() < dead.capacity() {
            dead.push(id);
        }
    });
}

/// Cancellation poll at async-break checkpoints. Never enters JS.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_interrupt() -> bool {
    HOST.with(|h| h.borrow().as_ref().is_some_and(|host| host.interrupt()))
}

/// An unrecoverable VM error (heap exhaustion, an internal invariant): report and exit 134.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_fatal(message: *const c_char, len: usize) -> ! {
    // SAFETY: the shim passes a valid buffer; nothing here allocates.
    let message = unsafe { std::slice::from_raw_parts(message.cast::<u8>(), len) };
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(b"bun-wasm: Hermes fatal error: ");
    let _ = stderr.write_all(message);
    let _ = stderr.write_all(b"\n");
    // SAFETY: the core's exit never returns.
    unsafe { crate::transport::bun_core_exit(134) }
}

/// The core alone moves the heap break. llvh's `Process::GetMallocUsage` asks `sbrk(0)` for an
/// estimate; refusing every call keeps the side from importing the core's `sbrk`.
#[unsafe(no_mangle)]
extern "C" fn sbrk(_increment: isize) -> *mut u8 {
    const ENOMEM: i32 = 48;
    // SAFETY: the core's errno, imported through GOT.mem; single-threaded.
    unsafe { errno = ENOMEM };
    usize::MAX as *mut u8
}

fn drop_dead_natives() {
    // Drain (keeping the reserved capacity); no VM call while DEAD is borrowed.
    let dead: Vec<u32> = DEAD.with(|d| d.borrow_mut().drain(..).collect());
    if dead.is_empty() {
        return;
    }
    let removed: Vec<_> = NATIVES.with(|n| {
        let mut natives = n.borrow_mut();
        dead.iter().filter_map(|id| natives.remove(id)).collect()
    });
    // Closures (and the values they hold) drop here, outside the GC.
    drop(removed);
}

/// Keep `DEAD`'s capacity at least the number of live natives.
fn reserve_dead() {
    let live = NATIVES.with(|n| n.borrow().len());
    DEAD.with(|d| {
        let mut dead = d.borrow_mut();
        let additional = live.saturating_sub(dead.len());
        dead.reserve(additional);
    });
}

/// Hermes has no line offset for scripts: move the first `1 - first_line` line breaks onto
/// line 1 (the CommonJS wrapper's header lines), so the code after them keeps its lines.
fn fold_header_lines(source: &str, first_line: i32) -> std::borrow::Cow<'_, str> {
    if first_line >= 1 {
        return source.into();
    }
    let mut folded = String::with_capacity(source.len());
    let mut remaining = (1 - first_line) as usize;
    for c in source.chars() {
        if c == '\n' && remaining > 0 {
            remaining -= 1;
            folded.push(' ');
            continue;
        }
        folded.push(c);
    }
    folded.into()
}

/// The settled promise behind `v`, following adoption (`_y === 3`), if `v` is a promise.
fn promise_core(v: &HVal) -> Option<HVal> {
    let promise = intrinsic(|i| &i.promise);
    // SAFETY: valid handles.
    if !v.is_object() || !unsafe { sys::bh_instance_of(v.raw(), promise.raw()) } {
        return None;
    }
    let mut p = v.clone();
    for _ in 0..1024 {
        let state = get(&p, "_y").ok().map(|s| to_val(&s));
        if state != Some(Val::Num(3.0)) {
            return Some(p);
        }
        p = get(&p, "_z").ok()?;
    }
    Some(p)
}

fn track_rejection(_: &Hermes, args: &[HVal]) -> Result<HVal, HVal> {
    let promise = args.first().cloned().unwrap_or_else(undefined);
    let handled = get(&promise, "_x").ok().map(|x| to_val(&x));
    if handled == Some(Val::Num(0.0)) {
        let reason = args.get(1).cloned().unwrap_or_else(undefined);
        REJECTIONS.with(|r| r.borrow_mut().push((promise, reason)));
    }
    Ok(undefined())
}

fn track_handler(_: &Hermes, args: &[HVal]) -> Result<HVal, HVal> {
    let Some(promise) = args.first() else {
        return Ok(undefined());
    };
    REJECTIONS.with(|r| {
        // SAFETY: valid handles.
        r.borrow_mut()
            .retain(|(p, _)| !unsafe { sys::bh_strict_equals(p.raw(), promise.raw()) })
    });
    Ok(undefined())
}

/// Read and remove one of the patch's private Promise hooks.
fn take_hook(promise: &HVal, delete: &HVal, key: &str) -> HVal {
    let hook = get(promise, key).unwrap_or_else(|_| undefined());
    assert_eq!(
        hook.kind(),
        kind::FUNCTION,
        "Hermes VM lacks Promise.{key}: build it with hermes/hermes-wasi.patch"
    );
    let _ = call(delete, &undefined(), &[promise.clone(), string(key)]);
    hook
}

fn capture_intrinsics() -> Intrinsics {
    let g = global();
    let lookup = |obj: &HVal, key: &str| get(obj, key).unwrap_or_else(|_| undefined());
    let promise = lookup(&g, "Promise");
    let object = lookup(&g, "Object");
    let reflect = lookup(&g, "Reflect");
    let delete = lookup(&reflect, "deleteProperty");
    Intrinsics {
        promise_resolve: lookup(&promise, "resolve"),
        promise_reject: lookup(&promise, "reject"),
        object_keys: lookup(&object, "keys"),
        define_property: lookup(&object, "defineProperty"),
        reflect_own_keys: lookup(&reflect, "ownKeys"),
        then_internal: take_hook(&promise, &delete, "_T"),
        context_get: take_hook(&promise, &delete, "_G"),
        context_set: take_hook(&promise, &delete, "_S"),
        promise,
    }
}

/// Fields of Hermes's JS Promise implementation, hidden from console output.
const PROMISE_FIELDS: [&str; 5] = ["_x", "_y", "_z", "_A", "_E"];

/// `Reflect.ownKeys(promise)` without the implementation's fields.
fn promise_public_keys(promise: &HVal) -> HVal {
    let own_keys = intrinsic(|i| &i.reflect_own_keys);
    let all = call(&own_keys, &undefined(), std::slice::from_ref(promise))
        .map(|keys| array_items(&keys))
        .unwrap_or_default();
    let public: Vec<HVal> = all
        .into_iter()
        .filter(|k| k.kind() != kind::STRING || !PROMISE_FIELDS.contains(&to_string(k).as_str()))
        .collect();
    new_array(&public)
}

/// `BUN_WASM_HERMES_OPT`: `none` (default) compiles every script unoptimized, `user` optimizes
/// all but the runtime's own `bun-wasm:` sources, `all` optimizes everything.
fn eval_flags(source: &str, filename: &str) -> u32 {
    thread_local! {
        static MODE: String = std::env::var("BUN_WASM_HERMES_OPT").unwrap_or_default();
    }
    let optimize = MODE.with(|mode| match mode.as_str() {
        "all" => true,
        "user" => !filename.starts_with("bun-wasm:"),
        _ => false,
    });
    let mut flags = 0;
    if optimize {
        flags |= sys::EVAL_OPTIMIZE;
    }
    // Large sources compile functions on first call.
    if source.len() > 64 * 1024 {
        flags |= sys::EVAL_LAZY;
    }
    flags
}

/// Hermes's GC heap cap (`BUN_WASM_HERMES_MAX_HEAP_MIB`, default 384). The 512 MiB linear
/// memory also holds the compiler, malloc and the core.
fn max_heap_mib() -> u32 {
    std::env::var("BUN_WASM_HERMES_MAX_HEAP_MIB")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&mib| mib > 0)
        .unwrap_or(384)
}

fn wasm_capacity() -> Val {
    #[cfg(target_arch = "wasm32")]
    {
        Val::Num((core::arch::wasm32::memory_size(0) * 65536) as f64)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Val::Null
    }
}

/// Hermes. A unit handle: the runtime is a thread-local in the shim (one per process).
#[derive(Clone, Copy)]
pub struct Hermes;

impl Engine for Hermes {
    type Value = HVal;

    fn new(host: Rc<dyn ModuleHost<Hermes>>) -> Hermes {
        let config = sys::Config {
            init_heap_mib: 2,
            max_heap_mib: max_heap_mib(),
            interruptible: host.has_interrupt_handler(),
            stack_low: (&raw const __stack_low) as usize,
            stack_high: (&raw const __stack_high) as usize,
        };
        // SAFETY: called once, before any other shim call.
        unsafe { sys::bh_init(&config) };
        HOST.with(|h| *h.borrow_mut() = Some(host));
        INTRINSICS.with(|i| {
            assert!(i.set(capture_intrinsics()).is_ok(), "one Hermes engine");
        });
        let promise = intrinsic(|i| &i.promise);
        let rejection = Hermes.new_function("trackRejection", Rc::new(track_rejection));
        let handler = Hermes.new_function("trackHandler", Rc::new(track_handler));
        assert!(set(&promise, "_C", &rejection).is_ok() && set(&promise, "_B", &handler).is_ok());
        Hermes
    }

    fn name(&self) -> &'static str {
        "hermes"
    }

    fn undefined(&self) -> HVal {
        undefined()
    }

    fn is_undefined(&self, v: &HVal) -> bool {
        v.kind() == kind::UNDEFINED
    }

    fn to_val(&self, v: &HVal) -> Val {
        to_val(v)
    }

    fn value_from(&self, v: Val) -> HVal {
        value_from(v)
    }

    fn new_object(&self) -> HVal {
        // SAFETY: plain constructor.
        HVal(unsafe { sys::bh_object() })
    }

    fn get(&self, obj: &HVal, key: &str) -> Result<HVal, HVal> {
        get(obj, key)
    }

    fn set(&self, obj: &HVal, key: &str, value: HVal) -> Result<(), HVal> {
        set(obj, key, &value)
    }

    fn keys(&self, obj: &HVal) -> Vec<String> {
        if !obj.is_object() {
            return Vec::new();
        }
        object_keys(obj)
    }

    fn error_value(&self, err: &NativeError) -> HVal {
        let ctor = match err.kind {
            ErrorKind::Error => "Error",
            ErrorKind::TypeError => "TypeError",
            ErrorKind::RangeError => "RangeError",
            ErrorKind::SyntaxError => "SyntaxError",
        };
        let Ok(f) = get(&global(), ctor) else {
            return undefined();
        };
        let Ok(e) = construct(&f, &[string(&err.message)]) else {
            return undefined();
        };
        for (k, v) in &err.props {
            if k == "name" {
                define_hidden(&e, k, value_from(v.clone()));
                continue;
            }
            let _ = set(&e, k, &value_from(v.clone()));
        }
        if let Some(n) = &err.name {
            define_hidden(&e, "name", string(n));
        }
        e
    }

    fn new_function(&self, name: &str, f: ValueFn<Self>) -> HVal {
        let id = NEXT_NATIVE.with(|n| {
            let id = n.get();
            n.set(id + 1);
            id
        });
        NATIVES.with(|m| m.borrow_mut().insert(id, f));
        reserve_dead();
        // SAFETY: a valid name buffer; `id` is registered above.
        HVal(unsafe { sys::bh_function(name.as_ptr().cast::<c_char>(), name.len(), id) })
    }

    fn call(&self, f: &HVal, this: &HVal, args: &[HVal]) -> Result<HVal, HVal> {
        call(f, this, args)
    }

    fn eval_script(&self, source: &str, filename: &str, first_line: i32) -> Result<HVal, HVal> {
        let source = fold_header_lines(source, first_line);
        let flags = eval_flags(&source, filename);
        let mut out = 0;
        // SAFETY: valid buffers.
        let ok = unsafe {
            sys::bh_eval(
                source.as_ptr().cast::<c_char>(),
                source.len(),
                filename.as_ptr().cast::<c_char>(),
                filename.len(),
                flags,
                &mut out,
            )
        };
        checked(ok, out)
    }

    fn import_module(&self, specifier: &str) -> Result<HVal, HVal> {
        Err(self.error_value(&NativeError::error(format!(
            "Cannot import \"{specifier}\": ES modules on Hermes need the record loader"
        ))))
    }

    fn eval_module(&self, name: &str, source: &str) -> Result<HVal, HVal> {
        // Module-free `bun -e` code runs as a script until the record loader lands.
        let promise = intrinsic(|i| &i.promise);
        match self.eval_script(source, name, 1) {
            Ok(_) => call(&intrinsic(|i| &i.promise_resolve), &promise, &[undefined()]),
            Err(thrown) => call(&intrinsic(|i| &i.promise_reject), &promise, &[thrown]),
        }
    }

    fn run_jobs(&self) -> bool {
        drop_dead_natives();
        // SAFETY: plain query.
        if !unsafe { sys::bh_has_jobs() } {
            return false;
        }
        let mut out = 0;
        // SAFETY: valid out-parameter.
        let ok = unsafe { sys::bh_drain_jobs(&mut out) };
        if !ok {
            // queueMicrotask callbacks report their own errors; a job's throw is dropped.
            drop(HVal(out));
        }
        true
    }

    fn promise_state(&self, v: &HVal) -> Option<PromiseState> {
        let core = promise_core(v)?;
        Some(match get(&core, "_y").map(|s| to_val(&s)) {
            Ok(Val::Num(1.0)) => PromiseState::Fulfilled,
            Ok(Val::Num(2.0)) => PromiseState::Rejected,
            _ => PromiseState::Pending,
        })
    }

    fn promise_result(&self, v: &HVal) -> HVal {
        let Some(core) = promise_core(v) else {
            return v.clone();
        };
        get(&core, "_z").unwrap_or_else(|_| undefined())
    }

    fn promise_then(
        &self,
        promise: &HVal,
        fulfilled: &HVal,
        rejected: &HVal,
    ) -> Result<HVal, HVal> {
        if promise_core(promise).is_none() {
            return Err(self.error_value(&NativeError::type_error("not a promise")));
        }
        let then = intrinsic(|i| &i.then_internal);
        call(
            &then,
            &undefined(),
            &[promise.clone(), fulfilled.clone(), rejected.clone()],
        )
    }

    fn take_unhandled_rejections(&self) -> Vec<(HVal, HVal)> {
        REJECTIONS.with(|r| r.borrow_mut().drain(..).collect())
    }

    fn same_value(&self, a: &HVal, b: &HVal) -> bool {
        // SAFETY: valid handles.
        unsafe { sys::bh_strict_equals(a.raw(), b.raw()) }
    }

    fn is_promise(&self, v: &HVal) -> bool {
        promise_core(v).is_some()
    }

    fn is_proxy(&self, v: &HVal) -> bool {
        // SAFETY: valid handle.
        unsafe { sys::bh_is_proxy(v.raw()) }
    }

    fn is_detachable_buffer(&self, v: &HVal) -> bool {
        // SAFETY: valid handle. WebAssembly.Memory buffers are external and not transferable.
        unsafe { sys::bh_is_detachable(v.raw()) && !sys::bh_is_external(v.raw()) }
    }

    fn detach_buffer(&self, v: &HVal) {
        // SAFETY: the transfer native validated every buffer before detaching any.
        unsafe { sys::bh_detach(v.raw()) }
    }

    unsafe fn wasm_memory_buffer(&self, data: *mut u8, length: usize) -> HVal {
        // SAFETY: the caller keeps the bytes valid until the buffer is detached; the shim's
        // external buffer never frees them.
        let buffer = HVal(unsafe { sys::bh_external_buffer(data, length) });
        WASM_BUFFERS.with(|b| b.borrow_mut().push(buffer.clone()));
        buffer
    }

    fn detach_wasm_memory_buffer(&self, v: &HVal) -> bool {
        let found = WASM_BUFFERS.with(|b| {
            let mut buffers = b.borrow_mut();
            let index = buffers.iter().position(|w| self.same_value(w, v))?;
            Some(buffers.swap_remove(index))
        });
        let Some(buffer) = found else {
            return false;
        };
        // SAFETY: valid handle; false only when something already detached it.
        unsafe { sys::bh_detach_external(buffer.raw()) };
        true
    }

    fn proxy_target(&self, v: &HVal) -> HVal {
        // SAFETY: valid handle.
        HVal(unsafe { sys::bh_proxy_target(v.raw()) })
    }

    fn is_error(&self, v: &HVal) -> bool {
        // SAFETY: valid handle.
        unsafe { sys::bh_is_error(v.raw()) }
    }

    fn iterator_entries(&self, _: &HVal) -> Option<HVal> {
        None
    }

    fn own_keys_in_order(&self, v: &HVal) -> Option<HVal> {
        promise_core(v)?;
        Some(promise_public_keys(v))
    }

    fn async_context(&self) -> HVal {
        call(&intrinsic(|i| &i.context_get), &undefined(), &[]).unwrap_or_else(|_| undefined())
    }

    fn set_async_context(&self, v: &HVal) {
        let _ = call(
            &intrinsic(|i| &i.context_set),
            &undefined(),
            std::slice::from_ref(v),
        );
    }

    fn gc(&self) {
        // SAFETY: plain call.
        unsafe { sys::bh_gc() }
    }

    /// Measured Hermes GC heap figures. Linear-memory capacity is reported separately as
    /// `wasmCapacity`; process RSS and a buffer census are not available (`null`). Heap
    /// exhaustion is fatal, so failed allocations come from the shared allocator's latch.
    fn memory_usage(&self) -> Val {
        let (mut used, mut size, mut external) = (0.0, 0.0, 0.0);
        // SAFETY: valid out-parameters; reads counters without collecting.
        unsafe { sys::bh_heap_info(&mut used, &mut size, &mut external) };
        Record::new()
            .set("rss", Val::Null)
            .set("heapTotal", size)
            .set("heapUsed", used)
            .set("external", external)
            .set("arrayBuffers", Val::Null)
            .set("arrayBufferCount", Val::Null)
            .set("wasmCapacity", wasm_capacity())
            .set("failedAllocation", Val::Null)
            .into()
    }
}
