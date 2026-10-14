//! JSC/WTF helpers and dispatch slots that `native.rs` does not cover.
use core::ffi::{c_int, c_void};

use bun_core::String as BunString;

// ── libc ──────────────────────────────────────────────────────────────────

/// `bun_core::ffi::errno_ptr` links this name on targets without
/// `__errno_location`; wasi-libc exposes `errno` itself.
#[unsafe(no_mangle)]
extern "C" fn errno_location() -> *mut c_int {
    unsafe extern "C" {
        static mut errno: c_int;
    }
    // SAFETY: address of wasi-libc's errno.
    unsafe { &raw mut errno }
}

// ── WTF strings: never created without JavaScriptCore ─────────────────────

#[unsafe(no_mangle)]
extern "C" fn Bun__WTFStringImpl__destroy(_this: *const c_void) {
    unreachable!("WTF::StringImpl does not exist in bun-wasm");
}

/// `String::clone_utf8`. Without WTF there is no refcounted owner, so the
/// copy is leaked and borrowed (these are paths and names, created rarely).
#[unsafe(no_mangle)]
unsafe extern "C" fn BunString__fromBytes(bytes: *const u8, len: usize) -> BunString {
    // SAFETY: caller passes a valid slice.
    let src = unsafe { core::slice::from_raw_parts(bytes, len) };
    let leaked: &'static [u8] = Box::leak(src.to_vec().into_boxed_slice());
    BunString::borrow_utf8(leaked)
}

/// `file://` URL for an absolute path (percent-encoding like WHATWG URL).
#[unsafe(no_mangle)]
extern "C" fn URL__getFileURLString(input: &BunString) -> BunString {
    let path = input.to_utf8();
    let mut out = Vec::from(&b"file://"[..]);
    for &b in path.slice() {
        let keep = b.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&b);
        if keep {
            out.push(b);
        } else {
            out.extend_from_slice(format!("%{b:02X}").as_bytes());
        }
    }
    BunString::borrow_utf8(Box::leak(out.into_boxed_slice()))
}

// ── JSC number semantics used by constant folding ─────────────────────────

/// ECMAScript `Number::exponentiate`, which differs from C `pow` for
/// `(±1) ** ±Infinity` and `x ** NaN`.
#[unsafe(no_mangle)]
extern "C" fn Bun__JSC__operationMathPow(x: f64, y: f64) -> f64 {
    if y.is_nan() {
        return f64::NAN;
    }
    if y == 0.0 {
        return 1.0;
    }
    if y.is_infinite() && x.abs() == 1.0 {
        return f64::NAN;
    }
    x.powf(y)
}

/// ECMAScript `ToNumber` applied to a string.
#[unsafe(no_mangle)]
unsafe extern "C" fn JSC__jsToNumber(ptr: *const u8, len: usize) -> f64 {
    // SAFETY: caller passes a valid slice.
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    let Ok(text) = core::str::from_utf8(bytes) else {
        return f64::NAN;
    };
    js_string_to_number(text)
}

fn js_string_to_number(text: &str) -> f64 {
    let s = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if s.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, radix: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0f64;
        for c in digits.chars() {
            match c.to_digit(radix) {
                Some(d) => value = value * radix as f64 + d as f64,
                None => return f64::NAN,
            }
        }
        value
    };
    let lower = s.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&s[2..], 16),
        Some("0o") => return radix(&s[2..], 8),
        Some("0b") => return radix(&s[2..], 2),
        _ => {}
    }
    let (sign, body) = match s.as_bytes()[0] {
        b'-' => (-1.0, &s[1..]),
        b'+' => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let valid = !body.is_empty()
        && body.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && body.bytes().any(|b| b.is_ascii_digit());
    if !valid {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

// ── ICU collation (Intl.Collator-style compare), code point order ────────

fn collate<T: Ord + Copy + Into<u32>>(numeric: bool, a: &[T], b: &[T]) -> i32 {
    let ordering = if numeric {
        natural_cmp(a, b)
    } else {
        a.cmp(b)
    };
    ordering as i32
}

fn natural_cmp<T: Copy + Into<u32>>(a: &[T], b: &[T]) -> core::cmp::Ordering {
    let digit = |c: u32| (b'0' as u32..=b'9' as u32).contains(&c);
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (ca, cb) = (a[i].into(), b[j].into());
        if digit(ca) && digit(cb) {
            let si = i;
            while i < a.len() && digit(a[i].into()) {
                i += 1;
            }
            let sj = j;
            while j < b.len() && digit(b[j].into()) {
                j += 1;
            }
            let num = |s: &[T]| s.iter().fold(0u128, |n, &c| n.saturating_mul(10) + (c.into() - b'0' as u32) as u128);
            match num(&a[si..i]).cmp(&num(&b[sj..j])) {
                core::cmp::Ordering::Equal => continue,
                other => return other,
            }
        }
        match ca.cmp(&cb) {
            core::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
            other => return other,
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__collateUTF8(numeric: bool, a: *const u8, a_len: usize, b: *const u8, b_len: usize) -> i32 {
    // SAFETY: caller passes valid slices.
    let (a, b) = unsafe { (core::slice::from_raw_parts(a, a_len), core::slice::from_raw_parts(b, b_len)) };
    let (a, b): (Vec<u32>, Vec<u32>) = (
        bstr::ByteSlice::chars(a).map(u32::from).collect(),
        bstr::ByteSlice::chars(b).map(u32::from).collect(),
    );
    collate(numeric, &a, &b)
}

#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__collateUTF16(numeric: bool, a: *const u16, a_len: usize, b: *const u16, b_len: usize) -> i32 {
    // SAFETY: caller passes valid slices.
    let (a, b) = unsafe { (core::slice::from_raw_parts(a, a_len), core::slice::from_raw_parts(b, b_len)) };
    collate(numeric, a, b)
}

// ── link-time dispatch slots normally filled by the JSC-tier crates ───────

// The on-disk runtime transpiler cache: off in wasm.
bun_ast::link_impl_TranspilerCacheImpl! {
    Jsc for extern bun_ast::RuntimeTranspilerCache => |this| {
        get(source, parser_options, used_jsx) => {
            let _ = (this, source, parser_options, used_jsx);
            false
        },
        put(output_code, sourcemap, esm_record) => {
            let _ = (this, output_code, sourcemap, esm_record);
        },
        is_disabled() => true,
    }
}

/// Macros (`import ... with { type: "macro" }`) run JS at build time, which
/// needs the engine; the parser reports them as unsupported.
#[unsafe(no_mangle)]
fn __bun_macro_context_init(_transpiler: *mut c_void) -> bun_js_parser::Macro::MacroContext {
    bun_js_parser::Macro::MacroContext::default()
}

/// `npm:` alias parsing lives in bun_install; without it aliases resolve as names.
#[unsafe(no_mangle)]
fn __bun_resolver_parse_dependency(
    _name: bun_semver::String,
    _name_hash: bun_install_types::resolver_hooks::PackageNameHash,
    _version: &[u8],
    _sliced: &bun_semver::SlicedString,
    _log: Option<&mut bun_ast::Log>,
) -> Option<bun_install_types::resolver_hooks::DependencyVersion> {
    None
}

// ── BoringSSL: reachable from TLS option parsing, never called here ───────

macro_rules! unreachable_c {
    ($($name:ident),* $(,)?) => {$(
        #[unsafe(no_mangle)]
        extern "C" fn $name() -> usize {
            unreachable!(concat!(stringify!($name), ": TLS is not available in bun-wasm"))
        }
    )*};
}
unreachable_c!(
    OPENSSL_free, X509_NAME_get_index_by_NID, sk_pop_free_ex, sk_num, sk_value, i2d_SSL_SESSION,
    GENERAL_NAME_free, X509V3_EXT_get_nid, X509V3_EXT_get, X509V3_EXT_d2i, X509_NAME_get_entry,
    X509_NAME_ENTRY_get_data, X509_get_subject_name, X509_get_ext_by_NID, X509_get_ext,
    SSL_SESSION_up_ref, SSL_SESSION_free, ASN1_STRING_to_UTF8,
);
