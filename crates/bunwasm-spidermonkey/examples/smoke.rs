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
        sys::bsm_init(&sys::Config {
            stack_low: std::ptr::addr_of!(__stack_low) as usize,
            stack_high: std::ptr::addr_of!(__stack_high) as usize,
            max_gc_bytes: 64 * 1024 * 1024,
            tier,
            interruptible: 1,
        });
    }
    println!("ok init tier={}", if pbl { "pbl" } else { "interp" });
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
    let polls = unsafe { sys::bsm_poll_count(tier) };
    let entries = unsafe { sys::bsm_pbl_entries() };
    assert!(polls >= 30000);
    assert_eq!(entries > 0, pbl, "actual interpreter tier");
    println!("ok tier evidence polls={polls} pbl_entries={entries}");
    unsafe { sys::bsm_shutdown() };
}
