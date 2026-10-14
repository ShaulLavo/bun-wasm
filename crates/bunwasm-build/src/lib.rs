//! `bun build` without JavaScriptCore.
//!
//! The option setup, the `BundleV2::generate_from_cli` call, the output
//! writing and the summary are ported from Bun's
//! `src/runtime/cli/build_command.rs` (and the build flags of
//! `src/runtime/cli/Arguments.rs`), which live in the JSC-tied runtime crate.
//! `build` takes parsed options and never exits the process or prints; the
//! caller prints [`BuildOutput::summary`] and [`BuildOutput::log`].
//!
//! Not ported: `--compile`, `--bytecode`, `--app` (bake), `--server-components`,
//! `--check`, `--watch`, macros and plugins.
use std::fmt::Write as _;

use bun_alloc::Arena;
use bun_bundler::bundle_v2::BundleV2;
use bun_bundler::options;
use bun_bundler::transpiler::Transpiler;
use bun_core::strings;
use bun_js_parser::parser::Runtime;
use bun_options_types::context::BundlerOptions;
use bun_options_types::schema::api;
use bun_paths::resolve_path;
use bun_sys::Fd;

#[cfg(target_os = "wasi")]
mod stubs;

#[cfg(target_os = "wasi")]
extern crate bunwasm_glue;
#[cfg(target_os = "wasi")]
extern crate bunwasm_posix;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Browser,
    Bun,
    Node,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Format {
    #[default]
    Esm,
    Cjs,
    Iife,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SourceMap {
    #[default]
    None,
    Linked,
    Inline,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Packages {
    Bundle,
    External,
}

/// `bun build` options. Field names follow the CLI flags.
#[derive(Clone, Debug)]
pub struct BuildArgs {
    pub entry_points: Vec<String>,
    /// Directory relative paths are resolved against. Defaults to the process cwd.
    pub cwd: Option<String>,
    pub outdir: Option<String>,
    pub outfile: Option<String>,
    pub root: Option<String>,
    /// `None` is Bun's default (browser).
    pub target: Option<Target>,
    pub format: Format,
    pub minify_syntax: bool,
    pub minify_whitespace: bool,
    pub minify_identifiers: bool,
    pub keep_names: bool,
    pub sourcemap: SourceMap,
    pub splitting: bool,
    pub external: Vec<String>,
    pub packages: Option<Packages>,
    pub define: Vec<(String, String)>,
    pub drop: Vec<String>,
    pub conditions: Vec<String>,
    pub public_path: Option<String>,
    pub banner: Option<String>,
    pub footer: Option<String>,
    pub entry_naming: Option<String>,
    pub chunk_naming: Option<String>,
    pub asset_naming: Option<String>,
    pub production: bool,
    /// `--no-bundle`: transpile each entry point on its own.
    pub no_bundle: bool,
    pub metafile: Option<String>,
    /// Write the output files to disk. Without it, contents are only returned.
    pub write: bool,
}

impl Default for BuildArgs {
    fn default() -> Self {
        BuildArgs {
            entry_points: Vec::new(),
            cwd: None,
            outdir: None,
            outfile: None,
            root: None,
            target: None,
            format: Format::Esm,
            minify_syntax: false,
            minify_whitespace: false,
            minify_identifiers: false,
            keep_names: false,
            sourcemap: SourceMap::None,
            splitting: false,
            external: Vec::new(),
            packages: None,
            define: Vec::new(),
            drop: Vec::new(),
            conditions: Vec::new(),
            public_path: None,
            banner: None,
            footer: None,
            entry_naming: None,
            chunk_naming: None,
            asset_naming: None,
            production: false,
            no_bundle: false,
            metafile: None,
            write: true,
        }
    }
}

impl BuildArgs {
    /// `--minify`: all three minify passes.
    pub fn set_minify(&mut self, on: bool) {
        self.minify_syntax = on;
        self.minify_whitespace = on;
        self.minify_identifiers = on;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    EntryPoint,
    Chunk,
    Asset,
    SourceMap,
    Metafile,
    Other,
}

impl OutputKind {
    /// The label Bun prints in its summary.
    pub fn label(self) -> &'static str {
        match self {
            OutputKind::EntryPoint => "entry point",
            OutputKind::Chunk => "chunk",
            OutputKind::Asset => "asset",
            OutputKind::SourceMap => "source map",
            OutputKind::Metafile => "metafile json",
            OutputKind::Other => "file",
        }
    }
}

#[derive(Clone, Debug)]
pub struct OutputFile {
    /// Relative to the output directory, as Bun reports it (may start with `./`).
    pub path: String,
    pub kind: OutputKind,
    pub size: usize,
    /// Empty for files Bun copies instead of generating (`file` loader assets).
    pub contents: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct BuildOutput {
    pub files: Vec<OutputFile>,
    /// Modules in the bundle, not counting Bun's runtime.
    pub module_count: usize,
    pub transform_only: bool,
    /// Set when there is no `--outdir`/`--outfile` and one output: Bun prints
    /// it to stdout instead of writing a file, and prints no summary.
    pub stdout: Option<Vec<u8>>,
    /// Warnings, formatted the way Bun prints them to stderr. Empty if none.
    pub log: String,
    /// Files that failed to write, formatted like Bun's errors.
    pub write_errors: Vec<String>,
}

impl BuildOutput {
    /// The text native `bun build` prints to stdout after a build:
    /// `Bundled N modules in Xms`, then one line per file.
    pub fn summary(&self, elapsed_ms: u128, ansi: bool) -> String {
        let mut out = String::new();
        if self.stdout.is_some() {
            return out;
        }
        let (green, reset) = if ansi { ("\x1b[32m", "\x1b[0m") } else { ("", "") };
        if self.transform_only {
            let _ = writeln!(out, "{green}Transpiled file in {elapsed_ms}ms{reset}");
        } else {
            let n = self.module_count;
            let s = if n == 1 { "" } else { "s" };
            let _ = writeln!(out, "{green}Bundled {n} module{s} in {elapsed_ms}ms{reset}");
        }
        out.push('\n');

        let all_paths: Vec<&[u8]> = self.files.iter().map(|f| f.path.as_bytes()).collect();
        let from_path = resolve_path::longest_common_path(&all_paths);
        let mut max_path_len = 0usize;
        let mut size_padding = 0usize;
        let sizes: Vec<String> = self.files.iter().map(|f| format_size(f.size)).collect();
        for (f, size) in self.files.iter().zip(&sizes) {
            max_path_len = max_path_len.max(from_path.len().max(f.path.len()) + 2 - from_path.len());
            size_padding = size_padding.max(size.len());
        }
        for (f, size) in self.files.iter().zip(&sizes) {
            let rel_path = f.path.strip_prefix("./").unwrap_or(&f.path);
            let padding_count = 2usize.max(rel_path.len().max(max_path_len) - rel_path.len());
            out.push_str("  ");
            if ansi {
                out.push_str(match f.kind {
                    OutputKind::EntryPoint => "\x1b[34m",
                    OutputKind::Chunk => "\x1b[36m",
                    OutputKind::Asset => "\x1b[35m",
                    OutputKind::Metafile => "\x1b[32m",
                    OutputKind::SourceMap | OutputKind::Other => "\x1b[2m",
                });
            }
            out.push_str(rel_path);
            if ansi {
                let warn_threshold = match f.kind {
                    OutputKind::EntryPoint | OutputKind::Chunk => 128 * 1024,
                    OutputKind::Asset => 16 * 1024 * 1024,
                    _ => usize::MAX,
                };
                out.push_str(if f.size > warn_threshold { "\x1b[33m" } else { "\x1b[0m" });
            }
            push_spaces(&mut out, padding_count);
            out.push_str(size);
            out.push_str("  ");
            push_spaces(&mut out, size_padding - size.len());
            if ansi {
                out.push_str("\x1b[2m");
            }
            let _ = write!(out, "({})", f.kind.label());
            if ansi {
                out.push_str("\x1b[0m");
            }
            out.push('\n');
        }
        out.push('\n');
        out
    }
}

fn push_spaces(out: &mut String, n: usize) {
    out.extend(std::iter::repeat_n(' ', n));
}

/// Bun's byte-size formatter (`59 bytes`, `1.21 KB`).
pub fn format_size(size: usize) -> String {
    format!("{}", bun_core::fmt::size(size, Default::default()))
}

fn boxed(s: &str) -> Box<[u8]> {
    Box::from(s.as_bytes())
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn format_log(log: &bun_ast::Log) -> String {
    let mut out = String::new();
    let _ = log.print(&mut out);
    out
}

/// Joins `path` onto `cwd` unless it is already absolute.
fn absolute(cwd: &[u8], path: &str) -> Box<[u8]> {
    if bun_paths::is_absolute(path.as_bytes()) {
        return boxed(path);
    }
    let mut spill = Vec::new();
    Box::from(resolve_path::join_abs_string_spill::<resolve_path::platform::Auto>(
        cwd,
        &mut spill,
        &[path.as_bytes()],
    ))
}

/// The CLI's view of the options: `ctx.args` and `ctx.bundler_options`
/// after `Arguments::parse` for `bun build`.
struct Parsed {
    args: api::TransformOptions,
    bundler: BundlerOptions,
}

fn parse(a: &BuildArgs) -> Result<Parsed, String> {
    let cwd: Box<[u8]> = match &a.cwd {
        Some(c) => boxed(c),
        None => {
            let mut buf = bun_paths::path_buffer_pool::get();
            match bun_core::getcwd(&mut buf) {
                Ok(p) => Box::from(p.as_bytes()),
                Err(e) => return Err(format!("error: could not read the working directory: {e:?}")),
            }
        }
    };
    // Paths Bun opens relative to the process cwd are made absolute when the
    // caller picked another directory.
    let path = |p: &str| -> Box<[u8]> {
        if a.cwd.is_some() { absolute(&cwd, p) } else { boxed(p) }
    };

    let mut opts = api::TransformOptions::default();
    let mut b = BundlerOptions::default();
    opts.absolute_working_dir = Some(cwd.clone());

    if !a.define.is_empty() {
        opts.define = Some(api::StringMap {
            keys: a.define.iter().map(|(k, _)| boxed(k)).collect(),
            values: a.define.iter().map(|(_, v)| boxed(v)).collect(),
        });
    }
    opts.drop = a.drop.iter().map(|s| boxed(s)).collect();
    if !a.conditions.is_empty() {
        opts.conditions = a.conditions.iter().map(|s| boxed(s)).collect();
    }

    // parse_build_command_options
    b.transform_only = a.no_bundle;
    if let Some(p) = &a.public_path {
        b.public_path = boxed(p);
    }
    if let Some(s) = &a.banner {
        b.banner = boxed(s);
    }
    if let Some(s) = &a.footer {
        b.footer = boxed(s);
    }
    b.minify_syntax = a.minify_syntax || a.production;
    b.minify_whitespace = a.minify_whitespace || a.production;
    b.minify_identifiers = a.minify_identifiers || a.production;
    b.keep_names = a.keep_names;
    b.emit_dce_annotations = !b.minify_whitespace;
    if !a.external.is_empty() {
        opts.external = a.external.iter().map(|s| boxed(s)).collect();
    }
    opts.packages = a.packages.map(|p| match p {
        Packages::Bundle => api::PackagesMode::Bundle,
        Packages::External => api::PackagesMode::External,
    });
    opts.target = a.target.map(|t| match t {
        Target::Browser => api::Target::Browser,
        Target::Bun => api::Target::Bun,
        Target::Node => api::Target::Node,
    });
    if let Some(o) = a.outdir.as_deref().filter(|s| !s.is_empty()) {
        b.outdir = path(o);
    } else if let Some(o) = a.outfile.as_deref().filter(|s| !s.is_empty()) {
        b.outfile = path(o);
    }
    if let Some(m) = &a.metafile {
        b.metafile = if m.is_empty() { path("meta.json") } else { path(m) };
    }
    if let Some(r) = a.root.as_deref().filter(|s| !s.is_empty()) {
        b.root_dir = path(r);
    }
    // `--format=cjs` defaults `ctx.args.target` to node, but Arguments.rs sets
    // it on `ctx.args` after cloning it into the returned options, so native
    // `bun build` ignores it. Matched here by not setting it.
    b.output_format = match a.format {
        Format::Esm => options::Format::Esm,
        Format::Cjs => options::Format::Cjs,
        Format::Iife => options::Format::Iife,
    };
    b.code_splitting = a.splitting;
    for (value, slot) in [
        (&a.entry_naming, &mut b.entry_naming),
        (&a.chunk_naming, &mut b.chunk_naming),
        (&a.asset_naming, &mut b.asset_naming),
    ] {
        if let Some(v) = value {
            *slot = strings::concat(&[b"./", strings::remove_leading_dot_slash(v.as_bytes())]);
        }
    }
    opts.source_map = match a.sourcemap {
        SourceMap::None => None,
        SourceMap::Linked => Some(api::SourceMapMode::Linked),
        SourceMap::Inline => Some(api::SourceMapMode::Inline),
        SourceMap::External => Some(api::SourceMapMode::External),
    };

    opts.entry_points = a.entry_points.iter().map(|e| path(e)).collect();
    if opts.entry_points.is_empty() {
        return Err("error: Missing entrypoints. What would you like to bundle?".into());
    }
    b.production = a.production;
    Ok(Parsed { args: opts, bundler: b })
}

/// Bundle like `bun build`. Writes the outputs when `args.write` is set and
/// returns what native Bun would print.
pub fn build(args: &BuildArgs) -> Result<BuildOutput, String> {
    let Parsed { args: ctx_args, bundler: mut bo } = parse(args)?;

    // Per-build arena, like `BundleThread::generate_in_new_thread`: the
    // transpiler lives in it and is dropped in place before the arena goes.
    let arena: &'static Arena = Box::leak(Box::new(Arena::new()));
    let log: *mut bun_ast::Log = Box::into_raw(Box::new(bun_ast::Log::init()));

    let transpiler: &'static mut Transpiler<'static> = match Transpiler::init(arena, log, ctx_args.clone(), None) {
        Ok(t) => arena.alloc(t),
        Err(e) => {
            // SAFETY: `log` came from `Box::into_raw` above; nothing else holds it.
            let log = unsafe { Box::from_raw(log) };
            // SAFETY: `arena` came from `Box::leak` above and nothing borrows it.
            drop(unsafe { Box::from_raw(std::ptr::from_ref(arena).cast_mut()) });
            let msg = format_log(&log);
            return Err(if msg.is_empty() { format!("error: {}", e.name()) } else { msg });
        }
    };
    let transpiler_ptr: *mut Transpiler<'static> = transpiler;

    let result = exec(transpiler, arena, log, &ctx_args, &mut bo, args.write);

    // SAFETY: `generate_from_cli` / `transform` are done with the transpiler;
    // see `BundleThread::generate_in_new_thread` for the teardown order.
    unsafe {
        core::ptr::drop_in_place(transpiler_ptr);
        drop(Box::from_raw(std::ptr::from_ref(arena).cast_mut()));
    }
    // SAFETY: `log` came from `Box::into_raw` and the transpiler is gone.
    let log = unsafe { Box::from_raw(log) };
    match result {
        Ok(mut out) => {
            out.log = format_log(&log);
            Ok(out)
        }
        Err(e) => {
            let msg = format_log(&log);
            Err(if msg.is_empty() { e } else { msg })
        }
    }
}

/// `BuildCommand::exec`, minus `--compile`, bake and server components.
fn exec(
    this_transpiler: &'static mut Transpiler<'static>,
    arena: &'static Arena,
    log: *mut bun_ast::Log,
    ctx_args: &api::TransformOptions,
    bo: &mut BundlerOptions,
    write: bool,
) -> Result<BuildOutput, String> {
    // SAFETY: `log` outlives this call (owned by `build`).
    let log_ref: &mut bun_ast::Log = unsafe { &mut *log };

    this_transpiler.options.source_map = options::SourceMapOption::from_api(ctx_args.source_map);
    this_transpiler.options.compile_mode = options::CompileMode::None;

    if this_transpiler.options.source_map == options::SourceMapOption::External && bo.outdir.is_empty() {
        return Err("error: cannot use an external source map without --outdir".into());
    }

    let outfile: Box<[u8]> = bo.outfile.clone();
    let outfile: &[u8] = &outfile;
    let output_to_stdout = outfile.is_empty() && bo.outdir.is_empty();

    this_transpiler.options.supports_multiple_outputs = !(output_to_stdout || !outfile.is_empty());
    this_transpiler.options.public_path.clone_from(&bo.public_path);
    this_transpiler.options.entry_naming.clone_from(&bo.entry_naming);
    this_transpiler.options.chunk_naming.clone_from(&bo.chunk_naming);
    this_transpiler.options.asset_naming.clone_from(&bo.asset_naming);
    this_transpiler.options.server_components = false;
    this_transpiler.options.react_fast_refresh = bo.react_fast_refresh;
    this_transpiler.options.react_compiler = bun_ast::runtime::ReactCompilerMode::Disabled;
    this_transpiler.options.inline_entrypoint_import_meta_main = bo.inline_entrypoint_import_meta_main;
    this_transpiler.options.code_splitting = bo.code_splitting;
    this_transpiler.options.split_require = bo.split_require;
    this_transpiler.options.minify_syntax = bo.minify_syntax;
    this_transpiler.options.minify_whitespace = bo.minify_whitespace;
    this_transpiler.options.minify_identifiers = bo.minify_identifiers;
    this_transpiler.options.keep_names = bo.keep_names;
    this_transpiler.options.emit_dce_annotations = bo.emit_dce_annotations;
    this_transpiler.options.deprecated_namespace_object_setters = bo.deprecated_namespace_object_setters;
    this_transpiler.options.ignore_dce_annotations = bo.ignore_dce_annotations;
    this_transpiler.options.banner = std::borrow::Cow::Owned(bo.banner.clone().into_vec());
    this_transpiler.options.footer = std::borrow::Cow::Owned(bo.footer.clone().into_vec());
    this_transpiler.options.drop = ctx_args.drop.clone().into();
    {
        let flags: Vec<&[u8]> = ctx_args.feature_flags.iter().map(|s| &**s).collect();
        this_transpiler.options.bundler_feature_flags = Runtime::Features::init_bundler_feature_flags(&flags);
    }
    this_transpiler.options.allow_unresolved = options::AllowUnresolved::All;
    this_transpiler.options.css_chunking = bo.css_chunking;
    this_transpiler.options.min_chunk_size = bo.min_chunk_size;
    this_transpiler.options.module_preload = bo.module_preload;
    this_transpiler.options.metafile = !bo.metafile.is_empty();
    this_transpiler.options.output_dir.clone_from(&bo.outdir);
    this_transpiler.options.output_format = bo.output_format;

    if bo.transform_only {
        for entry_point in this_transpiler.options.entry_points.iter() {
            if strings::has_suffix_comptime(entry_point, b".html") {
                return Err("error: HTML imports are only supported when bundling".into());
            }
        }
    }

    if bo.outdir.is_empty() {
        if this_transpiler.options.entry_points.len() > 1 {
            return Err("error: Must use --outdir when specifying more than one entry point.".into());
        }
        if this_transpiler.options.code_splitting {
            return Err("error: Must use --outdir when code splitting is enabled".into());
        }
    }

    let mut src_root_dir_buf = bun_paths::path_buffer_pool::get();
    let src_root_dir: Box<[u8]> = {
        let path: &[u8] = if !bo.root_dir.is_empty() {
            &bo.root_dir
        } else if this_transpiler.options.entry_points.len() == 1 {
            bun_core::dirname(&this_transpiler.options.entry_points[0]).unwrap_or(b".")
        } else {
            let entries: Vec<&[u8]> = this_transpiler.options.entry_points.iter().map(|s| &**s).collect();
            resolve_path::get_if_exists_longest_common_path(&entries).unwrap_or(b".")
        };
        let dir = match bun_sys::open_dir_at(Fd::cwd(), path) {
            Ok(d) => bun_sys::Dir { fd: d },
            Err(err) => {
                return Err(format!("{} opening root directory {}", lossy(err.name()), bun_core::fmt::quote(path)));
            }
        };
        match bun_sys::get_fd_path(dir.fd, &mut src_root_dir_buf) {
            Ok(p) => Box::from(&*p),
            Err(err) => {
                return Err(format!("{} resolving root directory {}", lossy(err.name()), bun_core::fmt::quote(path)));
            }
        }
    };

    this_transpiler.options.root_dir = src_root_dir;
    this_transpiler.options.code_splitting = bo.code_splitting;
    this_transpiler.options.transform_only = bo.transform_only;
    this_transpiler.options.env.behavior = bo.env_behavior;
    this_transpiler.options.env.prefix.clone_from(&bo.env_prefix);

    if bo.production {
        // SAFETY: `env` is a process-lifetime singleton set in `Transpiler::init`.
        unsafe { (*this_transpiler.env).map.put(b"NODE_ENV", b"production") }.map_err(|_| "error: out of memory".to_string())?;
    }

    this_transpiler.configure_defines().map_err(|e| format!("error: {}", e.name()))?;
    this_transpiler.configure_linker();
    this_transpiler.options.compile_target_builtins = options::CompileTargetBuiltins::Host;

    if !this_transpiler.options.production {
        this_transpiler
            .options
            .conditions
            .append_slice(&[b"development" as &[u8]])
            .map_err(|_| "error: out of memory".to_string())?;
    }

    this_transpiler.sync_resolver_opts();
    this_transpiler.resolver.env_loader = core::ptr::NonNull::new(this_transpiler.env);

    if bo.production {
        this_transpiler.options.jsx.development = false;
        this_transpiler.resolver.opts.jsx.development = false;
    }

    let mut reachable_file_count: usize = 0;
    let mut minify_duration: u64 = 0;
    let mut input_code_length: u64 = 0;

    let opt_output_dir: Box<[u8]> = this_transpiler.options.output_dir.clone();
    let opt_transform_only = this_transpiler.options.transform_only;

    let mut output_files: Vec<options::OutputFile> = if bo.transform_only {
        this_transpiler.options.import_path_format = options::ImportPathFormat::Relative;
        this_transpiler.options.allow_runtime = false;
        this_transpiler.resolver.opts.allow_runtime = false;

        let result = this_transpiler.transform(log, ctx_args.clone()).map_err(|e| format!("error: {}", e.name()))?;
        if log_ref.has_errors() && (!result.errors.is_empty() || result.output_files.is_empty()) {
            return Err(String::new());
        }
        result.output_files.into_vec()
    } else {
        if bo.outdir.is_empty() && !outfile.is_empty() {
            let mut entry_naming = b"./".to_vec();
            entry_naming.extend_from_slice(bun_paths::basename(outfile));
            this_transpiler.options.entry_naming = entry_naming.into_boxed_slice();
            if let Some(dir) = bun_core::dirname(outfile) {
                bo.outdir = dir.into();
            }
        }

        // Stack-owned mini event loop, as in build_command.rs.
        let mut event_loop = bun_event_loop::AnyEventLoop::init();

        let build_result = match BundleV2::generate_from_cli(
            this_transpiler,
            arena,
            Some(core::ptr::NonNull::from(&mut event_loop)),
            false,
            &mut reachable_file_count,
            &mut minify_duration,
            &mut input_code_length,
            None,
        ) {
            Ok(r) => r,
            Err(err) => return Err(format!("error: {}", err.name())),
        };

        if let Some(metafile_json) = build_result.metafile.as_deref() {
            if !bo.metafile.is_empty() && write {
                let file = bun_sys::File::make_open(
                    &bo.metafile,
                    bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::TRUNC,
                    0o664,
                )
                .map_err(|err| format!("{err}: could not open metafile {}", bun_core::fmt::quote(&bo.metafile)))?;
                file.write_all(metafile_json)
                    .map_err(|err| format!("{err}: could not write metafile {}", bun_core::fmt::quote(&bo.metafile)))?;
            }
        }
        build_result.output_files
    };

    let mut out = BuildOutput {
        module_count: reachable_file_count,
        transform_only: opt_transform_only,
        ..Default::default()
    };

    let output_files: &mut [options::OutputFile] = &mut output_files;
    let mut output_dir: &[u8] = &opt_output_dir;
    let will_be_one_file =
        output_files.len() == 1 && matches!(output_files[0].value, options::OutputFileValue::Buffer { .. });

    if output_dir.is_empty() && !outfile.is_empty() && will_be_one_file {
        output_dir = bun_core::dirname(outfile).unwrap_or(b".");
        output_files[0].dest_path = bun_paths::basename(outfile).into();
    }

    if outfile.is_empty() && output_files.len() == 1 && bo.outdir.is_empty() {
        // if --no-bundle is passed, it won't have an output dir
        let bytes = match &output_files[0].value {
            options::OutputFileValue::Buffer { bytes } => bytes.to_vec(),
            _ => Vec::new(),
        };
        out.stdout = Some(bytes);
        return Ok(out);
    }

    let mut root_path: &[u8] = output_dir;
    if root_path.is_empty() && ctx_args.entry_points.len() == 1 {
        root_path = bun_core::dirname(&ctx_args.entry_points[0]).unwrap_or(b".");
    }

    let root_dir = if !write {
        None
    } else if root_path.is_empty() || root_path == b"." {
        Some(bun_sys::Dir::cwd())
    } else {
        match bun_sys::Dir::cwd().make_open_path(root_path, Default::default()) {
            Ok(d) => Some(d),
            Err(err) => {
                return Err(format!("{err}: could not open output directory {}", bun_core::fmt::quote(root_path)));
            }
        }
    };

    for f in output_files.iter() {
        if let Some(root_dir) = &root_dir {
            if let Err(err) = f.write_to_disk(root_dir.fd) {
                out.write_errors
                    .push(format!("{err}: failed to write file {}", bun_core::fmt::quote(&f.dest_path)));
                continue;
            }
        }
        let kind = match f.output_kind {
            options::OutputKind::EntryPoint => OutputKind::EntryPoint,
            options::OutputKind::Chunk => OutputKind::Chunk,
            options::OutputKind::Asset => OutputKind::Asset,
            options::OutputKind::Sourcemap => OutputKind::SourceMap,
            options::OutputKind::MetafileJson => OutputKind::Metafile,
            _ => OutputKind::Other,
        };
        let contents = match &f.value {
            options::OutputFileValue::Buffer { bytes } => bytes.to_vec(),
            _ => Vec::new(),
        };
        out.files.push(OutputFile { path: lossy(&f.dest_path), kind, size: f.size, contents });
    }
    let _ = minify_duration;
    let _ = input_code_length;
    Ok(out)
}
