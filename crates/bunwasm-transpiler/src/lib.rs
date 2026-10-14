//! Bun's real transpiler, compiled to wasm.
//!
//! This is the same parse → print path `Bun.Transpiler#transformSync` takes
//! (vendor/bun/src/runtime/api/JSTranspiler.rs), minus the JavaScriptCore
//! glue: TypeScript/JSX/JSON/TOML in, ESM JavaScript out.
use std::cell::RefCell;

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
            "json" | "jsonc" => Loader::Json,
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
    transpiler.options.trim_unused_imports = Some(false);
    Ok(State { transpiler, log, _arena: arena })
}

/// Transpile one module to ESM JavaScript. `path` is used for error messages
/// and the JSX/TS pragma lookups; it is not read from disk.
pub fn transpile(source: &str, path: &str, loader: Loader) -> Result<String, String> {
    STATE.with_borrow_mut(|slot| {
        if slot.is_none() {
            *slot = Some(init_state()?);
        }
        let state = slot.as_mut().expect("initialized above");
        run(state, source, path, loader)
    })
}

fn run(state: &mut State, source: &str, path: &str, loader: Loader) -> Result<String, String> {
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
    let printed = state.transpiler.print(
        &arena,
        parsed.expect("checked above"),
        &mut printer,
        bun_bundler::transpiler::PrintFormat::Esm,
    );
    restore(&mut state.transpiler, &mut state.log);
    printed.map_err(|e| format!("failed to print {path}: {e:?}"))?;
    String::from_utf8(printer.ctx.written().to_vec()).map_err(|e| e.to_string())
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
