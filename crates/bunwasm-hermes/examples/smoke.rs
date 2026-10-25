//! Bare smoke test of the Hermes VM library under wasmtime (hermes/smoke.sh): create a runtime,
//! evaluate scripts, read results back, call a native function, drain promise jobs, catch
//! errors and keep a value alive across a forced GC. Exits 1 on the first failed check.
use std::ffi::c_char;

use bunwasm_hermes::{self as sys, Handle, kind};

/// `add(...)`: the one native function, id 1. Takes ownership of `this` and the arguments.
#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_call(
    _id: u32,
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
    // SAFETY: handles from the shim, released once.
    unsafe {
        let sum = args.iter().map(|h| number(*h)).sum();
        args.iter().for_each(|h| sys::bh_release(*h));
        sys::bh_release(this);
        *out = sys::bh_number(sum);
    }
    true
}

#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_drop(_id: u32) {}

#[unsafe(no_mangle)]
extern "C" fn bunhermes_host_interrupt() -> bool {
    false
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
            false,
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
    unsafe { sys::bh_init(64, false) };

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

    let (mut used, mut size) = (0.0, 0.0);
    // SAFETY: valid out-parameters.
    unsafe { sys::bh_heap_info(&mut used, &mut size) };
    check("heap info", size > 0.0, format!("used={used} size={size}"));
}
