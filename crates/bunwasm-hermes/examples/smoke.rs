//! Bare smoke test of the Hermes VM library under wasmtime (hermes/smoke.sh): create a runtime,
//! evaluate scripts, read results back, call a native function, drain promise jobs, catch
//! errors and keep a value alive across a forced GC. Exits 1 on the first failed check.
use std::cell::RefCell;
use std::ffi::c_char;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static INTERRUPT: AtomicBool = AtomicBool::new(false);
static RECURSE: AtomicU32 = AtomicU32::new(0);
thread_local! { static DEAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) }; }

use bunwasm_hermes::{self as sys, Handle, kind};

/// `add(...)`: the one native function, id 1. Takes ownership of `this` and the arguments.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_call(
    id: u32,
    this: Handle,
    args: *const Handle,
    count: usize,
    out: *mut Handle,
) -> bool {
    let args: &[Handle] = if count == 0 {
        &[]
    } else {
        // SAFETY: the shim passes `count` handles.
        unsafe { std::slice::from_raw_parts(args, count) }
    };
    if id == 3 {
        unsafe {
            sys::bh_release(this);
        }
        let receiver = unsafe { sys::bh_undefined() };
        let ok = unsafe {
            sys::bh_call(
                RECURSE.load(Ordering::Relaxed),
                receiver,
                std::ptr::null(),
                0,
                out,
            )
        };
        unsafe {
            sys::bh_release(receiver);
        }
        return ok;
    }
    // SAFETY: handles from the shim, released once.
    unsafe {
        let sum = args.iter().map(|h| number(*h)).sum();
        args.iter().for_each(|h| sys::bh_release(*h));
        sys::bh_release(this);
        *out = sys::bh_number(sum);
    }
    id != 2
}

#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_drop(id: u32) {
    DEAD.with_borrow_mut(|ids| ids.push(id));
}

#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_interrupt() -> bool {
    INTERRUPT.load(Ordering::Relaxed)
}

#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_fatal(message: *const c_char, len: usize) {
    let bytes = unsafe { std::slice::from_raw_parts(message.cast::<u8>(), len) };
    eprintln!("Hermes fatal: {}", String::from_utf8_lossy(bytes));
    std::process::exit(134);
}

fn number(h: Handle) -> f64 {
    // SAFETY: a live handle.
    unsafe {
        if sys::bh_kind(h) == kind::NUMBER {
            sys::bh_get_number(h)
        } else {
            f64::NAN
        }
    }
}

fn string(h: Handle) -> String {
    let (mut len, mut ascii) = (0, false);
    // SAFETY: a live string handle; copied before any other VM call.
    unsafe {
        if sys::bh_kind(h) != kind::STRING {
            return String::new();
        }
        let data = sys::bh_string_data(h, &mut len, &mut ascii);
        if ascii {
            return String::from_utf8_lossy(std::slice::from_raw_parts(data.cast(), len)).into();
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(data.cast(), len))
    }
}

/// Evaluate `source`: Ok(result) or Err(thrown value).
fn eval(source: &str) -> Result<Handle, Handle> {
    let mut out = 0;
    let name = "smoke.js";
    // SAFETY: valid buffers.
    let ok = unsafe {
        sys::bh_eval(
            source.as_ptr().cast::<c_char>(),
            source.len(),
            name.as_ptr().cast::<c_char>(),
            name.len(),
            sys::EVAL_LAZY,
            &mut out,
        )
    };
    if ok { Ok(out) } else { Err(out) }
}

fn message(thrown: Handle) -> String {
    let mut out = 0;
    let key = "message";
    // SAFETY: valid handle and key.
    unsafe { sys::bh_get(thrown, key.as_ptr().cast::<c_char>(), key.len(), &mut out) };
    string(out)
}

fn check(name: &str, ok: bool, detail: String) {
    if !ok {
        eprintln!("FAIL {name}: {detail}");
        std::process::exit(1);
    }
    println!("ok   {name}: {detail}");
}

fn main() {
    // SAFETY: first shim call.
    unsafe {
        unsafe extern "C" {
            static __stack_low: u8;
            static __stack_high: u8;
        }
        sys::bh_init(&sys::Config {
            init_heap_mib: 2,
            max_heap_mib: 64,
            interruptible: true,
            stack_low: (&raw const __stack_low) as usize,
            stack_high: (&raw const __stack_high) as usize,
        });
    };

    if std::env::args().any(|arg| arg == "--oom") {
        let _ = eval("var a = []; for (;;) a.push(new Array(100000).fill(1));");
        panic!("OOM must terminate through the fatal callback");
    }

    let n = eval("1 + 2 * 3").map(number);
    check("number result", n == Ok(7.0), format!("{n:?}"));

    let s = eval("'he' + 'llo'.toUpperCase() + ' ' + [1, 2, 3].map(x => x * 2).join()").map(string);
    check(
        "string result",
        s.as_deref() == Ok("heLLO 2,4,6"),
        format!("{s:?}"),
    );

    let add = "add";
    // SAFETY: valid buffers and handles.
    unsafe {
        let f = sys::bh_function(add.as_ptr().cast::<c_char>(), add.len(), 1);
        let global = sys::bh_global();
        let mut out = 0;
        sys::bh_set(
            global,
            add.as_ptr().cast::<c_char>(),
            add.len(),
            f,
            &mut out,
        );
    }
    let sum = eval("add(2, 40)").map(number);
    check("native call", sum == Ok(42.0), format!("{sum:?}"));

    let _ = eval("var r = 0; Promise.resolve(5).then(v => { r = v * 2; })");
    // SAFETY: plain calls.
    let pending = unsafe { sys::bh_has_jobs() };
    let mut out = 0;
    // SAFETY: valid out-parameter.
    unsafe { sys::bh_drain_jobs(&mut out) };
    let r = eval("r").map(number);
    check(
        "promise job",
        pending && r == Ok(10.0),
        format!("pending={pending} r={r:?}"),
    );

    let thrown = eval("throw new TypeError('bad value')").map_err(message);
    check(
        "thrown error",
        thrown == Err("bad value".into()),
        format!("{thrown:?}"),
    );

    let syntax = eval("(").map_err(|e| unsafe { sys::bh_is_error(e) });
    check("syntax error", syntax == Err(true), format!("{syntax:?}"));

    let kept = eval("({ text: 'kept ' + 'alive' })").unwrap_or(0);
    let _ = eval("var junk = []; for (var i = 0; i < 100000; i++) junk.push({ i }); junk = null;");
    // SAFETY: plain call.
    unsafe { sys::bh_gc() };
    let mut text = 0;
    let key = "text";
    // SAFETY: `kept` is still a rooted handle.
    unsafe { sys::bh_get(kept, key.as_ptr().cast::<c_char>(), key.len(), &mut text) };
    check(
        "value across gc",
        string(text) == "kept alive",
        string(text),
    );

    let (mut used, mut size, mut external) = (0.0, 0.0, 0.0);
    // SAFETY: valid out-parameters.
    unsafe { sys::bh_heap_info(&mut used, &mut size, &mut external) };
    check(
        "heap info",
        size > 0.0 && used > 0.0,
        format!("used={used} size={size} external={external}"),
    );
    check_bytes();
    check_external();
    check_context();
    check_boundaries();
}

fn put_global(name: &str, value: Handle) {
    unsafe {
        let global = sys::bh_global();
        let mut out = 0;
        assert!(sys::bh_set(
            global,
            name.as_ptr().cast(),
            name.len(),
            value,
            &mut out
        ));
        sys::bh_release(global);
    }
}

fn bytes(value: Handle) -> Vec<u8> {
    unsafe {
        let mut len = 0;
        let data = sys::bh_bytes(value, &mut len);
        if len == 0 {
            return Vec::new();
        }
        std::slice::from_raw_parts(data, len).to_vec()
    }
}

fn check_bytes() {
    let buffer = eval("var bytes = new Uint8Array([1,2,3,4,5,6,7,8]); bytes.buffer").unwrap();
    check(
        "ArrayBuffer bytes",
        bytes(buffer) == [1, 2, 3, 4, 5, 6, 7, 8],
        format!("{:?}", bytes(buffer)),
    );
    for name in [
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
    ] {
        let source = format!("new {name}(bytes.buffer, 0, 8 / {name}.BYTES_PER_ELEMENT)");
        let view = eval(&source).unwrap();
        let kind = unsafe { sys::bh_kind(view) };
        let expected_kind = if name == "Uint8Array" {
            kind::UINT8ARRAY
        } else {
            kind::TYPED_ARRAY
        };
        check(
            name,
            kind == expected_kind && bytes(view) == bytes(buffer),
            format!("kind={kind}"),
        );
        unsafe {
            sys::bh_release(view);
        }
    }
    for source in [
        "new Uint8Array(bytes.buffer, 2, 4)",
        "new Uint16Array(bytes.buffer, 2, 2)",
        "new DataView(bytes.buffer, 2, 4)",
    ] {
        let view = eval(source).unwrap();
        check(
            "view offset",
            bytes(view) == [3, 4, 5, 6],
            format!("{:?}", bytes(view)),
        );
        unsafe {
            sys::bh_release(view);
        }
    }
    unsafe {
        sys::bh_release(buffer);
    }
}

fn check_external() {
    let mut memory = vec![1u8, 2, 3, 4];
    let buffer = unsafe { sys::bh_external_buffer(memory.as_mut_ptr(), memory.len()) };
    put_global("external", buffer);
    assert!(unsafe { sys::bh_is_external(buffer) });
    assert!(!unsafe { sys::bh_is_external(sys::bh_number(0.0)) });
    let empty = unsafe { sys::bh_external_buffer(std::ptr::null_mut(), 0) };
    assert!(unsafe { sys::bh_is_external(empty) && sys::bh_detach_external(empty) });
    unsafe {
        sys::bh_release(empty);
    }
    let view = eval("var externalView = new DataView(external, 1, 2); externalView.setUint8(0, 42); externalView").unwrap();
    check(
        "external memory alias",
        memory[1] == 42 && bytes(view) == [42, 3],
        format!("{memory:?}"),
    );
    unsafe {
        sys::bh_gc();
    }
    check(
        "external rooted across GC",
        bytes(buffer) == memory,
        format!("{:?}", bytes(buffer)),
    );
    assert!(unsafe { sys::bh_detach_external(buffer) });
    check(
        "external view detach",
        bytes(view).is_empty() && bytes(buffer).is_empty(),
        format!("memory={memory:?}"),
    );
    assert!(!unsafe { sys::bh_detach_external(buffer) });
    assert!(!unsafe { sys::bh_is_external(buffer) });
    unsafe {
        sys::bh_release(view);
        sys::bh_release(buffer);
    }
    check(
        "external storage retained",
        memory == [1, 42, 3, 4],
        format!("{memory:?}"),
    );
}

fn drain() {
    let mut out = 0;
    assert!(unsafe { sys::bh_drain_jobs(&mut out) });
}

fn check_context() {
    let _ = eval(r#"
        var getContext = Promise._G, setContext = Promise._S, internalThen = Promise._T;
        delete Promise._G; delete Promise._S; delete Promise._T;
        var contexts = [];
        var resolver;
        var pending = new Promise(r => resolver = r);
        setContext('registered');
        pending.then(() => contexts.push(getContext()));
        async function awaiting() { await pending; contexts.push(getContext()); }
        awaiting();
        setContext('resolver'); resolver(1);
        var hostile = Promise.resolve(1);
        Object.defineProperty(hostile, 'constructor', { get() { throw Error('constructor read'); } });
        Object.defineProperty(hostile, 'then', { get() { throw Error('then read'); } });
        setContext('private');
        internalThen(hostile, () => contexts.push(getContext()), undefined);
        setContext('restored');
    "#).unwrap();
    drain();
    let result = eval("contexts.join(',') + '/' + getContext()").map(string);
    check(
        "Promise then/await/private context",
        result.as_deref() == Ok("registered,registered,private/restored"),
        format!("{result:?}"),
    );
}

fn check_boundaries() {
    let throwing = unsafe { sys::bh_function(c"throws".as_ptr(), 6, 2) };
    put_global("nativeThrows", throwing);
    let result = eval("nativeThrows(42)").map_err(number);
    check(
        "native exception",
        result == Err(42.0),
        format!("{result:?}"),
    );
    let recursion = eval("function recurse() { return recurse(); } recurse()").map_err(message);
    check(
        "stack overflow",
        recursion.as_ref().is_err_and(|s| s.contains("call stack")),
        format!("{recursion:?}"),
    );
    let native_recurse = unsafe { sys::bh_function(c"nativeRecurse".as_ptr(), 13, 3) };
    RECURSE.store(native_recurse, Ordering::Relaxed);
    put_global("nativeRecurse", native_recurse);
    let native_stack = eval("nativeRecurse()").map_err(message);
    check(
        "native stack bounds",
        native_stack
            .as_ref()
            .is_err_and(|s| s.contains("native stack depth")),
        format!("{native_stack:?}"),
    );
    let temporary = unsafe { sys::bh_function(c"temporary".as_ptr(), 9, 99) };
    unsafe {
        sys::bh_release(temporary);
        sys::bh_gc();
    }
    let dead = DEAD.take();
    check(
        "GC queues native drops",
        dead.contains(&99),
        format!("{dead:?}"),
    );
    INTERRUPT.store(true, Ordering::Relaxed);
    let interrupted = eval("var caught = false; try { for (;;) {} } catch(e) { caught = true; }");
    INTERRUPT.store(false, Ordering::Relaxed);
    let caught = eval("caught").unwrap();
    check(
        "uncatchable host interrupt",
        interrupted.is_err() && !unsafe { sys::bh_get_bool(caught) },
        format!("{interrupted:?}"),
    );
}
