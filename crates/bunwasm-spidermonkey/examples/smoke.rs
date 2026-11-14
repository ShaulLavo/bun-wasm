use bunwasm_spidermonkey as sys;
use std::ffi::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
static INTERRUPT: AtomicBool = AtomicBool::new(false);
#[no_mangle]
extern "C" fn bunsm_host_interrupt() -> bool {
    INTERRUPT.load(Ordering::Relaxed)
}
#[no_mangle]
extern "C" fn bunsm_host_fatal(message: *const c_char, len: usize) -> ! {
    let bytes = unsafe { std::slice::from_raw_parts(message.cast::<u8>(), len) };
    eprintln!("SpiderMonkey fatal: {}", String::from_utf8_lossy(bytes));
    std::process::exit(134)
}
fn eval(source: &str) -> (u32, u32) {
    let mut status = 0;
    let handle = unsafe { sys::bsm_eval(source.as_ptr().cast(), source.len(), &mut status) };
    (handle, status)
}
fn number(source: &str) -> f64 {
    let (h, status) = eval(source);
    assert_eq!(status, 0, "{source}");
    let result = unsafe { sys::bsm_number(h) };
    unsafe { sys::bsm_release(h) };
    result
}
pub fn main() {
    let pbl = std::env::args().any(|s| s == "pbl");
    let tier = u8::from(pbl);
    unsafe {
        extern "C" {
            static __stack_low: u8;
            static __stack_high: u8;
        }
        let stack_low = std::ptr::addr_of!(__stack_low) as usize;
        let stack_low = if std::env::args().any(|s| s == "--relocated-stack") {
            stack_low + 1024 * 1024
        } else {
            stack_low
        };
        sys::bsm_init(&sys::Config {
            stack_low,
            stack_high: std::ptr::addr_of!(__stack_high) as usize,
            max_gc_bytes: 64 * 1024 * 1024,
            tier,
            interruptible: 1,
        });
    }
    println!("ok init tier={}", if pbl { "pbl" } else { "interp" });
    if let Ok(source) = std::env::var("BUNSM_NEST_PROBE") {
        println!("probe {}", number(&source));
        unsafe { sys::bsm_shutdown() };
        return;
    }
    if std::env::args().any(|s| s == "--oom") {
        unsafe { sys::bsm_force_oom() };
        panic!("OOM returned");
    }
    assert_eq!(number("1 + 2 * 3"), 7.0);
    assert_eq!(number("'e\\u0301'.normalize('NFC').length"), 1.0);
    assert_eq!(number("'\\u00e9'.normalize('NFD').length"), 2.0);
    assert_eq!(number("'\\ufb03'.normalize('NFKC').length"), 3.0);
    assert_eq!(number("'\\ufb03'.normalize('NFKD').length"), 3.0);
    println!("ok eval and Rust normalization glue");
    let (kept, status) = eval("({ answer: 42 })");
    assert_eq!(status, 0);
    number("var junk = Array.from({length:100000}, (_, i) => ({i})); junk = null; 0");
    unsafe {
        sys::bsm_gc();
        assert_eq!(sys::bsm_answer(kept), 42.0);
        sys::bsm_release(kept);
    }
    println!("ok rooted value across GC");
    assert!(
        number(
            "var depth=0; try { (function recurse(){ depth++; return recurse(); })(); } catch(e) { e instanceof RangeError ? depth : 0; }"
        ) > 0.0
    );
    println!("ok catchable stack overflow RangeError");
    assert_eq!(number("40 + 2"), 42.0);
    assert!(
        number(
            "var secondDepth=0; try { (function recurseAgain(){ secondDepth++; return recurseAgain(); })(); } catch(e) { e instanceof RangeError ? secondDepth : 0; }"
        ) > 0.0
    );
    assert_eq!(number("6 * 7"), 42.0);
    println!("ok evaluation and second recursion after caught overflow");
    // Generated validators nest hundreds of blocks; the frontend bound admits them. Deeper input,
    // nested functions (weighted) and compiles under deep runtime recursion are refused with a
    // catchable RangeError, and evaluation continues.
    assert_eq!(
        number(
            "var nested = (open, close, n) => 'if (false) {' + Array.from({ length: n }, (_, i) => open.split('#').join(i)).join('') + '1;' + close.repeat(n) + '}';
            var accepts = (s) => { try { (0, eval)(s); return 1; } catch (e) { if (e instanceof RangeError) return 0; throw e; } };
            var down = (d, s) => d ? String({ toString() { return down(d - 1, s); } }) : String(accepts(s));
            Number([accepts(nested('l#: while (true) {', '}', 300)), accepts(nested('if (ok) {', '}', 400)),
              accepts(nested('{', '}', 5000)), accepts(nested('() => ', '', 1000)),
              accepts(nested('l#: ', '', 1000)), down(80, nested('l#: ', '', 1000))].join(''))"
        ),
        110010.0
    );
    assert_eq!(number("6 * 7"), 42.0);
    println!("ok nested compile limits and recovery");
    for (label, code) in [
        (
            "loop",
            "var caught=0, finalized=0; try { for(;;){} } catch(e) { caught++; } finally { finalized++; }",
        ),
        (
            "inside catch",
            "var caught=0, finalized=0; try { try { throw 1; } catch(e) { for(;;){} } } catch(e) { caught++; } finally { finalized++; }",
        ),
        (
            "inside finally",
            "var caught=0, finalized=0; try { try {} finally { for(;;){} } } catch(e) { caught++; } finally { finalized++; }",
        ),
    ] {
        INTERRUPT.store(true, Ordering::Relaxed);
        let (handle, status) = eval(code);
        INTERRUPT.store(false, Ordering::Relaxed);
        assert_eq!(
            (handle, status),
            (0, 2),
            "{label} must terminate with no exception"
        );
        assert_eq!(
            number("caught + finalized"),
            0.0,
            "catch/finally bypass: {label}"
        );
        println!("ok uncatchable interrupt {label}; catch=0 finally=0");
    }
    // Getters, setters, bound functions and calls with missing arguments re-enter the portable
    // baseline interpreter in C. Each level holds a recursion unit, so the 350-unit WASI limit
    // ends them with a catchable RangeError before a browser's native stack runs out. On the
    // interpreter tier, missing-argument calls stay in the loop and only the bytecode stack
    // bounds them.
    for (label, code) in [
        (
            "getter",
            "var o = { get x() { d++; return this.x; } }; o.x;",
        ),
        (
            "setter",
            "var o = { set x(v) { d++; this.x = v; } }; o.x = 1;",
        ),
        (
            "bound",
            "var b; function f() { d++; return b(); } b = f.bind(null); b();",
        ),
        (
            "missing argument",
            "function f(a, b) { d++; return f(1) + 1; } f(1);",
        ),
        (
            "call",
            "function f() { d++; return f.call(this) + 1; } f();",
        ),
        (
            "apply",
            "function f() { d++; return f.apply(this, arguments) + 1; } f(1);",
        ),
    ] {
        let depth = number(&format!(
            "var d = 0; try {{ {code} }} catch (e) {{ if (!(e instanceof RangeError)) throw e; }} d"
        ));
        // Getters, call and apply run as interpreter frames on the interpreter tier.
        let framed = matches!(label, "getter" | "call" | "apply");
        let counted = pbl || (label != "missing argument" && !framed);
        assert!(depth > 100.0, "{label} recursion depth {depth}");
        assert!(!counted || depth < 350.0, "{label} recursion depth {depth}");
        assert!(
            pbl || !framed || depth > 4096.0,
            "{label} recursion depth {depth}"
        );

        assert_eq!(number("6 * 7"), 42.0);
    }
    println!("ok counted reentrant recursion");
    println!("ok named getter frame storage and recovery");
    println!("ok call and apply frame storage and recovery");
    let polls = unsafe { sys::bsm_poll_count(tier) };
    let entries = unsafe { sys::bsm_pbl_entries() };
    assert!(polls >= 30000);
    assert_eq!(entries > 0, pbl, "actual interpreter tier");
    println!("ok tier evidence polls={polls} pbl_entries={entries}");
    unsafe { sys::bsm_shutdown() };
}
