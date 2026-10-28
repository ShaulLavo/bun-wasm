mod allocator;
mod transport;

#[global_allocator]
static ALLOCATOR: allocator::CoreAllocator = allocator::CoreAllocator;

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_link_smoke() -> i32 {
    let runtime = rquickjs::Runtime::new().expect("QuickJS runtime");
    runtime.set_max_stack_size(32 * 1024);
    runtime.set_interrupt_handler(Some(Box::new(|| unsafe {
        transport::core_checkpoint() != 0
    })));
    let context = rquickjs::Context::full(&runtime).expect("QuickJS context");
    context.with(|ctx| {
        let native = rquickjs::Function::new(ctx.clone(), |value: i32| data_echo(value))
            .expect("data native");
        ctx.globals()
            .set("coreData", native)
            .expect("install native");
        ctx.eval::<i32, _>("coreData(42)").expect("evaluate")
    })
}

unsafe extern "C" {
    fn core_stack_reenter(callback: usize, depth: u32) -> i32;
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_stack_reenter(depth: u32) -> i32 {
    let sentinel = std::hint::black_box([depth; 64]);
    let result = unsafe { core_stack_reenter(quickjs_stack_reenter as *const () as usize, depth) };
    if std::hint::black_box(sentinel)
        .iter()
        .any(|value| *value != depth)
    {
        return -2000;
    }
    result + 1
}

/// # Safety
/// `bytes` must be nonzero and, with `align`, satisfy
/// `Layout::from_size_align`. A non-null returned pointer is valid for `bytes`
/// bytes until it is freed or reallocated with the same layout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn quickjs_rust_alloc(bytes: usize, align: usize) -> *mut u8 {
    let Ok(layout) = std::alloc::Layout::from_size_align(bytes, align) else {
        return std::ptr::null_mut();
    };
    unsafe { std::alloc::alloc(layout) }
}

/// # Safety
/// `ptr` must be a live allocation from this module's Rust global allocator,
/// and `bytes` and `align` must be its original layout. It must not be used
/// after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn quickjs_rust_free(ptr: *mut u8, bytes: usize, align: usize) {
    let layout = std::alloc::Layout::from_size_align(bytes, align).expect("original layout");
    unsafe { std::alloc::dealloc(ptr, layout) };
}

/// # Safety
/// `ptr` must be a live allocation from this module's Rust global allocator,
/// and `bytes` and `align` must be its original layout. `next` must be nonzero
/// and valid for a layout with the same alignment. On success, the old pointer
/// is invalid and the returned pointer is valid for `next` bytes. On failure,
/// the original allocation remains owned by the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn quickjs_rust_realloc(
    ptr: *mut u8,
    bytes: usize,
    align: usize,
    next: usize,
) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(bytes, align).expect("original layout");
    unsafe { std::alloc::realloc(ptr, layout, next) }
}

fn data_echo(value: i32) -> i32 {
    let request = transport::TransportBuffer::new(14);
    let frame = transport::TransportBuffer::new(24);
    let mut bytes = [0u8; 14];
    bytes[0] = 7;
    bytes[1..5].copy_from_slice(&1u32.to_le_bytes());
    bytes[5] = 4;
    bytes[6..14].copy_from_slice(&f64::from(value).to_le_bytes());
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), request.pointer as *mut u8, bytes.len())
    };
    let words = [65_536u32, 1, request.pointer, request.bytes, 0, 0];
    unsafe {
        std::ptr::copy_nonoverlapping(words.as_ptr(), frame.pointer as *mut u32, words.len())
    };
    assert_eq!(
        unsafe { transport::bun_core_dispatch(frame.pointer) },
        0,
        "dispatch"
    );
    let reply_pointer = unsafe { (frame.pointer as *const u32).add(4).read() };
    let reply_bytes = unsafe { (frame.pointer as *const u32).add(5).read() };
    let reply = transport::TransportBuffer {
        pointer: reply_pointer,
        bytes: reply_bytes,
    };
    assert_eq!(reply.bytes, 9);
    assert_eq!(unsafe { (reply.pointer as *const u8).read() }, 4);
    let number = unsafe { ((reply.pointer + 1) as *const f64).read_unaligned() };
    number as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_interrupt_smoke(regexp: u32) -> i32 {
    let runtime = rquickjs::Runtime::new().expect("QuickJS runtime");
    runtime.set_max_stack_size(32 * 1024);
    runtime.set_interrupt_handler(Some(Box::new(|| unsafe {
        transport::core_checkpoint() != 0
    })));
    let count = std::rc::Rc::new(std::cell::Cell::new(0));
    let polls = count.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        polls.set(polls.get() + 1);
        let interrupted = unsafe { transport::core_checkpoint() != 0 };
        interrupted || polls.get() >= 8
    })));
    let context = rquickjs::Context::full(&runtime).expect("QuickJS context");
    context.with(|ctx| {
        let source = if regexp == 0 {
            "try { for (;;) {} } catch (_) { globalThis.caught = true; } finally { globalThis.finalized = true; }"
        } else {
            "try { /(a+)+$/.test('a'.repeat(40)+'!') } catch (_) { globalThis.caught = true; } finally { globalThis.finalized = true; }"
        };
        assert!(ctx.eval::<(), _>(source).is_err());
        ctx.catch();
    });
    runtime.set_interrupt_handler(None);
    context.with(|ctx| {
        let caught: bool = ctx
            .eval("globalThis.caught === true || globalThis.finalized === true")
            .expect("interrupt flags");
        assert!(!caught, "fatal interruption bypasses catch and finally");
        count.get()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_stack_guard_smoke() -> i32 {
    let runtime = rquickjs::Runtime::new().expect("QuickJS runtime");
    runtime.set_max_stack_size(32 * 1024);
    runtime.set_interrupt_handler(Some(Box::new(|| unsafe {
        transport::core_checkpoint() != 0
    })));
    let context = rquickjs::Context::full(&runtime).expect("QuickJS context");
    context.with(|ctx| ctx.eval::<i32, _>(
        "try { (function recur(){ return recur() })() } catch(e) { e instanceof RangeError ? 1 : 0 }"
    ).expect("catchable stack guard"))
}

unsafe extern "C" {
    fn JS_bunwasm_IsArrayBufferLike(value: rquickjs::qjs::JSValue) -> bool;
    fn JS_bunwasm_IsDetachableArrayBuffer(value: rquickjs::qjs::JSValue) -> bool;
    fn JS_bunwasm_IteratorEntries(
        ctx: *mut rquickjs::qjs::JSContext,
        value: rquickjs::qjs::JSValue,
    ) -> rquickjs::qjs::JSValue;
    fn JS_bunwasm_OwnKeysInOrder(
        ctx: *mut rquickjs::qjs::JSContext,
        value: rquickjs::qjs::JSValue,
    ) -> rquickjs::qjs::JSValue;
    fn JS_bunwasm_GetAsyncContext(ctx: *mut rquickjs::qjs::JSContext) -> rquickjs::qjs::JSValue;
    fn JS_bunwasm_SetAsyncContext(
        ctx: *mut rquickjs::qjs::JSContext,
        value: rquickjs::qjs::JSValue,
    );
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_helpers_smoke() -> i32 {
    let runtime = rquickjs::Runtime::new().expect("QuickJS runtime");
    runtime.set_max_stack_size(32 * 1024);
    let context = rquickjs::Context::full(&runtime).expect("QuickJS context");
    context.with(|ctx| {
        let raw = ctx.as_raw().as_ptr();
        let buffer: rquickjs::Value = ctx.eval("new ArrayBuffer(8)").expect("buffer");
        assert!(unsafe { JS_bunwasm_IsArrayBufferLike(buffer.as_raw()) });
        assert!(unsafe { JS_bunwasm_IsDetachableArrayBuffer(buffer.as_raw()) });
        let iterator: rquickjs::Value = ctx.eval("new Map([[1,2]]).entries()").expect("iterator");
        let entries = unsafe {
            rquickjs::Value::from_raw(
                ctx.clone(),
                JS_bunwasm_IteratorEntries(raw, iterator.as_raw()),
            )
        };
        assert!(entries.is_array());
        let object: rquickjs::Value = ctx.eval("({a:1, b:2})").expect("object");
        let keys = unsafe {
            rquickjs::Value::from_raw(ctx.clone(), JS_bunwasm_OwnKeysInOrder(raw, object.as_raw()))
        };
        assert!(keys.is_array());
        unsafe { JS_bunwasm_SetAsyncContext(raw, object.as_raw()) };
        let current =
            unsafe { rquickjs::Value::from_raw(ctx.clone(), JS_bunwasm_GetAsyncContext(raw)) };
        assert_eq!(current, object);
        ctx.eval::<(), _>("Promise.resolve().then(() => globalThis.jobResult = 42)")
            .expect("schedule");
    });
    assert!(
        runtime
            .execute_pending_job()
            .expect("pending job updates stack top")
    );
    context.with(|ctx| ctx.eval::<i32, _>("jobResult").expect("job value"))
}

mod client;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/data.rs"]
mod data;
mod driver;
use driver::{Core, Entry};
#[allow(unused_imports, dead_code)]
#[path = "../../bunwasm-runtime/src/engine.rs"]
mod engine;
mod loader;
mod natives;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/ops.rs"]
mod ops;
mod program;
#[path = "../../bunwasm-runtime/src/split_api.rs"]
mod split_api;
mod value_natives;
mod vm;

unsafe extern "C" {
    fn bun_core_bind_engine(run: extern "C" fn(u32) -> i32);
    fn quickjs_ctor_value() -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_register() {
    assert_eq!(
        unsafe { quickjs_ctor_value() },
        42,
        "side constructors once"
    );
    unsafe { bun_core_bind_engine(quickjs_run) };
}

#[unsafe(no_mangle)]
pub extern "C" fn quickjs_run(session: u32) -> i32 {
    assert_eq!(
        unsafe { quickjs_ctor_value() },
        42,
        "side constructors once"
    );
    driver::run::<vm::QuickJs>(session)
}

#[cfg(test)]
mod native_contract_tests;
