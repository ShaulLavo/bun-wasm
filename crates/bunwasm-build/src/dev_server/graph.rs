//! Bun's incremental graph with a host-independent owner. The graph, packed
//! maps and error serialization compile directly from the pinned Bun sources.
use bun_bundler::bake_types::{CacheEntry, CacheKind};
use bun_collections::{ArrayHashMap, StringArrayHashMap, bit_set::DynamicBitSet};

pub(crate) use bun_bundler::bake_types::{Graph, Side};
pub(crate) use facade::*;
pub(crate) use serialized_failure::SerializedFailure;

#[path = "facade.rs"]
mod facade;

#[path = "../../../../vendor/bun/src/runtime/bake/dev_server/incremental_graph.rs"]
#[allow(dead_code, clippy::all)] // Unchanged pinned Bun module; upstream owns its lint policy.
pub(crate) mod incremental_graph;
#[path = "../../../../vendor/bun/src/runtime/bake/dev_server/packed_map.rs"]
#[allow(dead_code, clippy::all)] // Unchanged pinned Bun module; upstream owns its lint policy.
pub(crate) mod packed_map;
#[path = "../../../../vendor/bun/src/runtime/bake/dev_server/serialized_failure.rs"]
#[allow(dead_code, clippy::all)] // Unchanged pinned Bun module; upstream owns its lint policy.
pub(crate) mod serialized_failure;

pub(crate) mod dev_server_body {
    pub(crate) use super::{CachedFileIndex, HotUpdateContext};
}

pub(crate) const CLIENT_PREFIX: &str = "/_bun/client";

pub(crate) struct HmrRuntime {
    pub(crate) code: &'static bun_core::ZStr,
    #[allow(dead_code)] // Required shape of Bun's shared graph context.
    pub(crate) line_count: u32,
}

pub(crate) fn get_hmr_runtime(side: Side) -> HmrRuntime {
    assert_eq!(
        side,
        Side::Client,
        "the frontend server has no server runtime"
    );
    static CODE: std::sync::OnceLock<Box<[u8]>> = std::sync::OnceLock::new();
    let code = CODE.get_or_init(|| {
        let mut code = include_bytes!("../../generated/bake.client.js").to_vec();
        code.push(0);
        code.into_boxed_slice()
    });
    HmrRuntime {
        code: bun_core::ZStr::from_slice_with_nul(code),
        line_count: bun_core::strings::count_char(code, b'\n') as u32,
    }
}

pub(crate) mod route_bundle {
    pub(crate) enum Marker {}
    pub(crate) type Index = bun_core::GenericIndex<u32, Marker>;
}

#[allow(dead_code)] // Shape required by Bun's included graph, including its unused server half.
pub(crate) mod source_map_store {
    use super::packed_map;

    #[derive(Copy, Clone, Default)]
    pub(crate) struct Key(u64);

    impl Key {
        pub(crate) const fn init(value: u64) -> Self {
            Self(value)
        }
        pub(crate) const fn get(self) -> u64 {
            self.0
        }
    }

    #[derive(Default)]
    pub(crate) struct Entry {
        pub(crate) ref_count: u32,
        pub(crate) paths: Box<[Box<[u8]>]>,
        pub(crate) files: Vec<packed_map::Shared>,
        pub(crate) overlapping_memory_cost: u32,
    }
}

#[derive(Copy, Clone)]
#[allow(dead_code)] // Route payload shape required by Bun's included incremental graph.
pub(crate) struct RouteIndexAndRecurseFlag(pub(crate) u32);

/// Graph execution is synchronous on the guest's single thread.
pub(crate) struct GraphSafetyLock;

impl GraphSafetyLock {
    pub(crate) fn assert_locked(&self) {}
}

/// The host's filesystem notification owns watches, so no graph key is borrowed.
#[derive(Default)]
pub(crate) struct DirectoryWatchStore;

impl DirectoryWatchStore {
    pub(crate) fn remove_dependencies_for_file(&mut self, _path: &[u8]) {}
}

#[derive(Default)]
pub(crate) struct Assets;

impl Assets {
    pub(crate) fn unref_by_path(&mut self, _path: &[u8]) {
        // CSS responses use stable path hashes and are overwritten in place.
        // Retain the last good response while an edit contains a parse error.
    }
}

/// Always allocate with `new`: the unchanged graph recovers this owner from
/// the inline graph field and requires its address to stay fixed.
pub(crate) struct DevServer {
    pub(crate) root: Box<[u8]>,
    pub(crate) configuration_hash_key: [u8; 16],
    pub(crate) client_graph: incremental_graph::IncrementalGraph<{ Side::Client }>,
    pub(crate) server_graph: incremental_graph::IncrementalGraph<{ Side::Server }>,
    pub(crate) graph_safety_lock: GraphSafetyLock,
    pub(crate) incremental_result: IncrementalResult,
    pub(crate) bundling_failures: ArrayHashMap<serialized_failure::OwnerPacked, SerializedFailure>,
    pub(crate) directory_watchers: DirectoryWatchStore,
    pub(crate) assets: Assets,
    pub(crate) route_lookup:
        ArrayHashMap<incremental_graph::ServerFileIndex, RouteIndexAndRecurseFlag>,
    pub(crate) barrel_files_with_deferrals: StringArrayHashMap<()>,
    #[allow(dead_code)] // Required shape of Bun's shared graph context.
    pub(crate) barrel_needed_exports: StringArrayHashMap<bun_collections::StringHashMap<()>>,
}

impl DevServer {
    pub(crate) fn new(root: &[u8], configuration_hash_key: [u8; 16]) -> Box<Self> {
        Box::new(Self {
            root: root.into(),
            configuration_hash_key,
            client_graph: Default::default(),
            server_graph: Default::default(),
            graph_safety_lock: GraphSafetyLock,
            incremental_result: IncrementalResult::EMPTY,
            bundling_failures: Default::default(),
            directory_watchers: Default::default(),
            assets: Default::default(),
            route_lookup: Default::default(),
            barrel_files_with_deferrals: Default::default(),
            barrel_needed_exports: Default::default(),
        })
    }

    pub(crate) fn start_bundle(&mut self) {
        self.client_graph.reset();
        self.server_graph.reset();
        self.incremental_result.failures_removed.clear();
        self.incremental_result.reset();
    }

    pub(crate) fn trace_state(&self) -> crate::Result<GraphTraceState> {
        Ok(GraphTraceState {
            client_bits: DynamicBitSet::init_empty(self.client_graph.bundled_files.count())?,
            server_bits: DynamicBitSet::init_empty(self.server_graph.bundled_files.count())?,
        })
    }

    pub(crate) fn invalidate(&mut self, paths: &[Box<[u8]>]) -> crate::Result<EntryPointList> {
        let mut entries = EntryPointList::empty();
        self.client_graph.ensure_stale_bit_capacity(false)?;
        self.client_graph.invalidate(paths, &mut entries)?;
        Ok(entries)
    }

    #[cfg_attr(not(target_os = "wasi"), allow(dead_code))]
    pub(crate) fn cached(&self, path: &[u8], side: Graph) -> Option<CacheEntry> {
        if self.barrel_files_with_deferrals.contains_key(path) {
            return None;
        }
        match side {
            Graph::Client => cached(&self.client_graph, path),
            Graph::Server | Graph::Ssr => cached(&self.server_graph, path),
        }
    }

    pub(crate) fn initial_js(
        &mut self,
        entry: &[u8],
        refresh: &[u8],
        script_id: u64,
    ) -> crate::Result<Vec<u8>> {
        self.client_graph.reset();
        let index = self
            .client_graph
            .get_file_index(entry)
            .expect("HTML entry is indexed");
        let mut trace = self.trace_state()?;
        self.client_graph
            .trace_imports(index, &mut trace, TraceImportGoal::FindClientModules)?;
        if !refresh.is_empty() {
            let index = self
                .client_graph
                .get_file_index(refresh)
                .expect("refresh entry is indexed");
            self.client_graph.trace_imports(
                index,
                &mut trace,
                TraceImportGoal::FindClientModules,
            )?;
        }
        self.client_graph
            .take_js_bundle(&incremental_graph::TakeJSBundleOptionsClient {
                initial_response_entry_point: entry,
                react_refresh_entry_point: refresh,
                script_id: source_map_store::Key::init(script_id),
                ..Default::default()
            })
    }

    pub(crate) fn update_js(&mut self, script_id: u64) -> crate::Result<Vec<u8>> {
        self.client_graph
            .take_js_bundle(&incremental_graph::TakeJSBundleOptionsClient {
                kind: ChunkKind::HmrChunk,
                script_id: source_map_store::Key::init(script_id),
                ..Default::default()
            })
    }

    pub(crate) fn relative_path<'a>(
        &self,
        relative_path_buf: &'a mut bun_paths::PathBuffer,
        path: &'a [u8],
    ) -> &'a [u8] {
        if !bun_paths::is_absolute(path) {
            return path;
        }
        if path.len() > self.root.len()
            && path[self.root.len()] == b'/'
            && path.starts_with(&self.root)
        {
            return &path[self.root.len() + 1..];
        }
        if path.len() + self.root.len() * 2 >= bun_paths::MAX_PATH_BYTES {
            return path;
        }
        let len = bun_paths::resolve_path::relative_platform_buf::<
            bun_paths::resolve_path::platform::Auto,
            true,
        >(&mut relative_path_buf[..], &self.root, path)
        .len();
        bun_paths::resolve_path::platform_to_posix_in_place::<u8>(&mut relative_path_buf[..len]);
        &relative_path_buf[..len]
    }
}

fn cached<const SIDE: Side>(
    graph: &incremental_graph::IncrementalGraph<SIDE>,
    path: &[u8],
) -> Option<CacheEntry> {
    let index = graph.get_file_index(path)?;
    if graph.stale_files.is_set(index.get() as usize) {
        return None;
    }
    let kind = match graph.get_file_by_index(index).file_kind() {
        FileKind::Unknown => CacheKind::Unknown,
        FileKind::Js => CacheKind::Js,
        FileKind::Asset => CacheKind::Asset,
        FileKind::Css => CacheKind::Css,
    };
    Some(CacheEntry { kind })
}
