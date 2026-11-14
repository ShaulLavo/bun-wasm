use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CString, c_char};
use std::io::Write;
use std::rc::Rc;

use bunwasm_spidermonkey as sys;

use crate::engine::{Engine, ErrorKind, ModuleHost, NativeError, PromiseState, Val, ValueFn};

thread_local! {
    static NATIVES: RefCell<HashMap<u32, ValueFn<SpiderMonkey>>> = RefCell::new(HashMap::new());
    static NEXT_NATIVE: Cell<u32> = const { Cell::new(1) };
    static DEAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static HOST: RefCell<Option<Rc<dyn ModuleHost<SpiderMonkey>>>> = const { RefCell::new(None) };
    static REJECTIONS: RefCell<Vec<(SmVal, SmVal)>> = const { RefCell::new(Vec::new()) };
}

#[cfg(not(bun_wasm_shared_group))]
unsafe extern "C" {
    static __stack_low: u8;
    static __stack_high: u8;
}

#[cfg(not(bun_wasm_shared_group))]
fn stack_bounds() -> (usize, usize) {
    (
        (&raw const __stack_low) as usize,
        (&raw const __stack_high) as usize,
    )
}

/// The stack every host carves for a group member: the split core's linker stack size, ending
/// on a page boundary (`STACK_BYTES` in `crates/bunwasm-host/src/linked_group.rs`).
#[cfg(bun_wasm_shared_group)]
const MEMBER_STACK_BYTES: usize = 8 << 20;
#[cfg(bun_wasm_shared_group)]
const PAGE_BYTES: usize = 65_536;

#[cfg(bun_wasm_shared_group)]
thread_local! {
    static STACK_TOP: Cell<usize> = const { Cell::new(0) };
    static REGISTER_DEPTH: Cell<usize> = const { Cell::new(0) };
    static ENTRY_DEPTH: Cell<usize> = const { Cell::new(0) };
}

/// A group side has no linker stack symbols, and the host binds the carved bounds for the core
/// only. The host calls the side's initializers itself, before the core starts, so the stack
/// pointer is still at the carved top there. `frame` is a local of that first frame: the top
/// is the page boundary just above it.
#[cfg(bun_wasm_shared_group)]
pub(crate) fn record_stack_top(frame: &[u8; 16]) {
    let address = std::hint::black_box(frame.as_ptr()) as usize;
    let top = (address & !(PAGE_BYTES - 1)) + PAGE_BYTES;
    STACK_TOP.with(|cell| cell.set(top));
    REGISTER_DEPTH.with(|cell| cell.set(top - address));
}

/// Check the engine's entry frame against the recorded stack, and keep how much of the stack
/// the core's entry frames already use.
#[cfg(bun_wasm_shared_group)]
pub(crate) fn record_stack_origin(frame: &[u8; 16]) {
    let address = std::hint::black_box(frame.as_ptr()) as usize;
    let (low, high) = stack_bounds();
    assert!(
        low < address && address < high,
        "engine entry is outside the member stack"
    );
    ENTRY_DEPTH.with(|cell| cell.set(high - address));
}

#[cfg(bun_wasm_shared_group)]
fn stack_bounds() -> (usize, usize) {
    let high = STACK_TOP.with(Cell::get);
    assert!(
        high > MEMBER_STACK_BYTES,
        "side registration recorded the member stack"
    );
    (high - MEMBER_STACK_BYTES, high)
}

/// Bytes of member stack in use at side registration and at engine entry.
#[cfg(bun_wasm_shared_group)]
fn stack_depths() -> Option<(usize, usize)> {
    Some((REGISTER_DEPTH.with(Cell::get), ENTRY_DEPTH.with(Cell::get)))
}

#[cfg(not(bun_wasm_shared_group))]
fn stack_depths() -> Option<(usize, usize)> {
    None
}

/// One line on stderr when the guest sets `BUN_WASM_SPIDERMONKEY_TRACE`: the stack bounds the
/// engine ran with and what executed. A run with no portable-baseline entry ran every poll in
/// the plain interpreter, because this library has no other execution tier.
pub(crate) fn trace_run() {
    if std::env::var_os("BUN_WASM_SPIDERMONKEY_TRACE").is_none() {
        return;
    }
    let (low, high) = stack_bounds();
    let mut polls = 0;
    let mut entries = 0;
    unsafe { sys::bsm_tier_counts(&mut polls, &mut entries) };
    let depths = stack_depths().map_or(String::new(), |(register, entry)| {
        format!(" register_depth={register} entry_depth={entry}")
    });
    let line = format!(
        "bun-wasm spidermonkey: stack_low={low:#x} stack_high={high:#x} stack_bytes={}{depths} interrupt_polls={polls} portable_baseline_entries={entries}\n",
        high - low
    );
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

#[derive(Clone, Copy)]
pub struct SpiderMonkey;

/// The engine the shared nested bridge (`nested_bridge.rs`) is compiled for.
#[cfg(bun_wasm_shared_group)]
pub(crate) type NestedEngine = SpiderMonkey;

pub struct SmVal(sys::Handle);

impl SmVal {
    fn raw(&self) -> sys::Handle {
        self.0
    }
    fn into_raw(self) -> sys::Handle {
        let raw = self.0;
        std::mem::forget(self);
        raw
    }
}

impl Clone for SmVal {
    fn clone(&self) -> Self {
        SmVal(unsafe { sys::bsm_dup(self.0) })
    }
}

impl Drop for SmVal {
    fn drop(&mut self) {
        unsafe { sys::bsm_release(self.0) }
    }
}

fn with_host<R>(f: impl FnOnce(&Rc<dyn ModuleHost<SpiderMonkey>>) -> R) -> R {
    let host = HOST
        .with(|host| host.borrow().clone())
        .expect("SpiderMonkey host installed");
    f(&host)
}

fn checked(ok: bool, out: sys::Handle) -> Result<SmVal, SmVal> {
    if out == 0 {
        terminate();
    }
    if ok { Ok(SmVal(out)) } else { Err(SmVal(out)) }
}

fn undefined() -> SmVal {
    SmVal(unsafe { sys::bsm_undefined() })
}

fn string(value: &str) -> SmVal {
    SmVal(unsafe { sys::bsm_string(value.as_ptr().cast::<c_char>(), value.len()) })
}

fn to_string(value: &SmVal) -> String {
    let mut length = 0;
    let data = unsafe { sys::bsm_string_data(value.raw(), &mut length) };
    if data.is_null() || length == 0 {
        return String::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length) };
    String::from_utf8_lossy(bytes).into_owned()
}

fn bytes(value: &SmVal) -> Vec<u8> {
    let mut length = 0;
    let data = unsafe { sys::bsm_bytes(value.raw(), &mut length) };
    if data.is_null() || length == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(data, length).to_vec() }
}

fn array_items(array: &SmVal) -> Vec<SmVal> {
    let mut result = Vec::new();
    let length = get(array, "length")
        .map(|value| match to_val(&value) {
            Val::Num(length) => length as u32,
            _ => 0,
        })
        .unwrap_or(0);
    for index in 0..length {
        let mut raw = 0;
        if unsafe { sys::bsm_array_get(array.raw(), index, &mut raw) } {
            result.push(SmVal(raw));
        }
    }
    result
}

fn get(object: &SmVal, key: &str) -> Result<SmVal, SmVal> {
    let mut out = 0;
    let ok = unsafe {
        sys::bsm_get(
            object.raw(),
            key.as_ptr().cast::<c_char>(),
            key.len(),
            &mut out,
        )
    };
    checked(ok, out)
}

fn to_val(value: &SmVal) -> Val {
    match unsafe { sys::bsm_kind(value.raw()) } {
        0 => Val::Undefined,
        1 => Val::Null,
        2 => Val::Bool(unsafe { sys::bsm_bool_value(value.raw()) != 0 }),
        3 => Val::Num(unsafe { sys::bsm_number(value.raw()) }),
        4 => Val::Str(to_string(value)),
        5 => Val::BigInt(unsafe { sys::bsm_bigint_value(value.raw()) }),
        7 => Val::Array(array_items(value).iter().map(to_val).collect()),
        9 | 10 => Val::Bytes(bytes(value)),
        6 => {
            let keys = unsafe { sys::bsm_keys(value.raw()) };
            if keys == 0 {
                return Val::Object(Vec::new());
            }
            let keys = SmVal(keys);
            Val::Object(
                array_items(&keys)
                    .into_iter()
                    .filter_map(|key| {
                        let name = to_string(&key);
                        get(value, &name).ok().map(|field| (name, to_val(&field)))
                    })
                    .collect(),
            )
        }
        _ => Val::Undefined,
    }
}

fn value_from(value: Val) -> SmVal {
    match value {
        Val::Undefined => undefined(),
        Val::Null => SmVal(unsafe { sys::bsm_null() }),
        Val::Bool(value) => SmVal(unsafe { sys::bsm_bool(value as u8) }),
        Val::Num(value) => SmVal(unsafe { sys::bsm_number_value(value) }),
        Val::BigInt(value) => SmVal(unsafe { sys::bsm_bigint(value, 0) }),
        Val::BigUint(value) => SmVal(unsafe { sys::bsm_bigint(value as i64, 1) }),
        Val::Str(value) => string(&value),
        Val::Bytes(value) => SmVal(unsafe { sys::bsm_uint8_array(value.as_ptr(), value.len()) }),
        Val::Array(values) => array_value_from(values),
        Val::Object(fields) => object_value_from(fields),
    }
}

fn array_value_from(values: Vec<Val>) -> SmVal {
    let array = SmVal(unsafe { sys::bsm_new_array(values.len()) });
    for (index, value) in values.into_iter().enumerate() {
        let item = value_from(value);
        unsafe { sys::bsm_array_set(array.raw(), index as u32, item.raw()) };
    }
    array
}

fn object_value_from(fields: Vec<(String, Val)>) -> SmVal {
    let object = SmVal(unsafe { sys::bsm_new_object() });
    for (key, value) in fields {
        set_object_value(&object, &key, value);
    }
    object
}

fn set_object_value(object: &SmVal, key: &str, value: Val) {
    let value = value_from(value);
    let mut error = 0;
    let ok = unsafe {
        sys::bsm_set(
            object.raw(),
            key.as_ptr().cast::<c_char>(),
            key.len(),
            value.raw(),
            &mut error,
        )
    };
    if !ok && error != 0 {
        unsafe { sys::bsm_release(error) }
    }
}

fn call(function: &SmVal, this: &SmVal, args: &[SmVal]) -> Result<SmVal, SmVal> {
    let raw = args.iter().map(SmVal::raw).collect::<Vec<_>>();
    let mut out = 0;
    let ok = unsafe {
        sys::bsm_call(
            function.raw(),
            this.raw(),
            raw.as_ptr(),
            raw.len(),
            &mut out,
        )
    };
    checked(ok, out)
}

fn set(object: &SmVal, key: &str, value: SmVal) -> Result<(), SmVal> {
    let mut out = 0;
    let ok = unsafe {
        sys::bsm_set(
            object.raw(),
            key.as_ptr().cast::<c_char>(),
            key.len(),
            value.raw(),
            &mut out,
        )
    };
    drop(value);
    if ok {
        return Ok(());
    }
    checked(ok, out).map(drop)
}

fn memory_counter(value: f64) -> Val {
    if value.is_nan() {
        Val::Null
    } else {
        Val::Num(value)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_call(
    id: u32,
    this: sys::Handle,
    args: *const sys::Handle,
    argc: usize,
    out: *mut sys::Handle,
) -> bool {
    let _this = SmVal(unsafe { sys::bsm_dup(this) });
    let raw = if argc == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(args, argc) }
    };
    let values = raw
        .iter()
        .map(|handle| SmVal(unsafe { sys::bsm_dup(*handle) }))
        .collect::<Vec<_>>();
    let Some(function) = NATIVES.with(|natives| natives.borrow().get(&id).cloned()) else {
        unsafe { out.write(SmVal::into_raw(undefined())) };
        return true;
    };
    match function(&SpiderMonkey, &values) {
        Ok(value) => {
            unsafe { out.write(value.into_raw()) };
            true
        }
        Err(value) => {
            unsafe { out.write(value.into_raw()) };
            false
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bunsm_host_drop(id: u32) {
    DEAD.with(|dead| {
        let mut dead = dead.borrow_mut();
        assert!(
            dead.len() < dead.capacity(),
            "native finalizer queue is reserved"
        );
        dead.push(id);
    });
}

unsafe fn string_reply(
    result: Result<String, SmVal>,
    out: *mut *mut c_char,
    out_len: *mut usize,
    exception: *mut sys::Handle,
) -> bool {
    let text = match result {
        Ok(text) => text,
        Err(error) => {
            unsafe { exception.write(error.into_raw()) };
            return false;
        }
    };
    let text = CString::new(text).expect("host text has no NUL");
    unsafe { out_len.write(text.as_bytes().len()) };
    unsafe { out.write(text.into_raw()) };
    true
}

unsafe fn host_text<'a>(bytes: *const c_char, length: usize) -> &'a str {
    let bytes = unsafe { std::slice::from_raw_parts(bytes.cast::<u8>(), length) };
    std::str::from_utf8(bytes).expect("shim text is UTF-8")
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_resolve(
    specifier: *const c_char,
    specifier_len: usize,
    referrer: *const c_char,
    referrer_len: usize,
    out: *mut *mut c_char,
    out_len: *mut usize,
    exception: *mut sys::Handle,
) -> bool {
    let specifier = unsafe { host_text(specifier, specifier_len) };
    let referrer = unsafe { host_text(referrer, referrer_len) };
    let result = with_host(|host| host.resolve(&SpiderMonkey, specifier, referrer));
    unsafe { string_reply(result, out, out_len, exception) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_load(
    name: *const c_char,
    name_len: usize,
    out: *mut *mut c_char,
    out_len: *mut usize,
    exception: *mut sys::Handle,
) -> bool {
    let name = unsafe { host_text(name, name_len) };
    let result = with_host(|host| host.load(&SpiderMonkey, name));
    unsafe { string_reply(result, out, out_len, exception) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_init_meta(
    name: *const c_char,
    name_len: usize,
    meta: sys::Handle,
    exception: *mut sys::Handle,
) -> bool {
    let name = unsafe {
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(name.cast::<u8>(), name_len))
    };
    let meta = SmVal(unsafe { sys::bsm_dup(meta) });
    match with_host(|host| host.init_meta(&SpiderMonkey, name, &meta)) {
        Ok(()) => true,
        Err(error) => {
            unsafe { exception.write(error.into_raw()) };
            false
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_interrupt() -> bool {
    with_host(|host| host.interrupt())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_rejection(
    promise: sys::Handle,
    reason: sys::Handle,
    handled: bool,
) {
    let promise = SmVal(unsafe { sys::bsm_dup(promise) });
    let reason = SmVal(unsafe { sys::bsm_dup(reason) });
    if handled {
        REJECTIONS.with(|rejections| {
            rejections
                .borrow_mut()
                .retain(|(current, _)| !same_value(current, &promise))
        });
    } else {
        REJECTIONS.with(|rejections| rejections.borrow_mut().push((promise, reason)));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_free(bytes: *mut c_char) {
    drop(unsafe { CString::from_raw(bytes) });
}

fn same_value(a: &SmVal, b: &SmVal) -> bool {
    unsafe { sys::bsm_same_value(a.raw(), b.raw()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_uncaught(value: sys::Handle) {
    let value = SmVal(unsafe { sys::bsm_dup(value) });
    with_host(|host| host.uncaught(&SpiderMonkey, &value));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunsm_host_fatal(message: *const c_char, length: usize) -> ! {
    let text = unsafe { std::slice::from_raw_parts(message.cast::<u8>(), length) };
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(b"bun-wasm: SpiderMonkey fatal error: ");
    let _ = stderr.write_all(text);
    let _ = stderr.write_all(b"\n");
    unsafe { crate::transport::bun_core_exit(134) }
}

fn terminate() -> ! {
    if !unsafe { sys::bsm_terminated() } {
        let message = b"engine failed without a pending exception";
        unsafe { bunsm_host_fatal(message.as_ptr().cast(), message.len()) }
    }
    unsafe { crate::transport::bun_core_exit(137) }
}

fn drop_dead_natives() {
    let dead = DEAD.with(|dead| dead.borrow_mut().drain(..).collect::<Vec<_>>());
    let removed = NATIVES.with(|natives| {
        let mut natives = natives.borrow_mut();
        dead.into_iter()
            .filter_map(|id| natives.remove(&id))
            .collect::<Vec<_>>()
    });
    drop(removed);
}

impl Engine for SpiderMonkey {
    type Value = SmVal;

    fn new(host: Rc<dyn ModuleHost<Self>>) -> Self {
        let (stack_low, stack_high) = stack_bounds();
        let config = sys::Config {
            stack_low,
            stack_high,
            max_gc_bytes: bunwasm_spidermonkey::max_memory_bytes(),
            tier: std::env::var("BUN_WASM_SPIDERMONKEY_TIER")
                .ok()
                .filter(|value| value == "pbl")
                .map_or(0, |_| 1),
            interruptible: u8::from(host.has_interrupt_handler()),
        };
        HOST.with(|current| *current.borrow_mut() = Some(host));
        unsafe { sys::bsm_init(&config) };
        // A validation side: `__transferFault()` and `__transferFaultWatch()`, natives of
        // their own in `cpp/transfer_fault.cpp` (see `transfer_fault.rs`).
        #[cfg(bun_wasm_transfer_fault)]
        unsafe {
            unsafe extern "C" {
                fn bsm_install_transfer_fault();
            }
            bsm_install_transfer_fault();
        }
        SpiderMonkey
    }

    fn name(&self) -> &'static str {
        "spidermonkey"
    }
    fn undefined(&self) -> SmVal {
        undefined()
    }
    fn is_undefined(&self, value: &SmVal) -> bool {
        unsafe { sys::bsm_kind(value.raw()) == 0 }
    }
    fn to_val(&self, value: &SmVal) -> Val {
        to_val(value)
    }
    fn value_from(&self, value: Val) -> SmVal {
        value_from(value)
    }
    fn new_object(&self) -> SmVal {
        SmVal(unsafe { sys::bsm_new_object() })
    }
    fn get(&self, object: &SmVal, key: &str) -> Result<SmVal, SmVal> {
        get(object, key)
    }
    fn set(&self, object: &SmVal, key: &str, value: SmVal) -> Result<(), SmVal> {
        set(object, key, value)
    }
    fn keys(&self, object: &SmVal) -> Vec<String> {
        let keys = SmVal(unsafe { sys::bsm_keys(object.raw()) });
        array_items(&keys).iter().map(to_string).collect()
    }
    fn error_value(&self, error: &NativeError) -> SmVal {
        let kind = match error.kind {
            ErrorKind::Error => 0,
            ErrorKind::TypeError => 1,
            ErrorKind::RangeError => 2,
            ErrorKind::SyntaxError => 3,
        };
        let object = SmVal(unsafe {
            sys::bsm_error(
                kind,
                error.message.as_ptr().cast::<c_char>(),
                error.message.len(),
            )
        });
        for (key, value) in &error.props {
            let _ = set(&object, key, value_from(value.clone()));
        }
        if let Some(name) = &error.name {
            let value = string(name);
            let mut out = 0;
            let ok = unsafe {
                sys::bsm_define_hidden(object.raw(), c"name".as_ptr(), 4, value.raw(), &mut out)
            };
            if !ok {
                drop(checked(ok, out));
            }
        }
        object
    }
    fn new_function(&self, name: &str, function: ValueFn<Self>) -> SmVal {
        let id = NEXT_NATIVE.with(|next| {
            let id = next.get();
            next.set(id + 1);
            id
        });
        let count = NATIVES.with(|natives| {
            let mut natives = natives.borrow_mut();
            natives.insert(id, function);
            natives.len()
        });
        DEAD.with(|dead| {
            let mut dead = dead.borrow_mut();
            let needed = count.saturating_sub(dead.len());
            dead.reserve(needed);
        });
        SmVal(unsafe { sys::bsm_function(name.as_ptr().cast::<c_char>(), name.len(), id) })
    }
    fn call(&self, function: &SmVal, this: &SmVal, args: &[SmVal]) -> Result<SmVal, SmVal> {
        call(function, this, args)
    }
    fn eval_script(&self, source: &str, filename: &str, first_line: i32) -> Result<SmVal, SmVal> {
        let filename = CString::new(filename).expect("script filename has no NUL");
        let mut out = 0;
        let ok = unsafe {
            sys::bsm_eval_script(
                source.as_ptr().cast::<c_char>(),
                source.len(),
                filename.as_ptr(),
                first_line,
                &mut out,
            )
        };
        checked(ok, out)
    }
    fn import_module(&self, specifier: &str) -> Result<SmVal, SmVal> {
        let mut out = 0;
        let ok = unsafe {
            sys::bsm_import(
                specifier.as_ptr().cast::<c_char>(),
                specifier.len(),
                &mut out,
            )
        };
        checked(ok, out)
    }
    fn require_module(&self, name: &str) -> Result<SmVal, SmVal> {
        let mut out = 0;
        // SAFETY: valid pointer and length; out is an out-parameter.
        let ok = unsafe { sys::bsm_require(name.as_ptr().cast::<c_char>(), name.len(), &mut out) };
        checked(ok, out)
    }
    fn eval_module(&self, name: &str, source: &str) -> Result<SmVal, SmVal> {
        let mut out = 0;
        let ok = unsafe {
            sys::bsm_eval_module(
                source.as_ptr().cast::<c_char>(),
                source.len(),
                name.as_ptr().cast::<c_char>(),
                name.len(),
                &mut out,
            )
        };
        checked(ok, out)
    }
    fn run_jobs(&self) -> bool {
        drop_dead_natives();
        let mut out = 0;
        let ran = unsafe { sys::bsm_drain_jobs(&mut out) };
        if out != 0 {
            with_host(|host| host.uncaught(self, &SmVal(out)));
        }
        if unsafe { sys::bsm_terminated() } {
            terminate();
        }
        drop_dead_natives();
        ran
    }
    fn promise_state(&self, value: &SmVal) -> Option<PromiseState> {
        match unsafe { sys::bsm_promise_state(value.raw()) } {
            0 => Some(PromiseState::Pending),
            1 => Some(PromiseState::Fulfilled),
            2 => Some(PromiseState::Rejected),
            _ => None,
        }
    }
    fn promise_result(&self, value: &SmVal) -> SmVal {
        SmVal(unsafe { sys::bsm_promise_result(value.raw()) })
    }
    fn promise_then(
        &self,
        promise: &SmVal,
        fulfilled: &SmVal,
        rejected: &SmVal,
    ) -> Result<SmVal, SmVal> {
        let mut out = 0;
        let ok = unsafe {
            sys::bsm_promise_then(promise.raw(), fulfilled.raw(), rejected.raw(), &mut out)
        };
        checked(ok, out)
    }
    fn take_unhandled_rejections(&self) -> Vec<(SmVal, SmVal)> {
        REJECTIONS.with(|rejections| rejections.borrow_mut().drain(..).collect())
    }
    fn same_value(&self, a: &SmVal, b: &SmVal) -> bool {
        same_value(a, b)
    }
    fn is_promise(&self, value: &SmVal) -> bool {
        self.promise_state(value).is_some()
    }
    fn is_proxy(&self, value: &SmVal) -> bool {
        unsafe { sys::bsm_is_proxy(value.raw()) }
    }
    fn is_detachable_buffer(&self, value: &SmVal) -> bool {
        unsafe { sys::bsm_is_detachable_buffer(value.raw()) }
    }
    fn detach_buffer(&self, value: &SmVal) {
        // A validation side refuses every allocation from the first detach on.
        #[cfg(bun_wasm_transfer_fault)]
        crate::transfer_fault::enter();
        unsafe { sys::bsm_detach_buffer(value.raw()) }
    }
    unsafe fn wasm_memory_buffer(&self, data: *mut u8, length: usize) -> SmVal {
        SmVal(unsafe { sys::bsm_external_buffer(data, length) })
    }
    #[cfg(bun_wasm_shared_group)]
    fn nested_execute(&self, operation: &SmVal, callback: &SmVal) -> Result<SmVal, SmVal> {
        crate::nested_bridge::execute(self, operation, callback)
    }
    #[cfg(bun_wasm_shared_group)]
    unsafe fn shared_wasm_memory_buffer(
        &self,
        data: *mut u8,
        length: usize,
    ) -> Result<SmVal, SmVal> {
        let mut out = 0;
        // SAFETY: the core validated this session's stable region and retains it
        // until the member, engine roots and host instances have all stopped.
        let ok = unsafe { sys::bsm_shared_region_buffer(data, length, &mut out) };
        checked(ok, out)
    }
    #[cfg(bun_wasm_shared_group)]
    fn shared_buffer_resource(&self, value: &SmVal) -> Option<u32> {
        unsafe extern "C" {
            fn bun_shared_buffer_resource(address: u32) -> u32;
        }
        // SAFETY: the shim checks the SharedArrayBuffer class, and the core only looks the
        // address up in its own ledger.
        let resource = unsafe {
            bun_shared_buffer_resource(sys::bsm_shared_buffer_data(value.raw()) as usize as u32)
        };
        (resource != 0).then_some(resource)
    }
    fn detach_wasm_memory_buffer(&self, value: &SmVal) -> bool {
        unsafe { sys::bsm_detach_external(value.raw()) }
    }
    fn proxy_target(&self, value: &SmVal) -> SmVal {
        let raw = unsafe { sys::bsm_proxy_target(value.raw()) };
        if raw == 0 { undefined() } else { SmVal(raw) }
    }
    fn is_error(&self, value: &SmVal) -> bool {
        unsafe { sys::bsm_is_error(value.raw()) }
    }
    fn iterator_entries(&self, _: &SmVal) -> Option<SmVal> {
        None
    }
    fn own_keys_in_order(&self, _: &SmVal) -> Option<SmVal> {
        None
    }
    fn async_context(&self) -> SmVal {
        SmVal(unsafe { sys::bsm_async_context() })
    }
    fn set_async_context(&self, value: &SmVal) {
        unsafe { sys::bsm_set_async_context(value.raw()) }
    }
    fn gc(&self) {
        unsafe { sys::bsm_gc() };
        drop_dead_natives();
    }
    fn memory_usage(&self) -> Val {
        let mut used = 0.;
        let mut total = 0.;
        let mut external = 0.;
        unsafe { sys::bsm_heap_info(&mut used, &mut total, &mut external) };
        crate::engine::Record::new()
            .set("rss", Val::Null)
            .set("heapTotal", memory_counter(total))
            .set("heapUsed", memory_counter(used))
            .set("external", memory_counter(external))
            .set("arrayBuffers", Val::Null)
            .set("wasmCapacity", crate::engine::wasm_capacity())
            .into()
    }
}
