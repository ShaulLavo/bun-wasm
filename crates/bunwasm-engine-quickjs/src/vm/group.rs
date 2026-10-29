//! QuickJS SharedArrayBuffers over memory-group regions (shared-group profile only).
//!
//! Every SharedArrayBuffer backing is a group region from the core's `bun_shm_*` service,
//! so its bytes have the same address in every member. QuickJS retains a backing for each
//! SharedArrayBuffer object (`sab_alloc` or `sab_dup`) and releases it in the finalizer
//! (`sab_free`). The transfer natives pin a backing for one message, route the pin to the
//! receiving process and accept it there as a new object over the same bytes.

use std::any::Any;
use std::ffi::c_void;
use std::rc::Rc;

use rquickjs::qjs;

use super::{QuickJs, V};
use crate::engine::{Engine, NativeError, Val, ValueFn};

unsafe extern "C" {
    fn bun_shm_create(len: u32) -> u32;
    fn bun_shm_retain(addr: u32) -> i32;
    fn bun_shm_release(addr: u32) -> i32;
    fn bun_shm_pin(addr: u32, out: *mut u32) -> i32;
    fn bun_shm_route(pin: u32, pid: u32) -> i32;
    fn bun_shm_unpin(pin: u32) -> i32;
    fn bun_shm_accept(pin: u32, out: *mut [u32; 2]) -> i32;
}

unsafe extern "C" fn sab_alloc(_: *mut c_void, size: qjs::size_t) -> *mut c_void {
    // wasm32: `size_t` is `u32`. 0 (refused by the group) is a null pointer: QuickJS
    // reports out of memory.
    unsafe { bun_shm_create(size) as usize as *mut c_void }
}

unsafe extern "C" fn sab_free(_: *mut c_void, ptr: *mut c_void) {
    let status = unsafe { bun_shm_release(ptr as usize as u32) };
    assert_eq!(status, 0, "release of an unknown SharedArrayBuffer backing");
}

unsafe extern "C" fn sab_dup(_: *mut c_void, ptr: *mut c_void) {
    let status = unsafe { bun_shm_retain(ptr as usize as u32) };
    assert_eq!(status, 0, "alias of an unknown SharedArrayBuffer backing");
}

/// Group-backed SharedArrayBuffers, and `Atomics.wait` on the main thread as in Node.
pub(super) fn install(runtime: *mut qjs::JSRuntime) {
    let functions = qjs::JSSharedArrayBufferFunctions {
        sab_alloc: Some(sab_alloc),
        sab_free: Some(sab_free),
        sab_dup: Some(sab_dup),
        sab_opaque: std::ptr::null_mut(),
    };
    // SAFETY: QuickJS copies the function table; the runtime is live.
    unsafe {
        qjs::JS_SetSharedArrayBufferFunctions(runtime, &functions);
        qjs::JS_SetCanBlock(runtime, true);
    }
}

fn clone_error(message: String) -> NativeError {
    NativeError::type_error(message).named("DataCloneError")
}

fn number<E: Engine>(e: &E, args: &[E::Value], index: usize) -> Result<u32, E::Value> {
    match args.get(index).map(|value| e.to_val(value)) {
        Some(Val::Num(value))
            if value >= 0.0 && value <= f64::from(u32::MAX) && value.fract() == 0.0 =>
        {
            Ok(value as u32)
        }
        _ => Err(e.error_value(&NativeError::type_error(
            "expected a 32-bit unsigned integer",
        ))),
    }
}

fn status<E: Engine>(e: &E, status: i32, what: &str) -> Result<E::Value, E::Value> {
    if status < 0 {
        return Err(e.error_value(&clone_error(format!(
            "{what} failed in the memory group (errno {})",
            -status
        ))));
    }
    Ok(e.value_from(Val::Num(f64::from(status))))
}

/// This crate runs only QuickJS; the natives are generic because the native table is.
fn quickjs<E: Engine>(e: &E) -> &QuickJs {
    (e as &dyn Any)
        .downcast_ref::<QuickJs>()
        .expect("group natives run on QuickJS")
}

fn engine_value<E: Engine>(value: V) -> E::Value {
    *(Box::new(value) as Box<dyn Any>)
        .downcast::<E::Value>()
        .expect("QuickJS value")
}

/// `shmPin(sab) -> pin`: a transit pin on the buffer's region, owned by this member.
fn pin<E: Engine>(e: &E, args: &[E::Value]) -> Result<E::Value, E::Value> {
    let q = quickjs(e);
    let Some(buffer) = args.first().map(|value| {
        (value as &dyn Any)
            .downcast_ref::<V>()
            .expect("QuickJS value")
    }) else {
        return Err(e.error_value(&clone_error("expected a SharedArrayBuffer".into())));
    };
    let mut size = 0;
    // SAFETY: borrows the value; returns its backing or throws for a non-buffer.
    let data = unsafe { qjs::JS_GetArrayBuffer(q.raw(), &mut size, buffer.as_raw()) };
    if data.is_null() {
        return Err(engine_value::<E>(q.ctx().catch()));
    }
    let mut pin = 0;
    let result = unsafe { bun_shm_pin(data as usize as u32, &mut pin) };
    if result < 0 {
        return status(e, result, "SharedArrayBuffer publication");
    }
    Ok(e.value_from(Val::Num(f64::from(pin))))
}

/// `shmAccept(pin, byteLength) -> SharedArrayBuffer` over the routed region's bytes.
fn accept<E: Engine>(e: &E, args: &[E::Value]) -> Result<E::Value, E::Value> {
    let q = quickjs(e);
    let pin = number(e, args, 0)?;
    let byte_length = number(e, args, 1)?;
    let mut out = [0; 2];
    let result = unsafe { bun_shm_accept(pin, &mut out) };
    if result < 0 {
        return status(e, result, "SharedArrayBuffer receipt");
    }
    let [addr, len] = out;
    let created = if byte_length > len {
        Err(e.error_value(&clone_error("Invalid shared backing store".into())))
    } else {
        // SAFETY: the region stays held while this object lives: QuickJS retains it via
        // `sab_dup` here and releases it in its finalizer.
        let raw = unsafe {
            qjs::JS_NewArrayBuffer(
                q.raw(),
                addr as usize as *mut u8,
                byte_length as qjs::size_t,
                0,
                None,
                std::ptr::null_mut(),
                true,
            )
        };
        q.wrap(raw)
            .map(engine_value::<E>)
            .map_err(engine_value::<E>)
    };
    // The accept's transit alias: the object now holds its own, or creation failed.
    let released = unsafe { bun_shm_release(addr) };
    assert_eq!(
        released, 0,
        "release of an accepted SharedArrayBuffer backing"
    );
    created
}

pub(crate) fn natives<E: Engine>() -> Vec<(&'static str, ValueFn<E>)> {
    vec![
        ("shmPin", Rc::new(pin::<E>) as ValueFn<E>),
        ("shmAccept", Rc::new(accept::<E>)),
        (
            "shmRoute",
            Rc::new(|e: &E, args: &[E::Value]| {
                let (pin, pid) = (number(e, args, 0)?, number(e, args, 1)?);
                status(
                    e,
                    unsafe { bun_shm_route(pin, pid) },
                    "SharedArrayBuffer routing",
                )
            }),
        ),
        (
            "shmUnpin",
            Rc::new(|e: &E, args: &[E::Value]| {
                status(
                    e,
                    unsafe { bun_shm_unpin(number(e, args, 0)?) },
                    "SharedArrayBuffer unpin",
                )
            }),
        ),
    ]
}
