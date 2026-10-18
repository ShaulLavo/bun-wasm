//! Link-time hooks `bun_bundler` imports from the JavaScriptCore runtime
//! (`bun_runtime`, `bun_jsc`): JS plugins, the JS event loop, `--watch` and
//! bytecode generation. These paths are not selected by ordinary builds.
//! Bake hooks are implemented by `dev_server::hooks`.
//!
//! They are defined here rather than in `bunwasm-glue` because their
//! signatures use bundler types, and under LTO a definition whose Rust types
//! differ from the import's produces invalid wasm.
#![allow(non_snake_case)]

use core::ffi::c_void;
use core::ptr::NonNull;

use bun_bundler::bundle_v2::BundleV2;
use bun_bundler::bytecode_order::{CodeNamesRef, LinkedPayload};
use bun_bundler::options_impl::Format;

#[cold]
fn missing(what: &str) -> ! {
    panic!("{what} is not available in bun-wasm (needs JavaScriptCore)")
}

// ── JS plugins (`Bun.build({ plugins })`) ─────────────────────────────────

const PLUGINS: &str = "bundler plugins";

#[unsafe(no_mangle)]
extern "C" fn JSBundlerPlugin__anyMatches(
    _this: *const c_void,
    _namespace: *mut bun_core::String,
    _path: *mut bun_core::String,
    _is_on_load: bool,
) -> bool {
    missing(PLUGINS)
}
#[unsafe(no_mangle)]
extern "C" fn JSBundlerPlugin__hasOnBeforeParsePlugins(_this: *const c_void) -> i32 {
    missing(PLUGINS)
}
#[unsafe(no_mangle)]
extern "C" fn JSBundlerPlugin__callOnBeforeParsePlugins(
    _this: *const c_void,
    _ctx: *mut c_void,
    _namespace: *const bun_core::String,
    _path: *const bun_core::String,
    _args: *mut c_void,
    _result: *mut c_void,
    _should_continue_running: *mut i32,
) -> i32 {
    missing(PLUGINS)
}

// ── the JS event loop (`AnyEventLoop::Js`); the build uses the mini loop ──

const JS_LOOP: &str = "the JavaScript event loop";

#[unsafe(no_mangle)]
fn __bun_dispatch__JsEventLoop__Jsc__tick(_owner: *mut ()) {
    missing(JS_LOOP)
}
#[unsafe(no_mangle)]
fn __bun_dispatch__JsEventLoop__Jsc__auto_tick(_owner: *mut ()) {
    missing(JS_LOOP)
}
#[unsafe(no_mangle)]
fn __bun_dispatch__JsEventLoop__Jsc__js_poster(
    _owner: *mut (),
) -> bun_event_loop::any_event_loop::JsPoster {
    missing(JS_LOOP)
}

/// `bun build --watch`.
#[unsafe(no_mangle)]
fn __bun_jsc_enable_hot_module_reloading_for_bundler(_bv2: NonNull<BundleV2<'static>>) {
    missing("bun build --watch")
}

// ── bytecode (`--compile --bytecode`) ─────────────────────────────────────

const BYTECODE: &str = "bytecode output";

/// `bun_bundler::bundle_v2::dispatch::{EncoderStringTable, BytecodeLinkEncoder}`
/// are crate-private opaque types; any pointer has their ABI.
type Opaque = NonNull<c_void>;

#[unsafe(no_mangle)]
fn __bun_jsc_generate_cached_bytecode(
    _format: Format,
    _source: &[u8],
    _source_provider_url: &bun_core::String,
    _depth: u32,
    _optimize: bool,
    _external_strings: Option<Opaque>,
) -> Option<Box<[u8]>> {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_host_builtins() -> &'static [u8] {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_generate_internal_module_bytecode(
    _id: u32,
    _depth: u32,
    _external_strings: Option<Opaque>,
) -> Option<Box<[u8]>> {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_generate_internal_module_bytecode_from_source(
    _source: &[u8],
    _name: &[u8],
    _url: &[u8],
    _source_stamp: u32,
    _depth: u32,
    _external_strings: Option<Opaque>,
) -> Option<Box<[u8]>> {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_encoder_string_table_new() -> Opaque {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_encoder_string_table_take(_table: Opaque, _hot_strings: &[u64]) -> Box<[u8]> {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_encoder_string_table_slot(_table: Opaque, _wtf8: &[u8]) -> u32 {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_wtf_string_hash(_wtf8: &[u8]) -> u32 {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_new(
    _external_strings: Opaque,
    _hot_functions: &[u64],
    _known_functions: &[u64],
    _evaluated_modules: &[u64],
    _not_evaluated_modules: &[u64],
) -> Opaque {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_destroy(_encoder: Opaque) {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_add_module(
    _encoder: Opaque,
    _format: Format,
    _source: &[u8],
    _source_provider_url: &bun_core::String,
    _depth: u32,
    _optimize: bool,
    _names: &CodeNamesRef<'_>,
) -> bool {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_add_internal_module(
    _encoder: Opaque,
    _id: u32,
    _depth: u32,
    _names: &CodeNamesRef<'_>,
) -> bool {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_add_internal_module_from_source(
    _encoder: Opaque,
    _source: &[u8],
    _name: &[u8],
    _url: &[u8],
    _source_stamp: u32,
    _depth: u32,
    _names: &CodeNamesRef<'_>,
) -> bool {
    missing(BYTECODE)
}
#[unsafe(no_mangle)]
fn __bun_jsc_bytecode_link_encoder_finish(
    _encoder: Opaque,
    _module_count: usize,
) -> Option<LinkedPayload> {
    missing(BYTECODE)
}

// ── auto-install: `bun_install`'s package manager is not linked ───────────

/// The resolver asks for this only when a bare import is missing from
/// `node_modules` and auto-install is enabled; the error makes it report the
/// import as unresolved.
#[unsafe(no_mangle)]
fn __bun_resolver_init_package_manager(
    _log: NonNull<bun_ast::Log>,
    _install: Option<NonNull<bun_options_types::schema::api::BunInstall>>,
    _env: NonNull<bun_dotenv::Loader>,
    _prefer_offline: bool,
) -> Result<NonNull<dyn bun_install_types::resolver_hooks::AutoInstaller>, bun_errno::SystemErrno> {
    Err(bun_errno::SystemErrno::ENOSYS)
}
