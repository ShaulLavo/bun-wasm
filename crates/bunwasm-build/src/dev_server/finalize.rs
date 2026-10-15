//! Host-independent part of Bun's `DevServer::finalize_bundle`: index all
//! emitted nodes before diffing their import edges.
use super::{Driver, File, graph};
use bun_ast::{Index, Loader, Source, import_record};
use bun_bundler::options::TargetExt as _;
use bun_bundler::{
    CompileResult,
    Graph::InputFileColumns,
    bundle_v2::{BundleV2, DevServerOutput},
    bundled_ast::BundledAstColumns,
    chunk,
    linker_graph::FileColumns,
};
use bun_collections::bit_set::DynamicBitSet;
use graph::incremental_graph::{self, ProcessMode, ReceiveChunkContent};
use graph::{CachedFileIndex, Graph, GraphTraceState, HotUpdateContext, Side};

pub(super) fn finalize(
    state: &mut Driver,
    bv2: &mut BundleV2,
    result: &mut DevServerOutput<'_>,
) -> crate::Result<()> {
    let n_css = result.css_file_list.count();
    let n_html = result.html_files.count();
    let chunks_ptr = result.chunks.as_ptr();
    let chunks_len = result.chunks.len();
    let (js, rest) = result.chunks.split_at_mut(1);
    let js = &js[0];
    let (css, rest) = rest.split_at_mut(n_css);
    let html = &mut rest[..n_html];
    let sources = bv2.graph.input_files.items_source();
    let loaders = bv2.graph.input_files.items_loader();
    let imports = bv2.graph.ast.items_import_records();
    let targets = bv2.graph.ast.items_target();
    let mut resolved = vec![CachedFileIndex::NONE; sources.len() * 2];
    let mut trace = GraphTraceState {
        client_bits: DynamicBitSet::default(),
        server_bits: DynamicBitSet::default(),
    };
    let mut ctx = HotUpdateContext {
        sources,
        loaders,
        import_records: imports,
        server_to_client_bitset: DynamicBitSet::init_empty(sources.len())?,
        resolved_index_cache: &mut resolved,
        server_seen_bit_set: DynamicBitSet::default(),
        gts: &mut trace,
    };
    let quoted = bv2.linker.graph.files.items_quoted_source_contents();
    for (part, compiled) in js
        .content
        .javascript()
        .parts_in_chunk_in_order
        .iter()
        .zip(js.compile_results_for_chunk.iter())
    {
        let index = part.source_index;
        let escaped = quoted[index.get() as usize]
            .as_ref()
            .map(|value| value.as_slice().to_vec().into_boxed_slice());
        receive_js(
            &mut state.graph,
            &mut ctx,
            index,
            targets[index.get() as usize].bake_graph(),
            compiled,
            escaped,
        )?;
    }
    for (css_chunk, metadata) in css.iter_mut().zip(result.css_file_list.values()) {
        receive_css(
            state,
            bv2,
            &mut ctx,
            css_chunk,
            chunks_ptr,
            chunks_len,
            metadata.imported_on_server,
        )?;
    }
    for html_chunk in html.iter_mut() {
        receive_html(state, &mut ctx, html_chunk)?;
    }
    *ctx.gts = state.graph.trace_state()?;
    ctx.server_seen_bit_set =
        DynamicBitSet::init_empty(state.graph.server_graph.bundled_files.len())?;
    state.graph.incremental_result.had_adjusted_edges = false;
    for part in &js.content.javascript().parts_in_chunk_in_order {
        process_js(
            &mut state.graph,
            &mut ctx,
            part.source_index,
            targets[part.source_index.get() as usize].bake_graph(),
        )?;
    }
    for html_chunk in html.iter() {
        let index = Index::init(html_chunk.entry_point.source_index());
        state.graph.client_graph.process_chunk_dependencies(
            &mut ctx,
            ProcessMode::Normal,
            index,
        )?;
    }
    for css_chunk in css.iter() {
        let index = Index::init(css_chunk.entry_point.source_index());
        state
            .graph
            .client_graph
            .process_chunk_dependencies(&mut ctx, ProcessMode::Css, index)?;
    }
    state.graph.client_graph.ensure_stale_bit_capacity(false)?;
    state.graph.server_graph.ensure_stale_bit_capacity(false)?;
    render_html(state)
}

fn receive_js(
    graph: &mut graph::DevServer,
    ctx: &mut HotUpdateContext<'_>,
    index: Index,
    side: Graph,
    compiled: &CompileResult,
    escaped_source: Option<Box<[u8]>>,
) -> crate::Result<()> {
    let content = ReceiveChunkContent::Js {
        code: compiled.code().to_vec().into_boxed_slice(),
        source_map: Some(incremental_graph::ReceiveChunkSourceMap {
            chunk: compiled
                .source_map_chunk()
                .cloned()
                .unwrap_or_else(bun_sourcemap::Chunk::init_empty),
            escaped_source,
        }),
    };
    match side {
        Graph::Client => graph.client_graph.receive_chunk(ctx, index, content, false),
        Graph::Server | Graph::Ssr => {
            graph
                .server_graph
                .receive_chunk(ctx, index, content, side == Graph::Ssr)
        }
    }
}

fn process_js(
    graph: &mut graph::DevServer,
    ctx: &mut HotUpdateContext<'_>,
    index: Index,
    side: Graph,
) -> crate::Result<()> {
    match side {
        Graph::Client => {
            graph
                .client_graph
                .process_chunk_dependencies(ctx, ProcessMode::Normal, index)
        }
        Graph::Server | Graph::Ssr => {
            graph
                .server_graph
                .process_chunk_dependencies(ctx, ProcessMode::Normal, index)
        }
    }
}

fn receive_css(
    state: &mut Driver,
    bv2: &BundleV2,
    ctx: &mut HotUpdateContext<'_>,
    css_chunk: &mut chunk::Chunk,
    chunks_ptr: *const chunk::Chunk,
    chunks_len: usize,
    imported_on_server: bool,
) -> crate::Result<()> {
    let index = Index::init(css_chunk.entry_point.source_index());
    let chunk_ptr = css_chunk as *mut chunk::Chunk;
    // Bun's emitter reads chunk metadata and mutates only intermediate_output.
    // All chunks stay in the bundler arena until the caller finishes this pass.
    let code = unsafe {
        (&mut (*chunk_ptr).intermediate_output).code(
            None,
            &bv2.graph,
            &bv2.linker.graph,
            b"THIS_SHOULD_NEVER_BE_EMITTED_IN_DEV_MODE",
            &*chunk_ptr,
            std::slice::from_raw_parts(chunks_ptr, chunks_len),
            None,
            chunk::ReferencePathStyle::ImporterRelative,
            chunk::SourceMapShiftTracking::Disabled,
        )?
    };
    let key = ctx.sources[index.get() as usize]
        .path
        .key_for_incremental_graph();
    let id = bun_wyhash::hash(key);
    let path = css_path(id);
    let contents = code.buffer.to_vec();
    state.css_updates.push((id, contents.clone()));
    state.files.insert(
        path.clone(),
        File {
            path,
            contents,
            mime: "text/css".into(),
        },
    );
    state
        .graph
        .client_graph
        .receive_chunk(ctx, index, ReceiveChunkContent::Css(id), false)?;
    if imported_on_server {
        state
            .graph
            .server_graph
            .insert_css_file_on_server(ctx, index, key)?;
    }
    Ok(())
}

fn receive_html(
    state: &mut Driver,
    ctx: &mut HotUpdateContext<'_>,
    chunk: &mut chunk::Chunk,
) -> crate::Result<()> {
    let index = Index::init(chunk.entry_point.source_index());
    let code = html_javascript(
        &state.graph,
        index,
        ctx.import_records,
        ctx.sources,
        ctx.loaders,
    )?;
    state.graph.client_graph.receive_chunk(
        ctx,
        index,
        ReceiveChunkContent::Js {
            code,
            source_map: None,
        },
        false,
    )?;
    let client_index = ctx
        .get_cached_index(Side::Client, index)
        .unwrap::<{ Side::Client }>()
        .expect("HTML entry is indexed");
    state.graph.client_graph.bundled_files.values_mut()[client_index.get() as usize]
        .html_route_bundle_index = Some(graph::route_bundle::Index::init(0));
    let CompileResult::Html {
        code,
        script_injection_offset,
        ..
    } = chunk.compile_results_for_chunk.get_mut(0)
    else {
        unreachable!("HTML chunk")
    };
    state.html_base = std::mem::take(code).into_vec();
    state.html_injection_offset = *script_injection_offset as usize;
    chunk.entry_point.set_entry_point_id(0);
    Ok(())
}

// Same synthetic HTML module as Bun's generate_javascript_code_for_html_file.
fn html_javascript(
    graph: &graph::DevServer,
    index: Index,
    imports: &[import_record::List<'_>],
    sources: &[Source],
    loaders: &[Loader],
) -> crate::Result<Box<[u8]>> {
    let mut code = Vec::with_capacity(65536);
    code.extend_from_slice(b"  ");
    json_string(sources[index.get() as usize].path.pretty, &mut code)?;
    code.extend_from_slice(b": [ [");
    let mut any = false;
    for import in imports[index.get() as usize].as_slice() {
        if !javascript_import(graph, import, loaders) {
            continue;
        }
        if !any {
            code.push(b'\n');
        }
        any = true;
        code.extend_from_slice(b"    ");
        json_string(import.path.pretty, &mut code)?;
        code.extend_from_slice(b", 0,\n");
    }
    if any {
        code.extend_from_slice(b"  ");
    }
    code.extend_from_slice(b"], [], [], () => {}, false],\n");
    Ok(code.into_boxed_slice())
}

fn javascript_import(
    graph: &graph::DevServer,
    import: &import_record::ImportRecord,
    loaders: &[Loader],
) -> bool {
    if import.source_index.is_valid() {
        return loaders[import.source_index.get() as usize].is_javascript_like();
    }
    graph
        .client_graph
        .bundled_files
        .get(import.path.text)
        .is_some_and(|file| matches!(file.content, incremental_graph::Content::Js(_)))
}

fn json_string(value: &[u8], code: &mut Vec<u8>) -> crate::Result<()> {
    bun_js_printer::write_json_string::<_, { bun_js_printer::Encoding::Utf8 }>(value, code)?;
    Ok(())
}

fn css_path(id: u64) -> String {
    format!(
        "/_bun/asset/{}.css",
        bun_core::fmt::bytes_to_hex_lower_string(&id.to_ne_bytes())
    )
}

fn render_html(state: &mut Driver) -> crate::Result<()> {
    if state.html_base.is_empty() {
        return Ok(());
    }
    let Some(entry) = state
        .graph
        .client_graph
        .get_file_index(state.entry.as_bytes())
    else {
        return Ok(());
    };
    let mut trace = state.graph.trace_state()?;
    state.graph.client_graph.current_css_files.clear();
    state
        .graph
        .client_graph
        .trace_imports(entry, &mut trace, graph::TraceImportGoal::FindCss)?;
    let mut html = Vec::with_capacity(state.html_base.len() + 256);
    html.extend_from_slice(&state.html_base[..state.html_injection_offset]);
    for id in &state.graph.client_graph.current_css_files {
        html.extend_from_slice(b"<link rel=\"stylesheet\" href=\"");
        html.extend_from_slice(css_path(*id).as_bytes());
        html.extend_from_slice(b"\">");
    }
    html.extend_from_slice(b"<script type=\"module\" crossorigin src=\"/_bun/client/main.js\" data-bun-dev-server-script></script>");
    html.extend_from_slice(&state.html_base[state.html_injection_offset..]);
    state.html = html;
    Ok(())
}
