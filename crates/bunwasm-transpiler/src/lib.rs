//! Bun's real transpiler, compiled to wasm.
//!
//! This is the same parse → print path `Bun.Transpiler#transformSync` takes
//! (vendor/bun/src/runtime/api/JSTranspiler.rs), minus the JavaScriptCore
//! glue: TypeScript/JSX/JSON/TOML in, ESM JavaScript out.
use std::{borrow::Cow, cell::RefCell};

pub mod data;
mod register;

use bun_alloc::Arena;
use bun_ast::Loader as BunLoader;
use bun_bundler::transpiler::{ParseOptions, Transpiler};
use bun_options_types::schema::api;

pub use bun_wyhash::hash as wyhash;

extern crate bunwasm_glue;
#[cfg(target_os = "wasi")]
extern crate bunwasm_posix;

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
    tsconfig: Option<Box<bun_resolver::tsconfig_json::TSConfigJSON>>,
    public_api: bool,
    _arena: Box<Arena>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn init_state() -> Result<State, String> {
    init_with_options(
        api::TransformOptions {
            disable_hmr: true,
            target: Some(api::Target::Bun),
            ..Default::default()
        },
        api::DotEnvBehavior::LoadAllWithoutInlining,
    )
}

fn init_with_options(
    opts: api::TransformOptions,
    env_behavior: api::DotEnvBehavior,
) -> Result<State, String> {
    let arena = Box::new(Arena::new());
    // SAFETY: the arena is boxed and lives as long as `State`, which owns it.
    let arena_ref: &'static Arena = unsafe { &*(&*arena as *const Arena) };
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(arena_ref);
    let _ast_scope = ast_alloc.enter();
    let mut log = Box::new(bun_ast::Log::init());
    let mut transpiler = Transpiler::init(arena_ref, &raw mut *log, opts, None)
        .map_err(|e| format!("transpiler init: {e:?}"))?;
    transpiler.configure_linker_with_auto_jsx(false);
    transpiler.options.env.behavior = env_behavior;
    transpiler.options.env.disable_default_env_files =
        env_behavior == api::DotEnvBehavior::LoadAllWithoutInlining;
    transpiler
        .configure_defines()
        .map_err(|e| format!("transpiler defines: {e:?}"))?;
    transpiler.options.transform_only = true;
    transpiler.options.tree_shaking = false;
    Ok(State {
        transpiler,
        log,
        tsconfig: None,
        public_api: false,
        _arena: arena,
    })
}

/// The public JS API uses the same Bun parser/printer with its own options,
/// rather than the module loader's Bun target and source-preserving fast path.
pub fn public_transpile(
    source: &[u8],
    options: &str,
    action: &str,
    name: &str,
) -> Result<String, String> {
    let options: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let target = match options["target"].as_str().unwrap_or("browser") {
        "bun" => api::Target::Bun,
        "node" => api::Target::Node,
        _ => api::Target::Browser,
    };
    let define = options["define"].as_object().map(|entries| {
        let mut map = api::StringMap::EMPTY;
        for (key, value) in entries {
            map.keys.push(key.as_bytes().into());
            map.values
                .push(value.as_str().unwrap_or("").as_bytes().into());
        }
        map
    });
    let tsconfig_bytes = match options["tsconfig"].as_str() {
        Some(text) => text.as_bytes().to_vec(),
        None => serde_json::to_vec(&options["tsconfig"]).map_err(|e| e.to_string())?,
    };
    let mut state = init_with_options(
        api::TransformOptions {
            target: Some(target),
            disable_hmr: true,
            define,
            ..Default::default()
        },
        api::DotEnvBehavior::Disable,
    )?;
    state.public_api = true;
    configure_public(&mut state, &options, &tsconfig_bytes)?;
    if action == "validate" {
        return Ok(String::new());
    }
    let loader = if name == "text" {
        Loader::Text
    } else {
        Loader::from_path(&format!("input.{name}"))
            .ok_or_else(|| format!("Invalid loader: {name}"))?
    };
    let source = String::from_utf8_lossy(source);
    let path = format!("input.{}", options["loader"].as_str().unwrap_or("jsx"));
    let out = run_with_scan(
        &mut state,
        &source,
        &path,
        loader,
        None,
        false,
        if action == "transform" {
            Pass::Print
        } else {
            Pass::Scan
        },
    )?;
    if action == "scanImports" {
        let scan: serde_json::Value = serde_json::from_str(&out.code).map_err(|e| e.to_string())?;
        return Ok(scan["imports"].to_string());
    }
    Ok(out.code)
}

fn configure_public(
    state: &mut State,
    options: &serde_json::Value,
    tsconfig: &[u8],
) -> Result<(), String> {
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&state._arena);
    let _ast_scope = ast_alloc.enter();
    if !options["tsconfig"].is_null() {
        let source = bun_ast::Source::init_path_string(b"tsconfig.json", tsconfig);
        state.tsconfig = bun_resolver::tsconfig_json::TSConfigJSON::parse(
            &mut state.log,
            &source,
            &mut state.transpiler.resolver.caches.json,
        )
        .map_err(|e| format!("Invalid tsconfig: {e:?}"))?;
        if state.log.errors > 0 {
            return Err(format_log(&state.log, "tsconfig.json"));
        }
    }
    let opts = &mut state.transpiler.options;
    opts.repl_mode = options["replMode"].as_bool().unwrap_or(false);
    opts.dead_code_elimination =
        options["deadCodeElimination"].as_bool().unwrap_or(true) && !opts.repl_mode;
    opts.tree_shaking = options["treeShaking"].as_bool().unwrap_or(false);
    opts.trim_unused_imports = Some(
        options["trimUnusedImports"]
            .as_bool()
            .unwrap_or(opts.tree_shaking),
    );
    opts.minify_whitespace = options["minifyWhitespace"].as_bool().unwrap_or(false);
    opts.minify_syntax = options["minifySyntax"].as_bool().unwrap_or(false);
    opts.minify_identifiers = options["minifyIdentifiers"].as_bool().unwrap_or(false);
    opts.allow_runtime = options["allowBunRuntime"].as_bool().unwrap_or(false);
    opts.auto_import_jsx = options["autoImportJSX"].as_bool().unwrap_or(false);
    Ok(())
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
        let (result, offsets) = bun_js_parser::with_bunwasm_dynamic_imports(|| {
            run(state, &source, "<Function>", Loader::Js, None, false)
        });
        result.map(|code| (code, offsets))
    })?;
    offsets.sort_unstable();
    offsets.dedup();
    Ok(ranges
        .into_iter()
        .map(|range| {
            offsets
                .iter()
                .filter(|offset| range.contains(offset))
                .map(|offset| source[range.start..*offset].encode_utf16().count())
                .collect()
        })
        .collect())
}

/// Transpile one module to ESM JavaScript. `path` is used for error messages
/// and project decorator settings; the supplied source is not read from disk.
pub fn transpile(source: &str, path: &str, loader: Loader) -> Result<String, String> {
    with_state(|state| run(state, source, path, loader, None, false)).map(|out| out.code)
}

/// A semantic UTF-8 byte span in the associated source or emitted code.
#[derive(Debug)]
pub struct ModuleImport {
    pub start: usize,
    pub end: usize,
    /// Static imports carry their decoded specifier; dynamic imports span
    /// just the keyword, leaving both arguments and their evaluation intact.
    pub specifier: Option<String>,
}

/// Scan unchanged JavaScript without binding symbols, transforming or printing.
pub fn module_imports(source: &str, path: &str) -> Result<Vec<ModuleImport>, String> {
    // Both spellings are required by the grammar for an import or re-export.
    // Absence proves there are no spans; presence is resolved by Bun's parser.
    if !source.contains("import") && !source.contains("from") {
        return Ok(Vec::new());
    }
    with_state(|state| scan_imports(state, source, path))
}

fn scan_imports(state: &State, source: &str, path: &str) -> Result<Vec<ModuleImport>, String> {
    // Match the runtime's same-length replacement so spans still address the input.
    let source = match source.strip_prefix("#!") {
        Some(rest) => Cow::Owned(format!("//{rest}")),
        None => Cow::Borrowed(source),
    };
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();
    let src = bun_ast::Source::init_path_string(path.as_bytes(), source.as_bytes());
    let mut log = bun_ast::Log::init();
    let mut scanned = bun_js_parser::ScanPassResult::init();
    let (result, dynamic) = bun_js_parser::with_bunwasm_dynamic_imports(|| {
        let mut options =
            bun_js_parser::ParserOptions::init(state.transpiler.options.jsx.clone(), BunLoader::Js);
        options.features.commonjs_at_runtime = true;
        let mut parser = bun_js_parser::Parser::init(
            options,
            &mut log,
            &src,
            &state.transpiler.options.define,
            &arena,
        )
        .map_err(|e| format!("failed to scan {path}: {e:?}"))?;
        parser
            .scan_imports(&mut scanned)
            .map_err(|e| format!("failed to scan {path}: {e:?}"))
    });
    result?;
    if log.errors > 0 {
        return Err(format_log(&log, path));
    }
    let mut imports = static_imports(&scanned.import_records);
    imports.extend(dynamic.into_iter().map(|start| ModuleImport {
        start,
        end: start + 6,
        specifier: None,
    }));
    imports.sort_by_key(|import| import.start);
    imports.dedup_by_key(|import| import.start);
    Ok(imports)
}

fn static_imports(records: &[bun_ast::ImportRecord]) -> Vec<ModuleImport> {
    records
        .iter()
        .filter(|r| r.kind == bun_ast::ImportKind::Stmt)
        .map(|record| {
            let start = record.range.loc.start as usize;
            ModuleImport {
                start,
                end: start + record.range.len as usize,
                specifier: Some(String::from_utf8_lossy(record.path.text).into_owned()),
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
pub enum ModuleKind {
    Script,
    CommonJs,
    Esm,
}

/// Output plus its source map.
pub struct Transpiled {
    pub module_kind: ModuleKind,
    pub code: String,
    /// Source map v3 `mappings` (base64 VLQ, one source: the input file).
    pub mappings: String,
    pub imports: Vec<ModuleImport>,
}

/// Like [`transpile`], also returning the source map the printer recorded,
/// so stack traces can point at the original TypeScript lines.
pub fn transpile_with_source_map(
    source: &str,
    path: &str,
    loader: Loader,
    preserve_source: bool,
) -> Result<Transpiled, String> {
    let mut collector = ChunkCollector(None, 0);
    let (out, imports) = bun_js_printer::with_bunwasm_imports(|| {
        with_state(|state| {
            run(
                state,
                source,
                path,
                loader,
                Some(&mut collector),
                preserve_source,
            )
        })
    });
    let mut out = out?;
    if !preserve_source {
        out.imports = imports
            .into_iter()
            .map(|import| ModuleImport {
                start: import.start,
                end: import.end,
                specifier: import.specifier,
            })
            .collect();
    }
    out.mappings = collector
        .0
        .map(|chunk| String::from_utf8_lossy(chunk.buffer.list.as_slice()).into_owned())
        .unwrap_or_default();
    Ok(out)
}

/// Print host `require(esm)` dynamic imports directly in the bundler's pass.
pub fn with_dynamic_import_referrer<T>(from: &str, f: impl FnOnce() -> T) -> T {
    bun_js_printer::with_bunwasm_import_referrer(from, f)
}

/// Version of the shapes [`with_await_hooks`] prints.
pub const HOOKS_VERSION: u32 = bun_js_printer::BUNWASM_HOOKS_VERSION;

/// Runs `f` with Bun's printer emitting the bun-wasm async-context hooks
/// (`await`, `catch`/`finally`, async generator `yield` and `for await`; see
/// `bun_js_printer::BUNWASM_AWAIT_HOOKS`) when `on`. For the browser engine,
/// which carries AsyncLocalStorage across suspensions with them.
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

struct ChunkCollector(Option<bun_sourcemap::Chunk>, usize);

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
    preserve_source: bool,
) -> Result<Transpiled, String> {
    run_with_scan(
        state,
        source,
        path,
        loader,
        source_map,
        preserve_source,
        Pass::Print,
    )
}

/// Which output [`run_with_scan`] produces from the parsed module.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    Print,
    /// Imports and exports as JSON (`Bun.Transpiler#scan`).
    Scan,
    /// A registration record (see [`register()`]).
    Register,
}

/// The ES module `source` as a registration record: a script expression for
/// engines without native ES modules, linked and evaluated by the runtime's
/// `esm_loader.ts`. See `register.rs` for the format.
pub fn register(source: &str, path: &str, loader: Loader) -> Result<Transpiled, String> {
    let mut collector = ChunkCollector(None, 0);
    let mut out = with_state(|state| {
        run_with_scan(
            state,
            source,
            path,
            loader,
            Some(&mut collector),
            false,
            Pass::Register,
        )
    })?;
    let mappings = collector
        .0
        .map(|chunk| String::from_utf8_lossy(chunk.buffer.list.as_slice()).into_owned())
        .unwrap_or_default();
    out.mappings = shift_record_mappings(&mappings, collector.1);
    Ok(out)
}

fn shift_record_mappings(mappings: &str, columns: usize) -> String {
    if mappings.is_empty() || mappings.starts_with(';') {
        return mappings.to_owned();
    }
    let first = bun_sourcemap::vlq::decode(mappings.as_bytes(), 0);
    let column = first
        .value
        .checked_add(i32::try_from(columns).expect("record header size"))
        .expect("record column");
    let encoded = bun_sourcemap::VLQ::encode(column);
    format!(
        "{}{}",
        std::str::from_utf8(encoded.slice()).unwrap(),
        &mappings[first.start..]
    )
}

fn runtime_decorator_config(
    state: &mut State,
    path: &str,
    loader: Loader,
) -> Option<&'static bun_resolver::tsconfig_json::TSConfigJSON> {
    if state.public_api || !matches!(loader, Loader::Ts | Loader::Tsx) {
        return None;
    }
    let path = std::path::absolute(path).ok()?;
    path.parent()?.ancestors().find_map(|directory| {
        state
            .transpiler
            .resolver
            .read_dir_info_ignore_error(directory.as_os_str().as_encoded_bytes())
            .and_then(|directory| directory.tsconfig_json())
    })
}

fn run_with_scan(
    state: &mut State,
    source: &str,
    path: &str,
    loader: Loader,
    mut source_map: Option<&mut ChunkCollector>,
    preserve_source: bool,
    pass: Pass,
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
    let src: &'static bun_ast::Source =
        arena_ref.alloc(bun_ast::Source::init_path_string(path_static, code));
    let decorator_config = runtime_decorator_config(state, path, loader);
    let decorator_config = state.tsconfig.as_deref().or(decorator_config);
    let parse_options = ParseOptions {
        arena: arena_ref,
        macro_remappings: Default::default(),
        dirname_fd: bun_sys::Fd::INVALID,
        file_descriptor: None,
        loader: loader.to_bun(),
        jsx: state.tsconfig.as_deref().map_or_else(
            || state.transpiler.options.jsx.clone(),
            |ts| ts.merge_jsx(state.transpiler.options.jsx.clone()),
        ),
        path: src.path,
        virtual_source: Some(src),
        replace_exports: Default::default(),
        macro_js_ctx: bun_bundler::transpiler::default_macro_js_value(),
        experimental_decorators: decorator_config.is_some_and(|ts| ts.experimental_decorators),
        emit_decorator_metadata: decorator_config.is_some_and(|ts| ts.emit_decorator_metadata),
        use_define_for_class_fields: state
            .tsconfig
            .as_deref()
            .and_then(|ts| ts.use_define_for_class_fields)
            .unwrap_or(true),
        file_fd_ptr: None,
        inject_jest_globals: false,
        set_breakpoint_on_first_line: false,
        remove_cjs_module_wrapper: false,
        dont_bundle_twice: false,
        allow_commonjs: !state.public_api,
        module_type: Default::default(),
        runtime_transpiler_cache: None,
        keep_json_and_toml_as_one_statement: false,
        allow_bytecode_cache: false,
    };
    let parse = || state.transpiler.parse(parse_options, None);
    let (parsed, dynamic) = if preserve_source {
        bun_js_parser::with_bunwasm_dynamic_imports(parse)
    } else {
        (parse(), Vec::new())
    };
    if log.errors > 0 || parsed.is_none() {
        let msg = format_log(&log, path);
        restore(&mut state.transpiler, &mut state.log);
        return Err(if msg.is_empty() {
            format!("failed to parse {path}")
        } else {
            msg
        });
    }
    let mut parsed = parsed.expect("checked above");
    let module_kind = module_kind(&parsed.ast, loader);
    if pass == Pass::Scan {
        let code = scan_json(
            &mut parsed.ast,
            state
                .transpiler
                .options
                .trim_unused_imports
                .unwrap_or(false),
        );
        restore(&mut state.transpiler, &mut state.log);
        return Ok(Transpiled {
            code,
            mappings: String::new(),
            imports: Vec::new(),
            module_kind,
        });
    }
    if preserve_source {
        let mut imports = static_imports(&parsed.ast.import_records);
        imports.extend(dynamic.into_iter().map(|start| ModuleImport {
            start,
            end: start + 6,
            specifier: None,
        }));
        imports.sort_by_key(|import| import.start);
        imports.dedup_by_key(|import| import.start);
        restore(&mut state.transpiler, &mut state.log);
        return Ok(Transpiled {
            code: source.to_owned(),
            mappings: String::new(),
            imports,
            module_kind,
        });
    }
    let registered =
        (pass == Pass::Register).then(|| register::prepare(&mut parsed.ast, arena_ref));
    let mut printer = bun_js_printer::BufferPrinter::init(bun_js_printer::BufferWriter::init());
    let format = if state.public_api {
        bun_bundler::transpiler::PrintFormat::EsmAscii
    } else {
        bun_bundler::transpiler::PrintFormat::Esm
    };
    let print = || match source_map.as_deref_mut() {
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
    let printed = if registered.is_some() {
        bun_js_printer::with_bunwasm_register(print)
    } else {
        print()
    };
    restore(&mut state.transpiler, &mut state.log);
    printed.map_err(|e| format!("failed to print {path}: {e:?}"))?;
    let mut code = String::from_utf8(printer.ctx.written().to_vec()).map_err(|e| e.to_string())?;
    if let Some(module) = &registered {
        let record = register::assemble(module, &code);
        if let Some(collector) = source_map {
            collector.1 =
                record.encode_utf16().count() - code.encode_utf16().count() - "\n}})".len();
        }
        code = record;
    }
    Ok(Transpiled {
        code,
        mappings: String::new(),
        imports: Vec::new(),
        module_kind,
    })
}

fn scan_json(ast: &mut bun_ast::Ast<'_>, trim_unused: bool) -> String {
    use bun_ast::import_record::Flags;
    let imports: Vec<_> = ast.import_records.as_slice().iter()
        .filter(|record| !record.flags.contains(Flags::IS_INTERNAL) && !(trim_unused && record.flags.contains(Flags::IS_UNUSED)))
        .map(|record| serde_json::json!({ "path": String::from_utf8_lossy(record.path.text), "kind": String::from_utf8_lossy(record.kind.label()) }))
        .collect();
    let mut exports = Vec::new();
    let entries = ast.named_exports.iterator();
    for entry in entries {
        exports.push(String::from_utf8_lossy(entry.key_ptr).into_owned());
    }
    exports.sort();
    serde_json::json!({ "exports": exports, "imports": imports }).to_string()
}

fn module_kind(ast: &bun_ast::Ast<'_>, loader: Loader) -> ModuleKind {
    if ast.has_import_meta
        || matches!(
            loader,
            Loader::Json
                | Loader::Toml
                | Loader::Yaml
                | Loader::Json5
                | Loader::Jsonc
                | Loader::Text
        )
    {
        return ModuleKind::Esm;
    }
    if matches!(
        ast.exports_kind,
        bun_ast::ExportsKind::Cjs | bun_ast::ExportsKind::EsmWithDynamicFallbackFromCjs
    ) {
        return ModuleKind::CommonJs;
    }
    let imports = ast.import_records.as_slice().iter().any(|record| {
        record.kind == bun_ast::ImportKind::Stmt
            && !record.flags.intersects(
                bun_ast::import_record::Flags::IS_INTERNAL
                    | bun_ast::import_record::Flags::IS_UNUSED,
            )
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
