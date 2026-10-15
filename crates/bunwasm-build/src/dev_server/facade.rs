//! Host-independent context for Bun's unchanged incremental graph.
use super::{RouteIndexAndRecurseFlag, SerializedFailure, Side, incremental_graph, route_bundle};
use crate::bake;
use bun_ast::Loader;
use bun_collections::{ArrayHashMap, StringArrayHashMap, bit_set::DynamicBitSet};

#[repr(u8)]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub(crate) enum FileKind {
    Unknown = 0,
    Js = 1,
    Asset = 2,
    Css = 3,
}

#[repr(u8)]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub(crate) enum ChunkKind {
    InitialResponse = 0,
    HmrChunk = 1,
}

#[derive(Copy, Clone, Eq, PartialEq)]
pub(crate) enum TraceImportGoal {
    FindCss,
    FindClientModules,
    FindErrors,
}

pub(crate) struct IncrementalResult {
    pub(crate) framework_routes_affected: Vec<RouteIndexAndRecurseFlag>,
    pub(crate) html_routes_soft_affected: Vec<route_bundle::Index>,
    pub(crate) html_routes_hard_affected: Vec<route_bundle::Index>,
    pub(crate) had_adjusted_edges: bool,
    pub(crate) client_components_added: Vec<incremental_graph::ServerFileIndex>,
    pub(crate) client_components_removed: Vec<incremental_graph::ServerFileIndex>,
    pub(crate) failures_removed: Vec<SerializedFailure>,
    pub(crate) client_components_affected: Vec<incremental_graph::ServerFileIndex>,
    pub(crate) failures_added: Vec<SerializedFailure>,
}
impl IncrementalResult {
    pub(crate) const EMPTY: IncrementalResult = IncrementalResult {
        framework_routes_affected: Vec::new(),
        html_routes_soft_affected: Vec::new(),
        html_routes_hard_affected: Vec::new(),
        had_adjusted_edges: false,
        failures_removed: Vec::new(),
        failures_added: Vec::new(),
        client_components_added: Vec::new(),
        client_components_removed: Vec::new(),
        client_components_affected: Vec::new(),
    };

    /// Clears each list retaining capacity, asserts `failures_removed` was
    /// already drained, and intentionally leaves `had_adjusted_edges`
    /// untouched.
    pub(crate) fn reset(&mut self) {
        self.framework_routes_affected.clear();
        self.html_routes_soft_affected.clear();
        self.html_routes_hard_affected.clear();
        self.client_components_added.clear();
        self.client_components_removed.clear();
        debug_assert!(self.failures_removed.is_empty());
        self.failures_removed.clear();
        self.client_components_affected.clear();
        self.failures_added.clear();
        // NOTE: `had_adjusted_edges` is NOT reset here (matches spec).
    }
}

pub(crate) struct GraphTraceState {
    pub(crate) client_bits: DynamicBitSet,
    pub(crate) server_bits: DynamicBitSet,
}
impl GraphTraceState {
    #[inline]
    pub(crate) fn bits(&mut self, side: Side) -> &mut DynamicBitSet {
        match side {
            Side::Client => &mut self.client_bits,
            Side::Server => &mut self.server_bits,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.server_bits.unmanaged.set_all(false);
        self.client_bits.unmanaged.set_all(false);
    }

    pub(crate) fn resize(&mut self, side: Side, new_size: usize) -> Result<(), crate::Error> {
        let b = self.bits(side);
        if b.unmanaged.bit_length < new_size {
            b.resize(new_size, false)?;
        }
        Ok(())
    }

    pub(crate) fn clear_and_free(&mut self) {
        self.client_bits
            .resize(0, false)
            .expect("freeing memory can not fail");
        self.server_bits
            .resize(0, false)
            .expect("freeing memory can not fail");
    }
}

pub(crate) struct HotUpdateContext<'a> {
    /// bundle_v2.Graph.input_files.items(.source)
    pub sources: &'a [bun_ast::Source],
    /// bundle_v2.Graph.ast.items(.import_records)
    pub import_records: &'a [bun_ast::import_record::List<'a>],
    /// bundle_v2.Graph.input_files.items(.loader)
    pub loaders: &'a [Loader],
    /// Which files have a server-component boundary.
    pub server_to_client_bitset: DynamicBitSet,
    /// Used to reduce calls to the IncrementalGraph hash table.
    /// First half is for client graph, second half for server.
    pub resolved_index_cache: &'a mut [CachedFileIndex],
    /// Used to tell if the server should replace or append import records.
    pub server_seen_bit_set: DynamicBitSet,
    pub gts: &'a mut GraphTraceState,
}

/// Sentinel-encoded `Option<FileIndex>` packed into a `u32` (`u32::MAX` == none).
/// Side-erased so the `resolved_index_cache` backing slice stores it directly;
/// callers re-tag with the correct `FileIndex<SIDE>` on `unwrap`.
#[repr(transparent)]
#[derive(Copy, Clone, Eq, PartialEq)]
pub(crate) struct CachedFileIndex(pub u32);
impl CachedFileIndex {
    pub(crate) const NONE: Self = Self(u32::MAX);
    #[inline]
    pub(crate) fn unwrap<const SIDE: bake::Side>(
        self,
    ) -> Option<incremental_graph::FileIndex<SIDE>> {
        if self.0 == u32::MAX {
            None
        } else {
            Some(incremental_graph::FileIndex::<SIDE>::init(self.0))
        }
    }
}
impl<const SIDE: bake::Side> From<Option<incremental_graph::FileIndex<SIDE>>> for CachedFileIndex {
    fn from(v: Option<incremental_graph::FileIndex<SIDE>>) -> Self {
        match v {
            Some(i) => Self(i.get()),
            None => Self::NONE,
        }
    }
}

impl<'a> HotUpdateContext<'a> {
    pub(crate) fn get_cached_index(
        &mut self,
        side: bake::Side,
        i: impl Into<bun_ast::Index>,
    ) -> &mut CachedFileIndex {
        let i: bun_ast::Index = i.into();
        let len = self.sources.len();
        let start = match side {
            bake::Side::Client => 0,
            bake::Side::Server => len,
        };

        &mut self.resolved_index_cache[start..][..len][i.get() as usize]
    }
}

#[derive(Default)]
pub(crate) struct EntryPointList {
    pub(crate) set: bun_collections::StringArrayHashMap<entry_point_list::Flags>,
}

pub(crate) mod entry_point_list {
    bitflags::bitflags! {
        #[derive(Default, Copy, Clone)]
        #[repr(transparent)]
        pub struct Flags: u8 {
            const CLIENT = 1 << 0;
            const SERVER = 1 << 1;
            const SSR = 1 << 2;
            /// When this is set, also set CLIENT
            const CSS = 1 << 3;
            /// The html file of a route. When this is set, also set CLIENT
            const HTML = 1 << 4;
        }
    }
}

impl EntryPointList {
    pub(crate) fn empty() -> EntryPointList {
        EntryPointList::default()
    }

    pub(crate) fn append_js(&mut self, abs_path: &[u8], side: bake::Graph) -> crate::Result<()> {
        self.append(
            abs_path,
            match side {
                bake::Graph::Server => entry_point_list::Flags::SERVER,
                bake::Graph::Client => entry_point_list::Flags::CLIENT,
                bake::Graph::Ssr => entry_point_list::Flags::SSR,
            },
        )
    }

    pub(crate) fn append_css(&mut self, abs_path: &[u8]) -> crate::Result<()> {
        self.append(
            abs_path,
            entry_point_list::Flags::CLIENT | entry_point_list::Flags::CSS,
        )
    }

    /// The html file of a route: an import attribute or a bunfig `[loader]` entry may have made it html.
    pub(crate) fn append_html(&mut self, abs_path: &[u8]) -> crate::Result<()> {
        self.append(
            abs_path,
            entry_point_list::Flags::CLIENT | entry_point_list::Flags::HTML,
        )
    }

    /// Deduplictes requests to bundle the same file twice.
    pub(crate) fn append(
        &mut self,
        abs_path: &[u8],
        flags: entry_point_list::Flags,
    ) -> crate::Result<()> {
        let gop = self.set.get_or_put(abs_path)?;
        if gop.found_existing {
            *gop.value_ptr |= flags;
        } else {
            *gop.value_ptr = flags;
        }
        Ok(())
    }
}
