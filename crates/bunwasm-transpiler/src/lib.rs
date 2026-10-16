//! Bun's real transpiler, compiled to wasm.
//!
//! This is the same parse → print path `Bun.Transpiler#transformSync` takes
//! (vendor/bun/src/runtime/api/JSTranspiler.rs), minus the JavaScriptCore
//! glue: TypeScript/JSX/JSON/TOML in, ESM JavaScript out.
use std::cell::RefCell;

pub mod data;

use bun_alloc::Arena;
use bun_ast::Loader as BunLoader;
use bun_bundler::transpiler::{ParseOptions, Transpiler};
use bun_options_types::schema::api;

pub use bun_wyhash::hash as wyhash;

#[cfg(target_os = "wasi")]
extern crate bunwasm_posix;
#[cfg(target_os = "wasi")]
extern crate bunwasm_glue;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loader {
    Js,
    Jsx,
    Ts,
    Tsx,
    Json,
    Toml,
    Yaml,
    Json5,
    Jsonc,
    Text,
}

impl Loader {
    fn to_bun(self) -> BunLoader {
        match self {
            Loader::Js => BunLoader::Js,
            Loader::Jsx => BunLoader::Jsx,
            Loader::Ts => BunLoader::Ts,
            Loader::Tsx => BunLoader::Tsx,
            Loader::Json => BunLoader::Json,
            Loader::Toml => BunLoader::Toml,
            Loader::Yaml => BunLoader::Yaml,
            Loader::Json5 => BunLoader::Json5,
            Loader::Jsonc => BunLoader::Jsonc,
            Loader::Text => BunLoader::Text,
        }
    }

    /// Bun's own extension table (`.mts`, `.cjs`, `.jsonc`, ...).
    pub fn from_path(path: &str) -> Option<Loader> {
        let ext = path.rsplit_once('.').map(|(_, e)| e)?;
        Some(match ext {
            "js" | "mjs" | "cjs" => Loader::Js,
            "jsx" => Loader::Jsx,
            "ts" | "mts" | "cts" => Loader::Ts,
            "tsx" => Loader::Tsx,
            "json" => Loader::Json,
            "jsonc" => Loader::Jsonc,
            "json5" => Loader::Json5,
            "yaml" | "yml" => Loader::Yaml,
            "toml" => Loader::Toml,
            "txt" => Loader::Text,
            _ => return None,
        })
    }
}

struct State {
    // Field order matters: `transpiler` borrows `arena` and drops first.
    transpiler: Transpiler<'static>,
    log: Box<bun_ast::Log>,
    _arena: Box<Arena>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn init_state() -> Result<State, String> {
    let arena = Box::new(Arena::new());
    // SAFETY: the arena is boxed and lives as long as `State`, which owns it.
    let arena_ref: &'static Arena = unsafe { &*(&*arena as *const Arena) };
    let mut log = Box::new(bun_ast::Log::init());
    let opts = api::TransformOptions {
        disable_hmr: true,
        target: Some(api::Target::Bun),
        ..Default::default()
    };
    let mut transpiler =
        Transpiler::init(arena_ref, &raw mut *log, opts, None).map_err(|e| format!("transpiler init: {e:?}"))?;
    transpiler.configure_linker_with_auto_jsx(false);
    transpiler.options.env.behavior = bun_bundler::options::EnvBehavior::disable;
    transpiler.configure_defines().map_err(|e| format!("transpiler defines: {e:?}"))?;
    transpiler.options.transform_only = true;
    transpiler.options.tree_shaking = false;
    Ok(State { transpiler, log, _arena: arena })
}

/// Locate import keywords in original generated-function arguments. The full
/// function grammar distinguishes import expressions from property names.
pub fn function_imports(args: &[String], kind: &str) -> Result<Vec<Vec<usize>>, String> {
    let prefix = match kind {
        "async" => "async function",
        "generator" => "function*",
        "async-generator" => "async function*",
        _ => "function",
    };
    let mut source = format!("({prefix} anonymous(");
    let mut ranges = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        if i == args.len() - 1 {
            source.push_str("\n){\n");
        } else if i > 0 {
            source.push(',');
        }
        let start = source.len();
        source.push_str(arg);
        ranges.push(start..source.len());
    }
    source.push_str("\n})");
    let (_, mut offsets) = with_state(|state| {
        let (result, offsets) = bun_js_parser::with_bunwasm_dynamic_imports(|| run(state, &source, "<Function>", Loader::Js, None));
        result.map(|code| (code, offsets))
    })?;
    offsets.sort_unstable();
    offsets.dedup();
    Ok(ranges.into_iter().map(|range| {
        offsets.iter().filter(|offset| range.contains(offset)).map(|offset| {
            source[range.start..*offset].encode_utf16().count()
        }).collect()
    }).collect())
}

/// Transpile one module to ESM JavaScript. `path` is used for error messages
/// and the JSX/TS pragma lookups; it is not read from disk.
pub fn transpile(source: &str, path: &str, loader: Loader) -> Result<String, String> {
    with_state(|state| run(state, source, path, loader, None)).map(|out| out.code)
}

#[derive(Clone, Copy, Debug)]
pub enum ModuleKind {
    Script,
    CommonJs,
    Esm,
}

/// Output plus its source map and parser classification.
pub struct Transpiled {
    pub module_kind: ModuleKind,
    pub code: String,
    /// Source map v3 `mappings` (base64 VLQ, one source: the input file).
    pub mappings: String,
}

/// Like [`transpile`], also returning the source map the printer recorded,
/// so stack traces can point at the original TypeScript lines.
pub fn transpile_with_source_map(source: &str, path: &str, loader: Loader) -> Result<Transpiled, String> {
    let mut collector = ChunkCollector(None);
    let mut out = with_state(|state| run(state, source, path, loader, Some(&mut collector)))?;
    let mappings = collector
        .0
        .map(|chunk| String::from_utf8_lossy(chunk.buffer.list.as_slice()).into_owned())
        .unwrap_or_default();
    out.mappings = mappings;
    Ok(out)
}

/// Runs `f` with Bun's printer emitting the bun-wasm `await` hooks
/// (`__bunwasm_resume(__bunwasm_capture(), await x)`, see
/// `bun_js_printer::BUNWASM_AWAIT_HOOKS`) when `on`. For the browser engine,
/// which carries AsyncLocalStorage across `await` with them.
pub fn with_await_hooks<T>(on: bool, f: impl FnOnce() -> T) -> T {
    use std::sync::atomic::Ordering;
    let hooks = &bun_js_printer::BUNWASM_AWAIT_HOOKS;
    let previous = hooks.swap(on, Ordering::Relaxed);
    let out = f();
    hooks.store(previous, Ordering::Relaxed);
    out
}

/// Renders a v3 source map JSON for a [`Transpiled`] result.
pub fn source_map_json(path: &str, source: &str, mappings: &str) -> String {
    let quote = |s: &str| {
        let mut out = String::from('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    };
    format!(
        r#"{{"version":3,"sources":[{}],"sourcesContent":[{}],"names":[],"mappings":{}}}"#,
        quote(path),
        quote(source),
        quote(mappings)
    )
}

struct ChunkCollector(Option<bun_sourcemap::Chunk>);

impl bun_js_printer::OnSourceMapChunk for ChunkCollector {
    fn on_source_map_chunk(
        &mut self,
        chunk: bun_sourcemap::Chunk,
        _source: &bun_ast::Source,
    ) -> bun_js_printer::Result<()> {
        self.0 = Some(chunk);
        Ok(())
    }
}

fn with_state<T>(f: impl FnOnce(&mut State) -> Result<T, String>) -> Result<T, String> {
    STATE.with_borrow_mut(|slot| {
        if slot.is_none() {
            *slot = Some(init_state()?);
        }
        f(slot.as_mut().expect("initialized above"))
    })
}

fn run(
    state: &mut State,
    source: &str,
    path: &str,
    loader: Loader,
    source_map: Option<&mut ChunkCollector>,
) -> Result<Transpiled, String> {
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();
    // SAFETY: `arena` outlives every use below; the long-lived arena is put
    // back before this function returns.
    let arena_ref: &'static Arena = unsafe { &*(&arena as *const Arena) };
    let mut log = bun_ast::Log::init();
    let prev_arena = state.transpiler.arena;
    state.transpiler.set_arena(arena_ref);
    state.transpiler.set_log(&raw mut log);
    let restore = |t: &mut Transpiler<'static>, log: &mut bun_ast::Log| {
        t.set_arena(prev_arena);
        t.set_log(log);
    };

    let path_static: &'static [u8] = arena_ref.alloc_slice_copy(path.as_bytes());
    let code: &'static [u8] = arena_ref.alloc_slice_copy(source.as_bytes());
    let src: &'static bun_ast::Source = arena_ref.alloc(bun_ast::Source::init_path_string(path_static, code));
    let parse_options = ParseOptions {
        arena: arena_ref,
        macro_remappings: Default::default(),
        dirname_fd: bun_sys::Fd::INVALID,
        file_descriptor: None,
        loader: loader.to_bun(),
        jsx: state.transpiler.options.jsx.clone(),
        path: src.path,
        virtual_source: Some(src),
        replace_exports: Default::default(),
        macro_js_ctx: bun_bundler::transpiler::default_macro_js_value(),
        experimental_decorators: false,
        emit_decorator_metadata: false,
        use_define_for_class_fields: true,
        file_fd_ptr: None,
        inject_jest_globals: false,
        set_breakpoint_on_first_line: false,
        remove_cjs_module_wrapper: false,
        dont_bundle_twice: false,
        allow_commonjs: true,
        module_type: Default::default(),
        runtime_transpiler_cache: None,
        keep_json_and_toml_as_one_statement: false,
        allow_bytecode_cache: false,
    };
    let parsed = state.transpiler.parse(parse_options, None);
    if log.errors > 0 || parsed.is_none() {
        let msg = format_log(&log, path);
        restore(&mut state.transpiler, &mut state.log);
        return Err(if msg.is_empty() { format!("failed to parse {path}") } else { msg });
    }
    let mut printer = bun_js_printer::BufferPrinter::init(bun_js_printer::BufferWriter::init());
    let parsed = parsed.expect("checked above");
    let module_kind = module_kind(&parsed.ast, loader);
    let format = bun_bundler::transpiler::PrintFormat::Esm;
    let printed = match source_map {
        Some(collector) => state.transpiler.print_with_source_map(
            &arena,
            parsed,
            &mut printer,
            format,
            bun_js_printer::SourceMapHandler::for_(collector),
            None,
        ),
        None => state.transpiler.print(&arena, parsed, &mut printer, format),
    };
    restore(&mut state.transpiler, &mut state.log);
    printed.map_err(|e| format!("failed to print {path}: {e:?}"))?;
    let code = String::from_utf8(printer.ctx.written().to_vec()).map_err(|e| e.to_string())?;
    Ok(Transpiled { code, mappings: String::new(), module_kind })
}

fn module_kind(ast: &bun_ast::Ast<'_>, loader: Loader) -> ModuleKind {
    if ast.has_import_meta || matches!(loader, Loader::Json | Loader::Toml | Loader::Yaml | Loader::Json5 | Loader::Jsonc | Loader::Text) {
        return ModuleKind::Esm;
    }
    if matches!(ast.exports_kind, bun_ast::ExportsKind::Cjs | bun_ast::ExportsKind::EsmWithDynamicFallbackFromCjs) {
        return ModuleKind::CommonJs;
    }
    let imports = ast.import_records.as_slice().iter().any(|record| {
        record.kind == bun_ast::ImportKind::Stmt
            && !record.flags.intersects(bun_ast::import_record::Flags::IS_INTERNAL | bun_ast::import_record::Flags::IS_UNUSED)
    });
    if ast.export_keyword.len > 0 || ast.top_level_await_keyword.len > 0 || imports {
        return ModuleKind::Esm;
    }
    ModuleKind::Script
}

fn format_log(log: &bun_ast::Log, path: &str) -> String {
    let mut out = String::new();
    for msg in log.msgs.iter() {
        let text = String::from_utf8_lossy(&msg.data.text);
        match &msg.data.location {
            Some(loc) => out.push_str(&format!(
                "{}:{}:{}: {}\n",
                String::from_utf8_lossy(&loc.file),
                loc.line,
                loc.column,
                text
            )),
            None => out.push_str(&format!("{path}: {text}\n")),
        }
    }
    out
}
