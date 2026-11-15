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
extern "C" {
    fn bsm_set_global(name: *const c_char, len: usize, value: u32) -> bool;
    fn bsm_print(value: u32) -> bool;
}
// Differential parser corpus from scripts/spidermonkey-parser-semantics.ts: evaluate the harness,
// compile every later chunk directly as UTF-8 and hand its result to the harness, then print the
// harness's report.
fn parser_corpus(corpus: &str) {
    let mut chunks = corpus.split("\n//@@utf8\n");
    let (harness, status) = eval(chunks.next().unwrap_or_default());
    assert_eq!(status, 0, "parser corpus harness");
    unsafe { sys::bsm_release(harness) };
    for source in chunks {
        let (value, status) = eval(source);
        assert!(status < 2, "parser corpus case ended without a result");
        assert!(unsafe { bsm_set_global(b"__value".as_ptr().cast(), 7, value) });
        unsafe { sys::bsm_release(value) };
        let (step, step_status) = eval(&format!("__utf8Step({status})"));
        assert_eq!(step_status, 0, "parser corpus step");
        unsafe { sys::bsm_release(step) };
    }
    let (report, status) = eval("__finish()");
    assert_eq!(status, 0, "parser corpus report");
    assert!(unsafe { bsm_print(report) });
    unsafe { sys::bsm_release(report) };
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
    if let Ok(corpus) = std::env::var("BUNSM_PARSER_CORPUS") {
        parser_corpus(&corpus);
        unsafe { sys::bsm_shutdown() };
        return;
    }
    if std::env::var("BUN_WASM_SPIDERMONKEY_STACK_KIB").is_ok() {
        budget_checks(pbl);
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
    // Setters and bound functions re-enter the engine in C on both tiers. Each level holds a
    // recursion unit, so the 350-unit WASI limit ends them with a catchable RangeError before a
    // browser's native stack runs out. Named getters and calls with missing arguments stay in an
    // interpreter loop: the C++ interpreter's on that tier, and on PBL its own loop (padded
    // arguments) or, once the stack is deep, the C++ interpreter's after the hand-over. Only the
    // frame limit bounds them.
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
        // Getters, call and apply run as C++ interpreter frames, on PBL once the stack is deep.
        let counted = label == "setter" || label == "bound";
        assert!(depth > 100.0, "{label} recursion depth {depth}");
        assert!(!counted || depth < 350.0, "{label} recursion depth {depth}");
        assert!(counted || depth > 4096.0, "{label} recursion depth {depth}");

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

/// With a budget in `BUN_WASM_SPIDERMONKEY_STACK_KIB` (WebKit hosts pass 188 KiB), every reserved
/// recursion path ends in a catchable RangeError and evaluation continues. The byte quota, not the
/// WASI counter, must stop reentrant getters and every compile cycle, which shows the
/// reservations are in effect (docs/bun-patches/spidermonkey-stack-budget.md).
fn budget_checks(pbl: bool) {
    for (label, code) in [
        ("call", "function f() { d++; return f.call(null); } f();"),
        (
            "apply",
            "function f() { d++; return f.apply(null, [1]); } f();",
        ),
        // `call` and `apply` that keep the native route reenter through RunScript.
        (
            "apply array-like",
            "function f() { d++; return f.apply(null, { length: 0 }); } f();",
        ),
        (
            "call of call",
            "function f() { d++; return f.call.call(f, null); } f();",
        ),
        (
            "getter",
            "var o = { get x() { d++; return this.x; } }; o.x;",
        ),
        (
            "computed getter",
            "var k = 'x', o = { get x() { d++; return this[k]; } }; o[k];",
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
            "proxy",
            "var p = new Proxy({}, { get() { d++; return p.x; } }); p.x;",
        ),
        (
            "stringify",
            "var v = 1; for (var i = 0; i < 100000; i++) v = [v]; d = 1; JSON.stringify(v);",
        ),
        (
            "join",
            "var v = [1]; for (var i = 0; i < 100000; i++) v = [v]; d = 1; String(v);",
        ),
        (
            "parentheses",
            "d = 1; (0, eval)('('.repeat(20000) + '1' + ')'.repeat(20000));",
        ),
        (
            "statements",
            "d = 1; (0, eval)('if (false) {' + 'if (ok) {'.repeat(20000) + '}'.repeat(20001));",
        ),
    ] {
        let depth = number(&format!(
            "var d = 0, caught = 0; try {{ {code} }} catch (e) {{ if (!(e instanceof RangeError)) throw e; caught = 1; }} caught ? d : -1"
        ));
        assert!(
            depth > 0.0,
            "{label} must end in a caught RangeError, got {depth}"
        );
        println!("budget {label} depth {depth}");
        assert_eq!(number("6 * 7"), 42.0);
        // Without the quota the counter stops reentrant getters near 175 levels (interp) or 234
        // (PBL). `a.b` getters run as interpreter frames that use no host stack, so the frame
        // limit ends them; on PBL they move to the C++ interpreter once the stack is deep
        // (docs/bun-patches/spidermonkey-pbl-handover.md). A computed-key getter still reenters
        // through RunScript, and its reservation must let the quota stop it
        // (docs/bun-patches/spidermonkey-loop-dispatch.md).
        // `call` and `apply` to a scripted target with a packed list also run in the loop there.
        // `apply` with an array-like and `call` of `call` keep the native route: without the quota
        // the counter stops them at 87 to 172 levels, so stopping below 85 shows the RunScript
        // reservation still governs them on both tiers.
        let in_loop = matches!(label, "getter" | "call" | "apply");
        let reentrant = label == "computed getter";
        let native_call = matches!(label, "apply array-like" | "call of call");
        let bound = if pbl { 300.0 } else { 140.0 };
        assert!(
            !reentrant || (depth > 20.0 && depth < bound),
            "{label} depth {depth} under the budget"
        );
        assert!(
            !native_call || (depth > 20.0 && depth < 85.0),
            "{label} depth {depth} under the budget"
        );
        assert!(
            !in_loop || depth > 4096.0,
            "{label} depth {depth} in the interpreter loop"
        );
    }
    // The frontend's own bound admits 400 nested `if` blocks; the budget refuses 300.
    let refused = number(
        "var accepts = (n) => { try { (0, eval)('if (false) {' + 'if (ok) {'.repeat(n) + '}'.repeat(n + 1)); return 1; } catch (e) { if (e instanceof RangeError) return 0; throw e; } };
        accepts(20) * 10 + accepts(300)",
    );
    assert_eq!(refused, 10.0, "statement nesting under the budget");
    assert_eq!(number("6 * 7"), 42.0);
    compile_budget_checks();
    println!("ok budget recursion caught and recovered on every reserved path");
}

/// Under the WebKit budget the byte quota, not the frontend's depth bound, stops every compile
/// recursion cycle. Each row is one construct nested `n` deep and the depth the 188 KiB budget
/// accepts with the sizes of docs/bun-patches/spidermonkey-stack-budget.md. A reservation that
/// left its frame, or a cycle with none, accepts far more; a changed size moves its rows, and
/// then the table there and the browser measurements behind it are due again.
fn compile_budget_checks() {
    number(
        "var deepest = (ok) => { var low = 0, high = 1; while (ok(high)) { low = high; high *= 2; if (high > 100000) throw new Error('unbounded'); }
          while (low + 1 < high) { var middle = (low + high) >> 1; if (ok(middle)) low = middle; else high = middle; } return low; };
        var refused = (run) => { try { run(); return false; } catch (e) { if (!(e instanceof RangeError)) throw e; return true; } }; 0",
    );
    for (label, make, expected) in [
        ("blocks", "'{'.repeat(n) + '1;' + '}'.repeat(n)", 241.0),
        (
            "if blocks",
            "'if (ok) {'.repeat(n) + '1;' + '}'.repeat(n)",
            147.0,
        ),
        ("unbraced ifs", "'if (ok) '.repeat(n) + '1;'", 103.0),
        (
            "labels",
            "Array.from({ length: n }, (_, i) => 'l' + i + ': ').join('') + '1;'",
            139.0,
        ),
        (
            "labelled loops",
            "Array.from({ length: n }, (_, i) => 'l' + i + ': while (true) {').join('') + '1;' + '}'.repeat(n)",
            54.0,
        ),
        (
            "for loops",
            "'for (;;) {'.repeat(n) + '1;' + '}'.repeat(n)",
            86.0,
        ),
        ("unbraced loops", "'while (ok) '.repeat(n) + '1;'", 141.0),
        (
            "try blocks",
            "'try {'.repeat(n) + '1;' + '} finally {}'.repeat(n)",
            213.0,
        ),
        (
            "switches",
            "'switch (ok) { default: '.repeat(n) + '1;' + '}'.repeat(n)",
            226.0,
        ),
        (
            "parentheses",
            "'('.repeat(n) + '1' + ')'.repeat(n) + ';'",
            62.0,
        ),
        ("arrays", "'['.repeat(n) + ']'.repeat(n) + ';'", 63.0),
        (
            "objects",
            "'x = ' + '{ a: '.repeat(n) + '1' + ' }'.repeat(n) + ';'",
            61.0,
        ),
        ("calls", "'f('.repeat(n) + '1' + ')'.repeat(n) + ';'", 54.0),
        (
            "element access",
            "'a['.repeat(n) + '0' + ']'.repeat(n) + ';'",
            62.0,
        ),
        (
            "templates",
            "'`${'.repeat(n) + '1' + '}`'.repeat(n) + ';'",
            52.0,
        ),
        ("conditionals", "'a ? b : '.repeat(n) + 'c;'", 150.0),
        ("assignments", "'x = '.repeat(n) + '1;'", 150.0),
        ("unary operators", "'!'.repeat(n) + 'x;'", 288.0),
        ("typeof", "'typeof '.repeat(n) + 'x;'", 288.0),
        ("new", "'new ('.repeat(n) + 'c' + ')'.repeat(n) + ';'", 46.0),
        ("arrows", "'() => '.repeat(n) + '1;'", 54.0),
        (
            "functions",
            "'function g() {'.repeat(n) + '}'.repeat(n)",
            61.0,
        ),
        (
            "function expressions",
            "'(function () {'.repeat(n) + '1' + '})();'.repeat(n)",
            20.0,
        ),
        (
            "methods",
            "'x = { m() { return '.repeat(n) + '1' + '} };'.repeat(n)",
            25.0,
        ),
        (
            "class methods",
            "'(class { m() { return '.repeat(n) + '1' + '} });'.repeat(n)",
            19.0,
        ),
    ] {
        let depth = number(&format!(
            "var make = (n) => 'if (false) {{' + ({make}) + '}}'; deepest((n) => !refused(() => (0, eval)(make(n))))"
        ));
        println!("budget compile {label} depth {depth}");
        // PBL starts a little deeper in the stack, so it accepts about 3 percent less.
        assert!(
            (depth - expected).abs() <= expected * 0.15 + 1.0,
            "{label} compiles {depth} levels under the budget, expected about {expected}"
        );
        assert_eq!(number("6 * 7"), 42.0);
    }
    // The bytecode emitter has a reservation of its own. A validator-shaped function is only
    // parsed lazily when it is declared and compiled in full on its first call. As dead code the
    // emitter never walks its body, so the parser decides and the first call goes as deep as the
    // declaration. As live code the emitter's reservation refuses the first call earlier, and
    // still leaves room for Ajv's deepest Angular validator (57 levels).
    number(
        "var body = (n) => 'let ok = true;' + 'if (ok) { if (value.p !== undefined) { const seen = ok; ok = seen; } else ok = true;'.repeat(n) + '}'.repeat(n);
        var live = (n) => (0, eval)('function probeLive(value) {' + body(n) + '}; probeLive');
        var dead = (n) => (0, eval)('function probeDead(value) { if (false) {' + body(n) + '} }; probeDead'); 0",
    );
    let lazy = number("deepest((n) => !refused(() => live(n)))");
    let dead_full = number("deepest((n) => !refused(() => dead(n)({})))");
    let live_full = number("deepest((n) => !refused(() => live(n)({})))");
    println!("budget compile validator lazy {lazy} dead {dead_full} live {live_full}");
    assert!(
        live_full >= 80.0 && live_full + 10.0 <= dead_full && dead_full <= lazy,
        "emitter reservation: lazy {lazy}, dead code {dead_full}, live code {live_full}"
    );
    assert_eq!(
        number(&format!(
            "var late = live({}); refused(() => late({{}})) && (0, eval)('6 * 7') === 42 ? 1 : 0",
            live_full + 1.0
        )),
        1.0,
        "a call the emitter refuses is a caught RangeError"
    );
}
