//! Bun bake's incremental bundler with synchronous WASI I/O. The JS runtime
//! supplies HTTP/WebSockets and filesystem notifications; Bun owns the graph,
//! module wrappers, update protocol, refresh and error serialization.
use bun_alloc::Arena;
use bun_ast::Log;
use bun_bundler::{
    bake_types,
    bundle_v2::{BakeOptions, BundleV2, DevServerInput},
    options,
    transpiler::Transpiler,
};
use core::ptr::NonNull;
use graph::{EntryPointList, incremental_graph};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

mod cache;
mod finalize;
pub(crate) mod graph;
#[cfg(target_os = "wasi")]
mod hooks;

#[derive(Clone, Default)]
pub struct File {
    pub path: String,
    pub contents: Vec<u8>,
    pub mime: String,
}

#[derive(Default)]
pub struct Output {
    pub id: u32,
    pub version: String,
    pub html: Vec<u8>,
    pub files: Vec<File>,
    pub watch: Vec<String>,
    pub update: Vec<u8>,
    pub errors: Vec<u8>,
    pub logs: String,
}

pub(super) struct Driver {
    graph: Box<graph::DevServer>,
    entry: String,
    html: Vec<u8>,
    html_base: Vec<u8>,
    html_injection_offset: usize,
    files: BTreeMap<String, File>,
    css_updates: Vec<(u64, Vec<u8>)>,
    asset_hashes: HashMap<Vec<u8>, u64>,
    resolution_logs: BTreeMap<Vec<u8>, Box<Log>>,
    start: Option<DevServerInput>,
    generation: u64,
    refresh_entry: Option<String>,
    startup_logs: String,
}

thread_local! {
    static SERVERS: RefCell<BTreeMap<u32, Box<Driver>>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT: RefCell<u32> = const { RefCell::new(1) };
}

pub fn open(path: &str) -> Result<Output, String> {
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let entry = path.to_string_lossy().into_owned();
    let root = path.parent().unwrap().to_string_lossy();
    let refresh_entry = path
        .parent()
        .unwrap()
        .ancestors()
        .map(|root| root.join("node_modules/react-refresh/runtime.js"))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned());
    let mut state = Box::new(Driver {
        graph: graph::DevServer::new(root.as_bytes(), *b"b00b1e5b00b1e5aa"),
        entry,
        html: Vec::new(),
        html_base: Vec::new(),
        html_injection_offset: 0,
        files: BTreeMap::new(),
        css_updates: Vec::new(),
        asset_hashes: HashMap::new(),
        resolution_logs: BTreeMap::new(),
        start: None,
        generation: 0,
        refresh_entry,
        startup_logs: String::new(),
    });
    let cache_started = std::time::Instant::now();
    let restored = match cache::restore(&mut state.graph) {
        Ok(count) => count,
        Err(error) => {
            eprintln!("Discarded invalid dependency cache: {error}");
            0
        }
    };
    if restored > 0 {
        state.startup_phase("deps-cached", cache_started.elapsed().as_millis());
    } else {
        state.startup_phase("bundling-react", 0);
    }
    let mut entries = EntryPointList::empty();
    if let Some(refresh) = &state.refresh_entry {
        entries
            .append_js(refresh.as_bytes(), graph::Graph::Client)
            .map_err(error)?;
    }
    entries.append_html(state.entry.as_bytes()).map_err(error)?;
    let build_started = std::time::Instant::now();
    state.bundle(entries, &[])?;
    if restored == 0 {
        state.startup_phase("bundled-react", build_started.elapsed().as_millis());
    }
    let cache = cache::encode(&state.graph);
    state.files.insert(
        "/_bun/deps-cache".into(),
        File {
            path: "/_bun/deps-cache".into(),
            contents: cache,
            mime: "application/octet-stream".into(),
        },
    );
    let id = NEXT.with_borrow_mut(|next| {
        let id = *next;
        *next += 1;
        id
    });
    let result = state.output(id, false)?;
    SERVERS.with_borrow_mut(|servers| servers.insert(id, state));
    Ok(result)
}

pub fn rebuild(id: u32, paths: &[String]) -> Result<Output, String> {
    SERVERS.with_borrow_mut(|servers| {
        let state = servers.get_mut(&id).ok_or("Unknown dev server")?;
        let paths: Vec<Box<[u8]>> = paths.iter().map(|p| p.as_bytes().into()).collect();
        let entries = state.graph.invalidate(&paths).map_err(error)?;
        state.bundle(entries, &paths)?;
        state.output(id, true)
    })
}

pub fn close(id: u32) {
    SERVERS.with_borrow_mut(|servers| servers.remove(&id));
}

fn error(e: bun_bundler::Error) -> String {
    e.name().to_owned()
}

impl Driver {
    fn startup_phase(&mut self, phase: &str, duration: u128) {
        if std::env::var("BUN_WASM_STARTUP").as_deref() != Ok("1") {
            return;
        }
        use std::fmt::Write as _;
        let _ = writeln!(
            self.startup_logs,
            "[bunwasm:startup] {{\"phase\":\"{phase}\",\"duration\":{duration}}}"
        );
    }

    fn framework(&self) -> bake_types::Framework {
        let refresh = self
            .refresh_entry
            .as_ref()
            .map(|_| bake_types::ReactFastRefresh {
                import_source: b"react-refresh/runtime".as_slice().into(),
            });
        bake_types::Framework::new(Default::default(), None, refresh, false)
    }

    fn bundle(&mut self, entries: EntryPointList, changed: &[Box<[u8]>]) -> Result<(), String> {
        self.graph.start_bundle();
        self.css_updates.clear();
        self.resolution_logs.clear();
        if entries.set.is_empty() {
            return Ok(());
        }
        // Per-bundle lifetime follows Bun's normal CLI arena teardown. The
        // incremental graph only retains owned code, paths and packed maps.
        let arena = Box::into_raw(Box::new(Arena::new()));
        let log = Box::into_raw(Box::new(Log::init()));
        // SAFETY: these allocations remain live until run_bundle returns.
        let result = unsafe { self.run_bundle(&*arena, log, entries, changed) };
        // SAFETY: all transpilers/bundler were dropped by run_bundle.
        let log = unsafe { Box::from_raw(log) };
        let text = super::format_log(&log);
        unsafe {
            drop(Box::from_raw(arena));
        }
        result.map_err(|e| if text.is_empty() { error(e) } else { text })
    }

    fn run_bundle(
        &mut self,
        arena: &'static Arena,
        log: *mut Log,
        entries: EntryPointList,
        changed: &[Box<[u8]>],
    ) -> crate::Result<()> {
        let framework_owner = Box::new(self.framework());
        let framework_ptr = core::ptr::from_ref(&*framework_owner);
        // SAFETY: the Box remains live until both transpilers are destroyed.
        // The erased lifetime is restricted to this synchronous bundle pass.
        let framework: &'static bake_types::Framework = unsafe { &*framework_ptr };
        let server = self.transpiler(arena, log, false, framework)?;
        let client = match self.transpiler(arena, log, true, framework) {
            Ok(value) => value,
            Err(err) => {
                unsafe {
                    core::ptr::drop_in_place(server);
                }
                return Err(err);
            }
        };
        let server_ptr: *mut Transpiler<'static> = server;
        let client_ptr: *mut Transpiler<'static> = client;
        let mut event_loop = bun_event_loop::AnyEventLoop::init();
        let result = self.execute(server, client, arena, &mut event_loop, entries, changed);
        // SAFETY: execute dropped the BundleV2 that borrowed these values.
        unsafe {
            core::ptr::drop_in_place(client_ptr);
            core::ptr::drop_in_place(server_ptr);
        }
        result
    }

    fn execute(
        &mut self,
        server: &'static mut Transpiler<'static>,
        client: &'static mut Transpiler<'static>,
        arena: &'static Arena,
        event_loop: &mut bun_event_loop::AnyEventLoop,
        entries: EntryPointList,
        changed: &[Box<[u8]>],
    ) -> crate::Result<()> {
        let server_ptr = NonNull::from(&mut *server);
        let mut bundle = BundleV2::init(
            server,
            Some(BakeOptions {
                framework: self.framework(),
                client_transpiler: NonNull::from(&mut *client),
                ssr_transpiler: server_ptr,
                plugins: None,
            }),
            arena,
            Some(NonNull::from(event_loop)),
            false,
            None,
            arena,
        )?;
        // SAFETY: self is Box-stable in SERVERS or open(); callbacks only
        // borrow disjoint graph/output fields while this bundle is active.
        let owner = unsafe {
            bun_bundler::DevServerHandle::new(
                bun_bundler::DevServerHandleKind::Bake,
                self as *mut Self,
            )
        };
        bundle.dev_server = Some(owner);
        bundle.linker.dev_server = Some(owner);
        for path in changed {
            bundle.bust_dir_cache(path);
        }
        let mut input = bake_types::EntryPointList::empty();
        for (path, flags) in entries.set.keys().iter().zip(entries.set.values()) {
            input
                .set
                .put(path, bake_types::EntryPointFlags(flags.bits()))?;
        }
        let result = (|| {
            self.start = Some(bundle.start_from_bake_dev_server(&input)?);
            #[cfg(target_os = "wasi")]
            bundle.finish_wasi_dev_server()?;
            self.finish_resolution_failures()?;
            Ok(())
        })();
        self.start = None;
        bundle.deinit_without_freeing_arena();
        result
    }

    fn transpiler(
        &self,
        arena: &'static Arena,
        log: *mut Log,
        client: bool,
        framework: &'static bake_types::Framework,
    ) -> crate::Result<&'static mut Transpiler<'static>> {
        let opts = bun_options_types::schema::api::TransformOptions {
            absolute_working_dir: Some(self.graph.root.clone()),
            target: Some(if client {
                bun_options_types::schema::api::Target::Browser
            } else {
                bun_options_types::schema::api::Target::Bun
            }),
            define: Some(bun_options_types::schema::api::StringMap {
                keys: vec![Box::from(&b"process.env.NODE_ENV"[..])],
                values: vec![Box::from(&b"\"development\""[..])],
            }),
            ..Default::default()
        };
        let value = Transpiler::init(arena, log, opts, None)?;
        let value = arena.alloc(value);
        value.options.root_dir = self.graph.root.clone();
        value.options.public_path = b"/_bun/client".as_slice().into();
        value.options.output_format = options::Format::InternalBakeDev;
        value.options.hot_module_reloading = true;
        value.options.dev_server = (self as *const Self).cast();
        value.options.tree_shaking = false;
        value.options.source_map = options::SourceMapOption::External;
        value.options.jsx.development = true;
        value.options.css_chunking = true;
        value.options.react_fast_refresh = client && self.refresh_entry.is_some();
        value.options.framework = Some(framework);
        value.options.conditions.append_slice(&[b"development"])?;
        value.configure_defines()?;
        value.configure_linker();
        value.sync_resolver_opts();
        Ok(value)
    }

    fn finish_resolution_failures(&mut self) -> crate::Result<()> {
        for (path, log) in &self.resolution_logs {
            if log.has_errors() {
                self.graph.client_graph.insert_failure(
                    incremental_graph::InsertFailureKey::AbsPath(path),
                    log,
                    false,
                )?;
            }
        }
        Ok(())
    }

    fn output(&mut self, id: u32, changed: bool) -> Result<Output, String> {
        self.generation += 2;
        let update = if changed {
            self.hot_update().map_err(error)?
        } else {
            Vec::new()
        };
        let errors = self.error_update();
        if self.graph.bundling_failures.is_empty() && !self.html.is_empty() {
            let contents = self
                .graph
                .initial_js(
                    self.entry.as_bytes(),
                    self.refresh_entry.as_deref().unwrap_or("").as_bytes(),
                    self.generation,
                )
                .map_err(error)?;
            let path = "/_bun/client/main.js".to_owned();
            self.files.insert(
                path.clone(),
                File {
                    path,
                    contents,
                    mime: "text/javascript;charset=utf-8".into(),
                },
            );
        }
        if !self.graph.bundling_failures.is_empty() {
            let mut source = b"(()=>{const error=new Uint8Array([".to_vec();
            for failure in self.graph.bundling_failures.values() {
                for byte in &failure.data {
                    use std::io::Write as _;
                    let _ = write!(source, "{byte},");
                }
            }
            let prelude = format!(
                "]);const config={{bun:{:?}}};\n",
                bun_core::Global::package_json_version_with_canary
            );
            source.extend_from_slice(prelude.as_bytes());
            source.extend_from_slice(include_bytes!("../../generated/bake.error.js"));
            source.extend_from_slice(b"\n})();");
            let path = "/_bun/client/main.js".to_owned();
            self.files.insert(
                path.clone(),
                File {
                    path,
                    contents: source,
                    mime: "text/javascript;charset=utf-8".into(),
                },
            );
        }
        let watch = self
            .graph
            .client_graph
            .bundled_files
            .keys()
            .iter()
            .filter(|p| !p.is_empty() && !p.windows(14).any(|x| x == b"/node_modules/"))
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        Ok(Output {
            id,
            version: String::from_utf8_lossy(&self.graph.configuration_hash_key).into_owned(),
            html: self.html.clone(),
            files: self.files.values().cloned().collect(),
            watch,
            update,
            errors,
            logs: std::mem::take(&mut self.startup_logs),
        })
    }

    fn hot_update(&mut self) -> crate::Result<Vec<u8>> {
        if !self.graph.bundling_failures.is_empty() {
            return Ok(Vec::new());
        }
        if self.graph.client_graph.current_chunk_len == 0
            && self.css_updates.is_empty()
            && self
                .graph
                .incremental_result
                .html_routes_hard_affected
                .is_empty()
        {
            return Ok(Vec::new());
        }
        let mut bytes = vec![b'u'];
        // DevServer.finalize_bundle lists 1/2: HTML changes reload route 0;
        // ordinary client changes keep the existing module registry alive.
        if !self
            .graph
            .incremental_result
            .html_routes_hard_affected
            .is_empty()
        {
            bytes.extend_from_slice(&0i32.to_le_bytes());
        }
        bytes.extend_from_slice(&(-1i32).to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        let css = &self.graph.client_graph.current_css_files;
        bytes.extend_from_slice(&(css.len() as u32).to_le_bytes());
        for hash in css {
            let mut hex = [0u8; 16];
            bun_core::fmt::bytes_to_hex_lower(&hash.to_ne_bytes(), &mut hex);
            bytes.extend_from_slice(&hex);
        }
        bytes.extend_from_slice(&(-1i32).to_le_bytes());
        bytes.extend_from_slice(&(self.css_updates.len() as u32).to_le_bytes());
        for (hash, css) in &self.css_updates {
            let mut hex = [0u8; 16];
            bun_core::fmt::bytes_to_hex_lower(&hash.to_ne_bytes(), &mut hex);
            bytes.extend_from_slice(&hex);
            bytes.extend_from_slice(&(css.len() as u32).to_le_bytes());
            bytes.extend_from_slice(css);
        }
        if self.graph.client_graph.current_chunk_len > 0 && self.graph.bundling_failures.is_empty()
        {
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&self.graph.update_js(self.generation | 1)?);
        }
        Ok(bytes)
    }

    fn error_update(&self) -> Vec<u8> {
        let result = &self.graph.incremental_result;
        if result.failures_added.is_empty() && result.failures_removed.is_empty() {
            return Vec::new();
        }
        let mut bytes = vec![b'e'];
        bytes.extend_from_slice(&(result.failures_removed.len() as u32).to_le_bytes());
        for removed in &result.failures_removed {
            bytes.extend_from_slice(&removed.get_owner().encode().bits().to_le_bytes());
        }
        for added in &result.failures_added {
            bytes.extend_from_slice(&added.data);
        }
        bytes
    }
}
