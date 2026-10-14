//! ES module loading (QuickJS resolver/loader hooks), CommonJS compilation,
//! and the embedded JS polyfills.
//!
//! Every non-ESM module (built-ins, CommonJS, JSON, text) is exposed to ESM
//! importers through a tiny generated wrapper module that re-exports the keys
//! of an object handed over through the wrapper's `import.meta.m`.

use std::rc::Rc;

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{Ctx, Function, Module, Object, Result, Value};

use crate::natives;
use crate::resolve::{self, Kind, Resolved};
use crate::transpiler::Loader as SourceLoader;
use crate::State;

include!(concat!(env!("OUT_DIR"), "/polyfills.rs"));

/// Bun's transpiler emits CommonJS modules already wrapped in this function
/// expression (that is how it reports a file is CommonJS).
const CJS_WRAPPER_PREFIX: &str = "(function(exports, require, module, __filename, __dirname) {";

/// How positions in the code QuickJS evaluated map to the file on disk.
#[derive(Default)]
pub struct PositionMap {
    /// Source map from transpiled to original code.
    pub map: Option<crate::sourcemap::SourceMap>,
    /// Original source, for error excerpts (only kept when mapped).
    pub original: Option<Rc<str>>,
    /// Characters injected at the start of line 1 (the ESM prologue).
    pub line1_shift: u32,
}

impl PositionMap {
    /// Original 1-based (line, column) for a position in evaluated code.
    pub fn original_position(&self, line: u32, col: u32) -> (u32, u32) {
        let col = if line == 1 { col.saturating_sub(self.line1_shift).max(1) } else { col };
        match &self.map {
            Some(map) => map.lookup(line, col).unwrap_or((line, col)),
            None => (line, col),
        }
    }
}

/// What kind of module a file is, once transpiled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Esm,
    Cjs,
    Json,
    Text,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Esm => "esm",
            Format::Cjs => "cjs",
            Format::Json => "json",
            Format::Text => "text",
        }
    }
}

pub fn throw_resolve_error(ctx: &Ctx<'_>, msg: &str, spec: &str, kind: Kind) -> rquickjs::Error {
    let exception = match natives::new_error(ctx, msg) {
        Ok(e) => e,
        Err(e) => return e,
    };
    let obj = exception.as_object();
    // require() and import report different codes, like Node and Bun.
    let code = if kind == Kind::Require { "MODULE_NOT_FOUND" } else { "ERR_MODULE_NOT_FOUND" };
    let _ = obj.set("code", code);
    let _ = obj.set("specifier", spec);
    exception.throw()
}

fn throw_error(ctx: &Ctx<'_>, msg: &str) -> rquickjs::Error {
    natives::throw_error(ctx, msg)
}

/// A transpiler failure, reported like Bun's build errors: the offending
/// source line, a caret, `error: message` and the location. The transpiler
/// formats each error as `file:line:col: message`.
fn throw_build_error(ctx: &Ctx<'_>, report: &str, source: &str) -> rquickjs::Error {
    let mut text = String::new();
    let mut first_message = None;
    for entry in report.lines().filter(|l| !l.trim().is_empty()) {
        let Some((file, line, col, message)) = parse_location(entry) else {
            text.push_str(&format!("error: {entry}\n"));
            first_message.get_or_insert_with(|| entry.to_owned());
            continue;
        };
        first_message.get_or_insert_with(|| message.to_owned());
        if let Some(code) = source.lines().nth(line.saturating_sub(1)) {
            let gutter = format!("{line} | ");
            text.push_str(&format!("{gutter}{code}\n{}^\n", " ".repeat(gutter.len() + col.saturating_sub(1))));
        }
        text.push_str(&format!("error: {message}\n    at {file}:{line}:{col}\n\n"));
    }
    let message = first_message.unwrap_or_else(|| report.trim().to_owned());
    let exception = match natives::new_error(ctx, &message) {
        Ok(e) => e,
        Err(e) => return e,
    };
    let _ = exception.as_object().set("name", "BuildError");
    let _ = exception.as_object().set("__bunwasmFormatted", text);
    exception.throw()
}

/// Split `file:line:col: message`.
fn parse_location(entry: &str) -> Option<(&str, usize, usize, &str)> {
    let (location, message) = entry.split_once(": ")?;
    let mut parts = location.rsplitn(3, ':');
    let col = parts.next()?.parse().ok()?;
    let line = parts.next()?.parse().ok()?;
    let file = parts.next()?;
    Some((file, line, col, message))
}

/// Lines that start an ES module statement. Crude, but the real transpiler
/// can replace this later; comments/strings starting with these are rare.
fn has_esm_syntax(source: &str) -> bool {
    if source.contains("import.meta") {
        return true;
    }
    source.lines().any(|line| {
        let t = line.trim_start();
        let rest = t.strip_prefix("import").or_else(|| t.strip_prefix("export"));
        let Some(rest) = rest else { return false };
        // `import(` is a dynamic import, valid in scripts.
        matches!(rest.chars().next(), Some(' ' | '{' | '*' | '"' | '\'' | '\t'))
    })
}

/// Top-level `await` outside any function forces ESM. Heuristic: an
/// unindented line using `await`.
fn has_top_level_await(source: &str) -> bool {
    source
        .lines()
        .any(|line| !line.starts_with([' ', '\t', '}', ')', '/', '*']) && line.contains("await "))
}

fn declares(source: &str, name: &str) -> bool {
    ["const ", "let ", "var ", "function ", "class "]
        .iter()
        .any(|kw| source.contains(&format!("{kw}{name}")) && declares_exactly(source, kw, name))
}

fn declares_exactly(source: &str, kw: &str, name: &str) -> bool {
    let needle = format!("{kw}{name}");
    source.match_indices(&needle).any(|(i, _)| {
        let next = source[i + needle.len()..].chars().next();
        !matches!(next, Some(c) if c.is_alphanumeric() || c == '_' || c == '$')
    })
}

fn uses_identifier(source: &str, name: &str) -> bool {
    source.match_indices(name).any(|(i, _)| {
        let before = source[..i].chars().next_back();
        let after = source[i + name.len()..].chars().next();
        let ident = |c: Option<char>| matches!(c, Some(c) if c.is_alphanumeric() || c == '_' || c == '$');
        !ident(before) && !ident(after) && before != Some('.')
    })
}

/// A shebang line is not valid JS; blank it out but keep the line.
fn strip_shebang(source: &str) -> String {
    if source.starts_with("#!") {
        format!("//{}", &source[2..])
    } else {
        source.to_owned()
    }
}

/// Bun lets ES modules use `require`, `__dirname` and `__filename`. Define
/// them on line 1 (no newline) so line numbers stay intact.
fn esm_prologue(source: &str) -> String {
    let mut prologue = String::new();
    let bindings = [
        ("require", "import.meta.require"),
        ("__dirname", "import.meta.dir"),
        ("__filename", "import.meta.path"),
    ];
    for (name, value) in bindings {
        if uses_identifier(source, name) && !declares(source, name) {
            prologue.push_str(&format!("const {name} = {value}; "));
        }
    }
    prologue
}

impl State {
    /// Read, transpile and classify a file. Results are cached.
    pub fn load_source(&self, ctx: &Ctx<'_>, path: &str) -> Result<(Rc<str>, Format)> {
        if let Some(hit) = self.sources.borrow().get(path) {
            return Ok(hit.clone());
        }
        let raw = std::fs::read(path).map_err(|e| crate::natives::throw_io(ctx, e, "open", Some(path)))?;
        let raw = String::from_utf8(raw).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        let loader = SourceLoader::from_path(path);
        let (code, format) = match loader {
            SourceLoader::Json => (raw, Format::Json),
            SourceLoader::Text => (raw, Format::Text),
            _ => {
                let out = self
                    .transpiler
                    .transpile_with_map(&raw, path, loader)
                    .map_err(|msg| throw_build_error(ctx, &msg, &raw))?;
                let format = self.detect_format(path, &out.code);
                if let Some(mappings) = out.mappings.filter(|m| !m.is_empty()) {
                    let mut positions = self.positions.borrow_mut();
                    let entry = positions.entry(path.to_owned()).or_default();
                    entry.map = Some(crate::sourcemap::SourceMap::parse(&mappings));
                    entry.original = Some(Rc::from(raw.as_str()));
                }
                (out.code, format)
            }
        };
        let entry: (Rc<str>, Format) = (Rc::from(strip_shebang(&code)), format);
        self.sources.borrow_mut().insert(path.to_owned(), entry.clone());
        Ok(entry)
    }

    fn detect_format(&self, path: &str, code: &str) -> Format {
        if code.starts_with(CJS_WRAPPER_PREFIX) {
            return Format::Cjs;
        }
        if path.ends_with(".mjs") || path.ends_with(".mts") {
            return Format::Esm;
        }
        if path.ends_with(".cjs") || path.ends_with(".cts") {
            return Format::Cjs;
        }
        if has_esm_syntax(code) || has_top_level_await(code) {
            return Format::Esm;
        }
        // `"type": "module"` makes even syntax-free files ESM.
        match self.resolver.package_type_is_module(path) {
            Some(true) => Format::Esm,
            _ => Format::Cjs,
        }
    }

    pub fn source_line(&self, file: &str, line: usize) -> Option<String> {
        if let Some(original) = self.positions.borrow().get(file).and_then(|p| p.original.clone()) {
            return original.lines().nth(line.checked_sub(1)?).map(str::to_owned);
        }
        let sources = self.sources.borrow();
        let (code, _) = sources.get(file)?;
        code.lines().nth(line.checked_sub(1)?).map(str::to_owned)
    }

    /// Original position for a stack frame, if the file needs any fixup.
    pub fn map_position(&self, file: &str, line: u32, col: u32) -> Option<(u32, u32)> {
        let positions = self.positions.borrow();
        Some(positions.get(file)?.original_position(line, col))
    }

    /// Remember that `len` characters were injected before line 1 of `path`.
    fn record_prologue(&self, path: &str, len: usize) {
        if len == 0 {
            return;
        }
        self.positions.borrow_mut().entry(path.to_owned()).or_default().line1_shift = len as u32;
    }

    fn internal<'js>(&self, ctx: &Ctx<'js>) -> Result<Object<'js>> {
        let saved = self.internal.borrow().clone().ok_or(rquickjs::Error::Unknown)?;
        saved.restore(ctx)
    }
}

pub fn module_format(ctx: &Ctx<'_>, state: &State, path: &str) -> Result<&'static str> {
    state.load_source(ctx, path).map(|(_, f)| f.name())
}

/// Compile a CommonJS file into `function (exports, require, module, __filename, __dirname)`.
pub fn compile_cjs<'js>(ctx: &Ctx<'js>, state: &State, path: &str) -> Result<Function<'js>> {
    let (code, _) = state.load_source(ctx, path)?;
    // Already wrapped by Bun's transpiler (its lines follow the printed code).
    if code.starts_with(CJS_WRAPPER_PREFIX) {
        return eval_script_at(ctx, &code, path, 1)?.get();
    }
    // Our wrapper takes lines -1 and 0 (QuickJS treats a start line of 0 as
    // "default"), so the file's own lines and columns are unchanged in stack
    // traces.
    let wrapped = format!("(function (exports, require, module, __filename, __dirname) {{\n\n{code}\n}})");
    eval_script_at(ctx, &wrapped, path, -1)?.get()
}

/// Evaluate a classic script whose first line is numbered `first_line`.
fn eval_script_at<'js>(ctx: &Ctx<'js>, source: &str, filename: &str, first_line: i32) -> Result<Value<'js>> {
    use rquickjs::qjs;
    let c_source = std::ffi::CString::new(source)?;
    let c_filename = std::ffi::CString::new(filename)?;
    let mut options = qjs::JSEvalOptions {
        version: qjs::JS_EVAL_OPTIONS_VERSION as i32,
        eval_flags: qjs::JS_EVAL_TYPE_GLOBAL as i32,
        filename: c_filename.as_ptr(),
        line_num: first_line,
    };
    // SAFETY: the source is NUL-terminated as JS_Eval2 requires; the result is
    // a new reference (or JS_EXCEPTION with the exception left on the context).
    unsafe {
        let raw = qjs::JS_Eval2(ctx.as_raw().as_ptr(), c_source.as_ptr(), source.len() as _, &mut options);
        if qjs::JS_IsException(raw) {
            return Err(rquickjs::Error::Exception);
        }
        Ok(Value::from_raw(ctx.clone(), raw))
    }
}

/// `require()` of an ES module: import it and run the job queue until it
/// settles. Modules waiting on timers (top-level await) can't be required.
pub fn require_esm<'js>(ctx: &Ctx<'js>, state: &State, path: &str) -> Result<Value<'js>> {
    let promise = Module::import(ctx, path)?;
    use rquickjs::promise::PromiseState;
    while promise.state() == PromiseState::Pending {
        if !state.drain_jobs(ctx) {
            break;
        }
    }
    match promise.state() {
        PromiseState::Resolved => Ok(promise_result(ctx, &promise)),
        PromiseState::Rejected => Err(ctx.throw(promise_result(ctx, &promise))),
        PromiseState::Pending => Err(throw_error(
            ctx,
            &format!("require() async module \"{path}\" is unsupported. use \"await import()\" instead."),
        )),
    }
}

/// Fulfillment value or rejection reason of a settled promise.
pub fn promise_result<'js>(ctx: &Ctx<'js>, promise: &rquickjs::Promise<'js>) -> Value<'js> {
    // SAFETY: JS_PromiseResult returns a new reference we take ownership of.
    unsafe {
        let raw = rquickjs::qjs::JS_PromiseResult(ctx.as_raw().as_ptr(), promise.as_value().as_raw());
        Value::from_raw(ctx.clone(), raw)
    }
}

pub fn load_polyfill<'js>(ctx: &Ctx<'js>, name: &str) -> Result<Value<'js>> {
    let Some((_, source)) = POLYFILLS.iter().find(|(n, _)| *n == name) else {
        return Err(throw_error(ctx, &format!("bun-wasm: missing internal module {name}")));
    };
    let mut opts = rquickjs::context::EvalOptions::default();
    opts.global = true;
    opts.strict = false;
    opts.filename = Some(format!("bun-wasm:{name}"));
    ctx.eval_with_options(*source, opts)
}

pub fn run_bootstrap<'js>(ctx: &Ctx<'js>, native: Object<'js>) -> Result<Object<'js>> {
    let factory: Function = load_polyfill(ctx, "bootstrap")?.get()?;
    factory.call((native,))
}

fn is_plain_identifier(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// Wrapper ESM source re-exporting `import.meta.m` (default) and its keys.
fn wrapper_source(keys: &[String]) -> String {
    let mut src = String::from("const m = import.meta.m.value; export default import.meta.m.default;\n");
    let mut exports = Vec::new();
    for (i, key) in keys.iter().enumerate() {
        if key == "default" || key == "__esModule" || !is_plain_identifier(key) {
            continue;
        }
        src.push_str(&format!("const e{i} = m[{key:?}];\n"));
        exports.push(format!("e{i} as {key:?}"));
    }
    if !exports.is_empty() {
        src.push_str(&format!("export {{ {} }};\n", exports.join(", ")));
    }
    src
}

fn declare_wrapper<'js>(ctx: &Ctx<'js>, name: &str, value: Value<'js>, default: Value<'js>) -> Result<Module<'js, Declared>> {
    let keys: Vec<String> = match value.as_object() {
        Some(obj) => obj.keys::<String>().collect::<Result<_>>()?,
        None => Vec::new(),
    };
    let module = Module::declare(ctx.clone(), name, wrapper_source(&keys))?;
    let handoff = Object::new(ctx.clone())?;
    handoff.set("value", value)?;
    handoff.set("default", default)?;
    module.meta()?.set("m", handoff)?;
    Ok(module)
}

pub struct ModuleResolver {
    pub state: Rc<State>,
}

impl Resolver for ModuleResolver {
    fn resolve<'js>(&mut self, ctx: &Ctx<'js>, base: &str, name: &str, _: Option<ImportAttributes<'js>>) -> Result<String> {
        let from = if base.is_empty() || base.starts_with("node:") || base.starts_with("bun") {
            format!("{}/", self.state.cwd())
        } else {
            base.to_owned()
        };
        match self.state.resolver.resolve(name, &from, Kind::Import) {
            Ok(Resolved::Builtin(b)) => Ok(b),
            Ok(Resolved::File(f)) => Ok(f),
            Err(msg) => Err(throw_resolve_error(ctx, &msg, name, Kind::Import)),
        }
    }
}

pub struct ModuleLoader {
    pub state: Rc<State>,
}

impl Loader for ModuleLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str, _: Option<ImportAttributes<'js>>) -> Result<Module<'js, Declared>> {
        let internal = self.state.internal(ctx)?;
        if resolve::builtin_name(name).is_some() {
            let builtin: Function = internal.get("builtin")?;
            let exports: Value = builtin.call((name,))?;
            return declare_wrapper(ctx, name, exports.clone(), exports);
        }
        let (code, format) = self.state.load_source(ctx, name)?;
        match format {
            Format::Esm => {
                let prologue = esm_prologue(&code);
                self.state.record_prologue(name, prologue.chars().count());
                let source = format!("{prologue}{code}");
                let module = Module::declare(ctx.clone(), name, source)?;
                let init: Function = internal.get("initImportMeta")?;
                let is_main = *self.state.main.borrow() == name;
                init.call::<_, ()>((module.meta()?, name, is_main))?;
                Ok(module)
            }
            Format::Cjs | Format::Json | Format::Text => {
                // The JS side evaluates it (sharing require's cache) and
                // returns [namespaceObject, defaultExport].
                let import_cjs: Function = internal.get("importNonEsm")?;
                let pair: rquickjs::Array = import_cjs.call((name, format.name()))?;
                declare_wrapper(ctx, name, pair.get(0)?, pair.get(1)?)
            }
        }
    }
}

/// Declare and evaluate `-e` code as an ES module named `<cwd>/[eval]`.
pub fn eval_main<'js>(ctx: &Ctx<'js>, state: &State, code: &str) -> Result<rquickjs::Promise<'js>> {
    let name = format!("{}/[eval]", state.cwd().trim_end_matches('/'));
    let prologue = esm_prologue(code);
    state.record_prologue(&name, prologue.chars().count());
    let source = format!("{prologue}{code}");
    state
        .sources
        .borrow_mut()
        .insert(name.clone(), (Rc::from(code), Format::Esm));
    let module = Module::declare(ctx.clone(), name.clone(), source)?;
    let internal = state.internal(ctx)?;
    let init: Function = internal.get("initImportMeta")?;
    init.call::<_, ()>((module.meta()?, name, true))?;
    let (_, promise) = module.eval()?;
    Ok(promise)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection() {
        assert!(has_esm_syntax("import x from 'y'"));
        assert!(has_esm_syntax("  export const a = 1"));
        assert!(!has_esm_syntax("const x = import('y')"));
        assert!(!has_esm_syntax("module.exports = 1"));
        assert!(has_top_level_await("await foo()"));
        assert!(!has_top_level_await("async function f() {\n  await x;\n}"));
        assert!(uses_identifier("require('x')", "require"));
        assert!(!uses_identifier("import.meta.require('x')", "require"));
        assert!(declares("const require = createRequire(1)", "require"));
        assert!(!declares("const requireX = 1", "require"));
    }
}
