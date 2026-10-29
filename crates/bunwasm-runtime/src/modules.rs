//! Module sources: reading, transpiling and classifying files, the
//! CommonJS wrapper, the ESM prologue, wrapper modules for non-ES modules,
//! and the embedded JS polyfills. Engine-agnostic; the engine-facing glue is
//! the linked engine program's `ModuleHost` implementation.
//!
//! Every non-ESM module (built-ins, CommonJS, JSON, text) is exposed to ESM
//! importers through a tiny generated wrapper module that re-exports the keys
//! of an object handed over through the wrapper's `import.meta.m`.

#[path = "next_swc.rs"]
mod next_swc;

use std::io::Read as _;
use std::rc::Rc;

use crate::State;
use crate::data::NativeError;
use crate::resolve::Kind;
use crate::transpiler::Loader as SourceLoader;

include!(concat!(env!("OUT_DIR"), "/polyfills.rs"));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/generated/builtins/registry.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/generated/builtins/bindings.rs"
));

pub fn bun_builtin_source(id: usize) -> Option<&'static str> {
    BUN_BUILTINS
        .iter()
        .find(|(index, _)| *index == id)
        .map(|(_, source)| *source)
}

/// Bun's transpiler emits CommonJS modules already wrapped in this function
/// expression (that is how it reports a file is CommonJS).
pub const CJS_WRAPPER_PREFIX: &str = "(function(exports, require, module, __filename, __dirname) {";
const CJS_META_WRAPPER_PREFIX: &str =
    "(function(exports, require, module, __filename, __dirname, $Bun_import_meta) {";

fn is_cjs_wrapper(code: &str) -> bool {
    code.starts_with(CJS_WRAPPER_PREFIX) || code.starts_with(CJS_META_WRAPPER_PREFIX)
}

/// How positions in the code the engine evaluated map to the file on disk.
#[derive(Default)]
pub struct PositionMap {
    /// Source map from transpiled to original code.
    pub map: Option<crate::sourcemap::SourceMap>,
    /// Original source, for error excerpts (only kept when mapped).
    pub original: Option<Rc<str>>,
    /// Characters injected at the start of line 1 (the ESM prologue).
    pub line1_shift: u32,
    /// Lines injected above the file's line 1 (the host engine's CommonJS
    /// wrapper, which can't start at line -1).
    pub line_offset: u32,
}

impl PositionMap {
    /// Original 1-based (line, column) for a position in evaluated code.
    pub fn original_position(&self, line: u32, col: u32) -> (u32, u32) {
        let line = if line > self.line_offset {
            line - self.line_offset
        } else {
            line
        };
        let col = if line == 1 {
            col.saturating_sub(self.line1_shift).max(1)
        } else {
            col
        };
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
    Html,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Esm => "esm",
            Format::Cjs => "cjs",
            Format::Json => "json",
            Format::Text => "text",
            Format::Html => "html",
        }
    }
}

pub fn resolve_error(
    msg: &str,
    spec: &str,
    referrer: &str,
    kind: Kind,
    notes: Vec<crate::resolve::ResolveNote>,
) -> NativeError {
    use crate::data::{Record, Val};
    // require() and import report different codes, like Node and Bun.
    let code = if spec.starts_with("node:") {
        "ERR_UNKNOWN_BUILTIN_MODULE"
    } else if kind == Kind::Require {
        "MODULE_NOT_FOUND"
    } else {
        "ERR_MODULE_NOT_FOUND"
    };
    let mut logs = Vec::new();
    for note in notes {
        let position = Record::new()
            .set("file", note.file)
            .set("lineText", note.line_text)
            .set("line", note.line as u32)
            .set("column", note.column as u32);
        logs.push(
            Record::new()
                .set("message", note.message)
                .set("position", position)
                .into(),
        );
    }
    let import_kind = if kind == Kind::Require {
        "require-call"
    } else {
        "import-statement"
    };
    NativeError::error(msg)
        .named("ResolveMessage")
        .prop("code", code)
        .prop("specifier", spec)
        .prop("referrer", referrer)
        .prop("level", "error")
        .prop("importKind", import_kind)
        .prop("position", Val::Null)
        .prop("line", 0u32)
        .prop("column", 0u32)
        .prop("notes", Val::Array(logs))
}

/// A transpiler failure, reported like Bun's build errors: the offending
/// source line, a caret, `error: message` and the location. The transpiler
/// formats each error as `file:line:col: message`.
fn build_error(report: &str, source: &str) -> NativeError {
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
            text.push_str(&format!(
                "{gutter}{code}\n{}^\n",
                " ".repeat(gutter.len() + col.saturating_sub(1))
            ));
        }
        text.push_str(&format!("error: {message}\n    at {file}:{line}:{col}\n\n"));
    }
    let message = first_message.unwrap_or_else(|| report.trim().to_owned());
    NativeError::error(message)
        .prop("name", "BuildError")
        .prop("__bunwasmFormatted", text)
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
        let rest = t
            .strip_prefix("import")
            .or_else(|| t.strip_prefix("export"));
        let Some(rest) = rest else { return false };
        // `import(` is a dynamic import, valid in scripts.
        matches!(
            rest.chars().next(),
            Some(' ' | '{' | '*' | '"' | '\'' | '\t')
        )
    })
}

/// Top-level `await` outside any function forces ESM. Heuristic: an
/// unindented line using `await`.
fn has_top_level_await(source: &str) -> bool {
    source
        .lines()
        .any(|line| !line.starts_with([' ', '\t', '}', ')', '/', '*']) && line.contains("await "))
}

/// Whether `source` binds `name` itself, so the prologue must not declare it
/// again. Heuristic over the transpiled text: `const name`, `function name`,
/// …, plus the forms Bun's printer produces when it merges declarations
/// (`const a = 1, name = …`) or destructures (`const { name } = …`), and
/// imports (`import { name }`, `import name from`). A false positive only
/// skips the prologue binding.
fn declares(source: &str, name: &str) -> bool {
    let simple = ["const ", "let ", "var ", "function ", "class ", "import "]
        .iter()
        .any(|kw| source.contains(&format!("{kw}{name}")) && declares_exactly(source, kw, name));
    simple || identifier_positions(source, name).any(|i| declared_at(source, i, name.len()))
}

/// `name` at byte `i` is a declarator in a list or pattern: preceded by `,`
/// `{` or `[` and followed by `=` (not `==`/`=>`), `,`, `}`, `]` or `;`, inside a
/// `const`/`let`/`var`/`import` statement.
fn declared_at(source: &str, i: usize, len: usize) -> bool {
    let before = source[..i].trim_end();
    let after = source[i + len..].trim_start();
    if !before.ends_with([',', '{', '[']) {
        return false;
    }
    let follows = after.starts_with([',', '}', ']', ';'])
        || (after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>"));
    if !follows {
        return false;
    }
    // The statement this sits in starts with a declaration keyword.
    let start = before.rfind([';', '\n']).map_or(0, |at| at + 1);
    let statement = before[start..].trim_start();
    ["const ", "let ", "var ", "import "]
        .iter()
        .any(|kw| statement.starts_with(kw))
}

fn identifier_positions<'a>(source: &'a str, name: &'a str) -> impl Iterator<Item = usize> + 'a {
    let ident =
        |c: Option<char>| matches!(c, Some(c) if c.is_alphanumeric() || c == '_' || c == '$');
    source
        .match_indices(name)
        .map(|(i, _)| i)
        .filter(move |&i| {
            let before = source[..i].chars().next_back();
            !ident(before) && !ident(source[i + name.len()..].chars().next()) && before != Some('.')
        })
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
        let ident =
            |c: Option<char>| matches!(c, Some(c) if c.is_alphanumeric() || c == '_' || c == '$');
        !ident(before) && !ident(after) && before != Some('.')
    })
}

/// A shebang line is not valid JS; blank it out but keep the line.
fn strip_shebang(source: &str) -> String {
    if let Some(stripped) = source.strip_prefix("#!") {
        format!("//{stripped}")
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

fn read_stdin() -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::io::stdin().read_to_end(&mut bytes)?;
    Ok(bytes)
}

impl State {
    /// Read, transpile and classify a file. Results are cached while the
    /// file's content stays the same.
    pub fn load_source(&self, path: &str) -> Result<(Rc<str>, Format), NativeError> {
        let stdin = self.main_arg.borrow().as_str() == "-" && self.main.borrow().as_str() == path;
        if stdin && let Some(hit) = self.sources.borrow().get(path) {
            return Ok(hit.clone());
        }
        let input = if stdin {
            read_stdin()
        } else {
            std::fs::read(path)
        };
        let raw = match input {
            Ok(raw) => raw,
            // A virtual module (`[eval]`) has no file behind it.
            Err(e) => {
                return self
                    .sources
                    .borrow()
                    .get(path)
                    .cloned()
                    .ok_or_else(|| crate::natives::io_error(e, "open", Some(path)));
            }
        };
        self.revalidate(path, &raw);
        if let Some(hit) = self.sources.borrow().get(path) {
            return Ok(hit.clone());
        }
        let raw = String::from_utf8(raw)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        let loader = if stdin {
            SourceLoader::Ts
        } else {
            SourceLoader::from_path(path)
        };
        let (code, format) = match loader {
            SourceLoader::Json => (raw, Format::Json),
            SourceLoader::Text if path.ends_with(".html") => (raw, Format::Html),
            SourceLoader::Text => (raw, Format::Text),
            SourceLoader::Jsonc => {
                let value = if raw.trim().is_empty() {
                    "{}".to_owned()
                } else {
                    format!(
                        "require('bun').JSONC.parse({})",
                        serde_json::to_string(&raw).unwrap()
                    )
                };
                let source = format!("{CJS_WRAPPER_PREFIX} module.exports = {value}; }})");
                (source, Format::Cjs)
            }
            _ => {
                let adapted = next_swc::adapt(&raw, path);
                let out = self
                    .transpiler
                    .transpile_with_map(&adapted, path, loader)
                    .map_err(|msg| build_error(&msg, &raw))?;
                let format = self.detect_format(path, &out.code, out.module_kind);
                #[cfg(feature = "engine-host")]
                self.source_imports
                    .borrow_mut()
                    .insert(path.to_owned(), out.imports.into());
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
        self.sources
            .borrow_mut()
            .insert(path.to_owned(), entry.clone());
        Ok(entry)
    }

    fn detect_format(
        &self,
        path: &str,
        code: &str,
        parsed_kind: Option<crate::transpiler::ModuleKind>,
    ) -> Format {
        if is_cjs_wrapper(code) {
            return Format::Cjs;
        }
        if path.ends_with(".mjs") || path.ends_with(".mts") {
            return Format::Esm;
        }
        if path.ends_with(".cjs") || path.ends_with(".cts") {
            return Format::Cjs;
        }
        use crate::transpiler::ModuleKind;
        match parsed_kind {
            Some(ModuleKind::CommonJs) => return Format::Cjs,
            Some(ModuleKind::Esm) => return Format::Esm,
            None if has_esm_syntax(code) || has_top_level_await(code) => return Format::Esm,
            _ => {}
        }
        // `"type": "module"` makes even syntax-free files ESM.
        match self.resolver.package_type_is_module(path) {
            Some(true) => Format::Esm,
            _ => Format::Cjs,
        }
    }

    pub fn source_line(&self, file: &str, line: usize) -> Option<String> {
        if let Some(original) = self
            .positions
            .borrow()
            .get(file)
            .and_then(|p| p.original.clone())
        {
            return original
                .lines()
                .nth(line.checked_sub(1)?)
                .map(str::to_owned);
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

    /// Remember that `lines` lines were injected above line 1 of `path`.
    #[cfg(feature = "engine-host")]
    pub fn record_line_offset(&self, path: &str, lines: u32) {
        self.positions
            .borrow_mut()
            .entry(path.to_owned())
            .or_default()
            .line_offset = lines;
    }

    /// [`crate::Transpiler::esm_to_cjs`] for `path`, with its source map
    /// recorded unless the file already has one (when it is also imported as
    /// a real ES module, that copy's positions win).
    #[cfg(feature = "engine-host")]
    pub fn esm_as_cjs(&self, path: &str) -> Result<crate::transpiler::Transpiled, NativeError> {
        if let Ok(raw) = std::fs::read(path) {
            self.revalidate(path, &raw);
        }
        if let Some(hit) = self.cjs_sources.borrow().get(path) {
            return Ok(hit.clone());
        }
        let out = self
            .transpiler
            .esm_to_cjs(path)
            .map_err(|msg| build_error(&msg, ""))?;
        if let Some(mappings) = out.mappings.as_ref().filter(|m| !m.is_empty()) {
            let mut positions = self.positions.borrow_mut();
            if !positions.contains_key(path) {
                let original = std::fs::read_to_string(path)
                    .ok()
                    .map(|s| Rc::from(s.as_str()));
                positions.insert(
                    path.to_owned(),
                    PositionMap {
                        map: Some(crate::sourcemap::SourceMap::parse(mappings)),
                        original,
                        ..Default::default()
                    },
                );
            }
        }
        self.cjs_sources
            .borrow_mut()
            .insert(path.to_owned(), out.clone());
        Ok(out)
    }

    #[cfg(feature = "engine-host")]
    pub fn host_imports(
        &self,
        path: &str,
        code: &str,
    ) -> Result<Rc<[crate::transpiler::ModuleImport]>, NativeError> {
        if let Some(imports) = self.source_imports.borrow().get(path) {
            return Ok(imports.clone());
        }
        // Eval sources bypass file transpilation. Scan them once, then cache.
        let imports: Rc<[_]> = self
            .transpiler
            .module_imports(code, path)
            .map_err(NativeError::syntax_error)?
            .into();
        self.source_imports
            .borrow_mut()
            .insert(path.to_owned(), imports.clone());
        Ok(imports)
    }

    /// Forget what was cached for `path` when its content changed since.
    /// Dev servers rewrite their output in place (webpack's server chunks),
    /// and `delete require.cache[path]` then expects the new code. The key
    /// includes the printed hooks' version, like every cache of hooked text.
    fn revalidate(&self, path: &str, raw: &[u8]) {
        let digest = bun_wyhash::hash_with_seed(u64::from(self.transpiler.hooks_version()), raw);
        let previous = self
            .source_digests
            .borrow_mut()
            .insert(path.to_owned(), digest);
        if previous.is_none_or(|seen| seen == digest) {
            return;
        }
        self.sources.borrow_mut().remove(path);
        self.positions.borrow_mut().remove(path);
        #[cfg(feature = "engine-host")]
        {
            self.source_imports.borrow_mut().remove(path);
            self.cjs_sources.borrow_mut().remove(path);
        }
    }

    /// Remember that `len` characters were injected before line 1 of `path`.
    pub fn record_prologue(&self, path: &str, len: usize) {
        if len == 0 {
            return;
        }
        self.positions
            .borrow_mut()
            .entry(path.to_owned())
            .or_default()
            .line1_shift = len as u32;
    }
}

/// The CommonJS wrapper for `code` and the line its first line must get.
/// Our wrapper takes lines -1 and 0 (engines treat a start line of 0 as
/// "default"), so the file's own lines and columns are unchanged; code Bun's
/// transpiler already wrapped keeps the printed code's lines.
pub fn cjs_wrapper(code: &str) -> (String, i32) {
    if is_cjs_wrapper(code) {
        return (code.to_owned(), 1);
    }
    // Named so engines whose stack frames carry only a name (JSC) can tell
    // the module's top level from an anonymous function.
    (
        format!(
            "(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {{\n\n{code}\n}})"
        ),
        -1,
    )
}

/// Source of an embedded polyfill (src/js/<name>.js).
pub fn polyfill_source(name: &str) -> Option<&'static str> {
    POLYFILLS.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}

#[cfg(feature = "engine-split")]
fn is_plain_identifier(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

#[cfg(feature = "engine-split")]
/// Wrapper ESM source re-exporting `import.meta.m` (default) and its keys.
pub fn wrapper_source(keys: &[String]) -> String {
    let mut src =
        String::from("const m = import.meta.m.value; export default import.meta.m.default;\n");
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

/// ESM source for a module file: the prologue (recorded for stack-position
/// fixups) plus the code.
pub fn esm_source(state: &State, name: &str, code: &str) -> String {
    esm_source_with(state, name, code, "")
}

/// [`esm_source`] with `extra` code put first on line 1 (the host engine's
/// `import.meta` set-up).
pub fn esm_source_with(state: &State, name: &str, code: &str, extra: &str) -> String {
    let entry = !state.main_arg.borrow().is_empty() && name == state.main.borrow().as_str();
    let worker = if entry {
        "import.meta.__bunwasm_workerEntry?.(); "
    } else {
        ""
    };
    let prologue = format!("{extra}{worker}{}", esm_prologue(code));
    state.record_prologue(name, prologue.chars().count());
    format!("{prologue}{code}")
}

/// Register `-e` code as the module `<cwd>/[eval]`; returns (name, source).
pub fn eval_entry(state: &State, code: &str) -> (String, String) {
    let name = format!("{}/[eval]", state.cwd().trim_end_matches('/'));
    state
        .sources
        .borrow_mut()
        .insert(name.clone(), (Rc::from(code), Format::Esm));
    let source = esm_source(state, &name, code);
    (name, source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewritten_files_load_again() {
        let dir = std::env::temp_dir().join(format!("bunwasm-revalidate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("chunk.js");
        let path = file.to_str().unwrap();
        let state = State::new(
            Vec::new(),
            Box::new(crate::transpiler::PassthroughTranspiler),
        );
        let load = |state: &State| state.load_source(path).unwrap().0.to_string();
        std::fs::write(&file, "module.exports = 1;").unwrap();
        assert_eq!(load(&state), "module.exports = 1;");
        state.record_prologue(path, 3);
        assert_eq!(load(&state), "module.exports = 1;");
        assert!(state.positions.borrow().contains_key(path));
        std::fs::write(&file, "module.exports = 2;").unwrap();
        assert_eq!(load(&state), "module.exports = 2;");
        assert!(!state.positions.borrow().contains_key(path));
        std::fs::remove_dir_all(&dir).unwrap();
        let (name, _) = eval_entry(&state, "console.log(1)");
        assert_eq!(&*state.load_source(&name).unwrap().0, "console.log(1)");
    }

    #[cfg(feature = "engine-host")]
    struct TestModule(std::path::PathBuf);

    #[cfg(feature = "engine-host")]
    impl TestModule {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("bunwasm-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> String {
            self.0.join("module.mjs").to_str().unwrap().to_owned()
        }

        fn write(&self, source: &str) {
            std::fs::write(self.path(), source).unwrap();
        }
    }

    #[cfg(feature = "engine-host")]
    impl Drop for TestModule {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[cfg(feature = "engine-host")]
    struct CacheTranspiler(Rc<std::cell::Cell<usize>>);

    #[cfg(feature = "engine-host")]
    impl crate::Transpiler for CacheTranspiler {
        fn transpile(&self, source: &str, _: &str, _: SourceLoader) -> Result<String, String> {
            Ok(source.to_owned())
        }

        fn transpile_with_map(
            &self,
            source: &str,
            _: &str,
            _: SourceLoader,
        ) -> Result<crate::Transpiled, String> {
            let imports = source
                .match_indices("import(")
                .map(|(start, _)| crate::transpiler::ModuleImport {
                    start,
                    end: start + "import".len(),
                    kind: crate::transpiler::ModuleImportKind::Dynamic,
                })
                .collect();
            Ok(crate::Transpiled {
                code: source.to_owned(),
                imports,
                ..Default::default()
            })
        }

        fn esm_to_cjs(&self, path: &str) -> Result<crate::Transpiled, String> {
            self.0.set(self.0.get() + 1);
            let source = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
            self.transpile_with_map(&source, path, SourceLoader::Js)
        }
    }

    #[cfg(feature = "engine-host")]
    #[test]
    fn host_import_spans_refresh_after_rewrite() {
        let file = TestModule::new("host-import-cache");
        let path = file.path();
        let state = State::new(Vec::new(), Box::new(CacheTranspiler(Rc::default())));
        file.write("export const load = () => import('./first.mjs');");
        let (source, _) = state.load_source(&path).unwrap();
        let first = state.host_imports(&path, &source).unwrap();
        state.record_prologue(&path, 5);
        let (unchanged, _) = state.load_source(&path).unwrap();
        assert!(Rc::ptr_eq(&source, &unchanged));
        assert!(Rc::ptr_eq(
            &first,
            &state.host_imports(&path, &unchanged).unwrap()
        ));
        assert!(state.positions.borrow().contains_key(&path));
        file.write("/* café 🥞 prefix */ export const load = () => import('./second.mjs');");
        let (changed, _) = state.load_source(&path).unwrap();
        let second = state.host_imports(&path, &changed).unwrap();
        assert!(!Rc::ptr_eq(&first, &second));
        assert_eq!(second.len(), 1);
        assert!(second[0].start > first[0].start);
        assert_eq!(&changed[second[0].start..second[0].end], "import");
        assert!(!state.positions.borrow().contains_key(&path));
    }

    #[cfg(feature = "engine-host")]
    #[test]
    fn host_esm_cjs_refreshes_with_and_without_source_load() {
        let file = TestModule::new("host-converted-cache");
        let path = file.path();
        let conversions = Rc::new(std::cell::Cell::new(0));
        let state = State::new(Vec::new(), Box::new(CacheTranspiler(conversions.clone())));
        file.write("export const value = 1;");
        assert_eq!(
            state.esm_as_cjs(&path).unwrap().code,
            "export const value = 1;"
        );
        state.record_prologue(&path, 5);
        assert_eq!(
            state.esm_as_cjs(&path).unwrap().code,
            "export const value = 1;"
        );
        assert_eq!(conversions.get(), 1);
        assert!(state.positions.borrow().contains_key(&path));
        file.write("export const value = 2;");
        assert_eq!(
            state.esm_as_cjs(&path).unwrap().code,
            "export const value = 2;"
        );
        assert_eq!(conversions.get(), 2);
        assert!(!state.positions.borrow().contains_key(&path));
        state.load_source(&path).unwrap();
        file.write("export const value = 3;");
        state.load_source(&path).unwrap();
        assert_eq!(
            state.esm_as_cjs(&path).unwrap().code,
            "export const value = 3;"
        );
        assert_eq!(conversions.get(), 3);
    }

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
        // Bun's printer merges adjacent declarations.
        assert!(declares(
            "const root = 1, require = createRequire(import.meta.url);",
            "require"
        ));
        assert!(declares("const { require } = mod;", "require"));
        assert!(declares("let a, require;", "require"));
        assert!(declares("import { require } from \"m\";", "require"));
        assert!(!declares("const a = 1;\nfoo(a, require);", "require"));
        assert!(!declares(
            "const x = { require: 1 };\nrequire('y');",
            "require"
        ));
        assert!(!declares("if (a == require) {}", "require"));
    }
}
