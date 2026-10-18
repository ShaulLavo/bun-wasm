//! `engine-host`: the JavaScript engine is the host's own (the browser's V8
//! or JavaScriptCore with JIT, or Node/Bun for headless tests), not one
//! compiled into the wasm. See docs/engine-browser.md.
//!
//! The wasm keeps everything that is real Bun: transpiling, resolution,
//! `bun build`, sqlite and every data native. The host (web/src/engine-host.js)
//! runs the JS polyfills and user code natively and calls the natives through
//! these exports:
//!
//! - `bunwasm_ready() -> i32`: 1 once `_start` set up a program to run (it
//!   then returns normally instead of exiting).
//! - `bunwasm_alloc(len) -> ptr`: a buffer for an encoded argument list.
//! - `bunwasm_call(index, ptr, len) -> i32`: run native `index` (from
//!   `bunwasm_describe`) on the encoded arguments (the buffer is consumed);
//!   0 = ok, 1 = it threw. The encoded result (or error) is then at
//!   `bunwasm_result_ptr()` / `bunwasm_result_len()`.
//! - `bunwasm_describe()`: like a call; the result describes the natives,
//!   constants and the entry point.
//!
//! Values are encoded with [`encode`]/[`decode`] (the host has the mirror
//! image): one tag byte, then the payload, little-endian.

use std::cell::RefCell;
use std::rc::Rc;

use crate::engine::{Args, DataFn, NativeError, Record, Val};
use crate::modules;
use crate::natives::Table;
use crate::resolve::{self, Kind, Resolved};
use crate::{Entry, State};

const T_UNDEFINED: u8 = 0;
const T_NULL: u8 = 1;
const T_FALSE: u8 = 2;
const T_TRUE: u8 = 3;
const T_NUM: u8 = 4;
const T_STR: u8 = 5;
const T_BYTES: u8 = 6;
const T_ARRAY: u8 = 7;
const T_OBJECT: u8 = 8;
const T_BIGINT: u8 = 9;
const T_BIGUINT: u8 = 10;

pub fn encode(v: &Val, out: &mut Vec<u8>) {
    let len = |out: &mut Vec<u8>, n: usize| out.extend((n as u32).to_le_bytes());
    match v {
        Val::Undefined => out.push(T_UNDEFINED),
        Val::Null => out.push(T_NULL),
        Val::Bool(false) => out.push(T_FALSE),
        Val::Bool(true) => out.push(T_TRUE),
        Val::Num(n) => {
            out.push(T_NUM);
            out.extend(n.to_le_bytes());
        }
        Val::BigInt(n) => {
            out.push(T_BIGINT);
            out.extend(n.to_le_bytes());
        }
        Val::BigUint(n) => {
            out.push(T_BIGUINT);
            out.extend(n.to_le_bytes());
        }
        Val::Str(s) => {
            out.push(T_STR);
            len(out, s.len());
            out.extend(s.as_bytes());
        }
        Val::Bytes(b) => {
            out.push(T_BYTES);
            len(out, b.len());
            out.extend(b);
        }
        Val::Array(items) => {
            out.push(T_ARRAY);
            len(out, items.len());
            for item in items {
                encode(item, out);
            }
        }
        Val::Object(fields) => {
            out.push(T_OBJECT);
            len(out, fields.len());
            for (k, item) in fields {
                len(out, k.len());
                out.extend(k.as_bytes());
                encode(item, out);
            }
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let end = (self.pos + n).min(self.bytes.len());
        let s = &self.bytes[self.pos..end];
        self.pos = end;
        s
    }
    fn u32(&mut self) -> usize {
        let s = self.take(4);
        let mut b = [0u8; 4];
        b[..s.len()].copy_from_slice(s);
        u32::from_le_bytes(b) as usize
    }
    fn eight(&mut self) -> [u8; 8] {
        let s = self.take(8);
        let mut b = [0u8; 8];
        b[..s.len()].copy_from_slice(s);
        b
    }
    fn string(&mut self) -> String {
        let n = self.u32();
        String::from_utf8_lossy(self.take(n)).into_owned()
    }
    fn val(&mut self) -> Val {
        let tag = self.take(1).first().copied().unwrap_or(T_UNDEFINED);
        match tag {
            T_NULL => Val::Null,
            T_FALSE => Val::Bool(false),
            T_TRUE => Val::Bool(true),
            T_NUM => Val::Num(f64::from_le_bytes(self.eight())),
            T_BIGINT => Val::BigInt(i64::from_le_bytes(self.eight())),
            T_BIGUINT => Val::BigUint(u64::from_le_bytes(self.eight())),
            T_STR => Val::Str(self.string()),
            T_BYTES => {
                let n = self.u32();
                Val::Bytes(self.take(n).to_vec())
            }
            T_ARRAY => {
                let n = self.u32();
                Val::Array((0..n).map(|_| self.val()).collect())
            }
            T_OBJECT => {
                let n = self.u32();
                Val::Object((0..n).map(|_| (self.string(), self.val())).collect())
            }
            _ => Val::Undefined,
        }
    }
}

pub fn decode(bytes: &[u8]) -> Val {
    Reader { bytes, pos: 0 }.val()
}

struct Host {
    functions: Vec<(&'static str, DataFn)>,
    constants: Vec<(&'static str, Val)>,
    entry: Val,
}

thread_local! {
    static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Set the program up for the host to run; `_start` then returns.
pub(crate) fn init(entry: Entry, state: Rc<State>, main_path: String) -> i32 {
    let mut table = crate::natives::table(&state);
    install_host_natives(&mut table, &state);
    let entry = match &entry {
        Entry::File(_) => Record::new().set("kind", "file").set("main", main_path),
        Entry::Eval(code) => {
            let (name, _) = modules::eval_entry(&state, code);
            Record::new().set("kind", "eval").set("main", name)
        }
        Entry::Test(args) => Record::new()
            .set("kind", "test")
            .set("main", main_path)
            .set(
                "args",
                Val::Array(args.iter().map(|a| Val::from(a.as_str())).collect()),
            ),
    };
    let host = Host {
        functions: table.functions,
        constants: table.constants,
        entry: entry.into(),
    };
    HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
    0
}

fn host() -> Rc<Host> {
    HOST.with(|h| h.borrow().clone()).expect("bunwasm_ready")
}

fn set_result(v: &Val) {
    RESULT.with(|r| {
        let mut r = r.borrow_mut();
        r.clear();
        encode(v, &mut r);
    });
}

fn error_val(err: &NativeError) -> Val {
    let kind = match err.kind {
        crate::engine::ErrorKind::Error => "Error",
        crate::engine::ErrorKind::TypeError => "TypeError",
        crate::engine::ErrorKind::RangeError => "RangeError",
        crate::engine::ErrorKind::SyntaxError => "SyntaxError",
    };
    Record::new()
        .set("kind", kind)
        .set("message", err.message.as_str())
        .set("name", err.name.clone())
        .set("props", Val::Object(err.props.clone()))
        .into()
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_ready() -> i32 {
    HOST.with(|h| i32::from(h.borrow().is_some()))
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_alloc(len: u32) -> *mut u8 {
    let mut buf = vec![0u8; len as usize].into_boxed_slice();
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_result_len() -> u32 {
    RESULT.with(|r| r.borrow().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_describe() -> i32 {
    let h = host();
    let names = Val::Array(h.functions.iter().map(|(n, _)| Val::from(*n)).collect());
    let constants = Val::Object(
        h.constants
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    );
    set_result(
        &Record::new()
            .set("natives", names)
            .set("constants", constants)
            .set("entry", h.entry.clone())
            .into(),
    );
    0
}

/// # Safety
/// `ptr`/`len` must come from `bunwasm_alloc(len)`; the buffer is freed here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bunwasm_call(index: u32, ptr: *mut u8, len: u32) -> i32 {
    // SAFETY: allocated by bunwasm_alloc with exactly this length.
    let input = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len as usize)) };
    let args = match decode(&input) {
        Val::Array(items) => items,
        other => vec![other],
    };
    drop(input);
    let f = host().functions.get(index as usize).map(|(_, f)| f.clone());
    let Some(f) = f else {
        set_result(&error_val(&NativeError::error(format!(
            "bun-wasm: no native #{index}"
        ))));
        return 1;
    };
    match f(Args(&args)) {
        Ok(v) => {
            set_result(&v);
            0
        }
        Err(err) => {
            set_result(&error_val(&err));
            1
        }
    }
}

/// Natives only the host engine needs: module sources ready for the host's
/// native ES module loader, CommonJS wrappers, polyfill sources.
fn install_host_natives(t: &mut Table, state: &Rc<State>) {
    let st = state.clone();
    t.add("hostModuleSource", move |a| module_source(&st, a.str(0)?));
    let st = state.clone();
    t.add("hostCjsSource", move |a| {
        let path = a.str(0)?;
        let (code, _) = st.load_source(path)?;
        let (wrapped, first_line) = modules::cjs_wrapper(&host_dynamic_imports(
            &code,
            path,
            &st.host_imports(path, &code)?,
        ));
        // Our wrapper's two header lines sit above the file's line 1.
        if first_line == -1 {
            st.record_line_offset(path, 2);
        }
        Ok(Val::Str(wrapped))
    });
    let st = state.clone();
    t.add("hostEsmAsCjs", move |a| {
        let path = a.str(0)?;
        let out = st.esm_as_cjs(path)?;
        Ok(host_dynamic_imports(&out.code, path, &out.imports).into())
    });
    t.add("polyfillSource", |a| {
        Ok(modules::polyfill_source(a.str(0)?).map(Val::from).into())
    });
    let st = state.clone();
    t.add("flushOutput", move |_| {
        st.flush();
        Ok(Val::Undefined)
    });
}

/// `import(...)` in code evaluated as a script (CommonJS) goes through the
/// host's dynamic-import hook, like in ES modules (engine-host.js): the
/// engine would resolve it against the host's own URL.
fn host_dynamic_imports(
    code: &str,
    from: &str,
    imports: &[crate::transpiler::ModuleImport],
) -> String {
    use crate::transpiler::ModuleImportKind;
    let spans: Vec<_> = imports
        .iter()
        .filter(|s| matches!(s.kind, ModuleImportKind::Dynamic))
        .collect();
    if spans.is_empty() {
        return code.to_owned();
    }
    let hook = format!("globalThis.__bunwasm_dynamicImport({})", json_string(from));
    let mut out = String::with_capacity(code.len() + spans.len() * hook.len());
    let mut at = 0;
    for span in spans {
        out.push_str(&code[at..span.start]);
        out.push_str(&hook);
        at = span.end;
    }
    out.push_str(&code[at..]);
    out
}

fn json_string(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The ES module a file becomes: `{format, code, imports}`. For ES modules,
/// `code` has the prologue (import.meta set-up, require/__dirname) and
/// `imports` lists `[start, end, key, kind]` spans of the code to replace:
/// kind "static" spans are a specifier string literal (key: the resolved
/// module, or null with `error` when it doesn't resolve), "dynamic" spans
/// the `import` keyword of an `import(...)` call. Other formats only report
/// the format; the host builds a wrapper module for them.
fn module_source(state: &Rc<State>, path: &str) -> Result<Val, NativeError> {
    if resolve::builtin_name(path).is_some() {
        return Ok(Record::new().set("format", "builtin").into());
    }
    let (code, format) = state.load_source(path)?;
    if format != modules::Format::Esm {
        return Ok(Record::new().set("format", format.name()).into());
    }
    let meta = format!("globalThis.__bunwasm_meta(import.meta, {path:?}); ");
    let source = modules::esm_source_with(state, path, &code, &meta);
    let mut imports = Vec::new();
    use crate::transpiler::ModuleImportKind;
    let offset = source.len() - code.len();
    for span in state.host_imports(path, &code)?.iter() {
        let mut rec = Record::new()
            .set("start", (span.start + offset) as f64)
            .set("end", (span.end + offset) as f64);
        let specifier = match &span.kind {
            ModuleImportKind::Dynamic => {
                rec.push("kind", "dynamic");
                imports.push(rec.into());
                continue;
            }
            ModuleImportKind::Static(specifier) => specifier,
        };
        rec.push("kind", "static");
        match state.resolver.resolve(specifier, path, Kind::Import) {
            Ok(Resolved::Builtin(b)) => rec.push("key", b),
            Ok(Resolved::File(f)) => rec.push("key", f),
            Err(msg) => {
                rec.push("key", Val::Null);
                rec.push("error", msg);
            }
        }
        imports.push(rec.into());
    }
    Ok(Record::new()
        .set("format", "esm")
        .set("code", source)
        .set("imports", Val::Array(imports))
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_roundtrip() {
        let v = Val::Array(vec![
            Val::Str("héllo".into()),
            Val::Num(-1.5),
            Val::Bytes(vec![0, 255]),
            Val::Object(vec![("k".into(), Val::BigInt(-5)), ("u".into(), Val::Null)]),
            Val::Bool(true),
            Val::Undefined,
        ]);
        let mut out = Vec::new();
        encode(&v, &mut out);
        assert_eq!(decode(&out), v);
    }
}
