//! Exact link-interface signatures shared by BundleV2 and native bake.
#![allow(non_snake_case)]
use super::{Driver, File, finalize, graph};
use bun_bundler::{
    bake_types::{CacheEntry, Graph},
    bundle_v2::{BundleV2, DevServerOutput},
};

type Error = bun_bundler::Error;

#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__barrel_needed_exports(
    ptr: *mut (),
) -> *mut bun_collections::StringArrayHashMap<bun_collections::StringHashMap<()>> {
    unsafe { &raw mut (*ptr.cast::<Driver>()).graph.barrel_needed_exports }
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__log_for_resolution_failures(
    ptr: *mut (),
    path: &[u8],
    _side: Graph,
) -> *mut bun_ast::Log {
    let logs = unsafe { &mut (*ptr.cast::<Driver>()).resolution_logs };
    &mut **logs
        .entry(path.to_vec())
        .or_insert_with(|| Box::new(bun_ast::Log::init()))
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__finalize_bundle(
    ptr: *mut (),
    bundle: *mut BundleV2<'_>,
    result: *mut DevServerOutput<'_>,
) -> Result<(), Error> {
    // The arena owns the slice allocation, but its Chunk payloads own Vecs.
    // Native bake destroys those payloads after indexing on every outcome.
    let result = unsafe { &mut *result };
    let answer = unsafe { finalize::finalize(&mut *ptr.cast::<Driver>(), &mut *bundle, result) };
    unsafe {
        core::ptr::drop_in_place(core::ptr::slice_from_raw_parts_mut(
            result.chunks.as_mut_ptr(),
            result.chunks.len(),
        ));
    }
    answer
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__handle_parse_task_failure(
    ptr: *mut (),
    _err: Error,
    _side: Graph,
    path: &[u8],
    log: *const bun_ast::Log,
    _bundle: *mut BundleV2<'_>,
) -> Result<(), Error> {
    unsafe {
        (*ptr.cast::<Driver>()).graph.client_graph.insert_failure(
            graph::incremental_graph::InsertFailureKey::AbsPath(path),
            &*log,
            false,
        )?;
    }
    Ok(())
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__put_or_overwrite_asset(
    ptr: *mut (),
    path: *const (),
    contents: &[u8],
    hash: u64,
) -> Result<(), Error> {
    let hashes = unsafe { &mut (*ptr.cast::<Driver>()).asset_hashes };
    let files = unsafe { &mut (*ptr.cast::<Driver>()).files };
    // The bundler erases bun_resolver::fs::Path at this boundary.
    let path = unsafe { &*path.cast::<bun_resolver::fs::Path<'_>>() };
    let url = format!(
        "/_bun/asset/{}{}",
        hex(hash),
        String::from_utf8_lossy(path.name().ext)
    );
    let mime = match path.name().ext {
        b".png" => "image/png",
        b".jpg" | b".jpeg" => "image/jpeg",
        b".svg" => "image/svg+xml",
        b".webp" => "image/webp",
        b".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    if let Some(old) = hashes.insert(path.text.to_vec(), hash) {
        let shared = hashes
            .iter()
            .any(|(key, value)| *value == old && bun_paths::extension(key) == path.name().ext);
        if old != hash && !shared {
            files.remove(&format!(
                "/_bun/asset/{}{}",
                hex(old),
                String::from_utf8_lossy(path.name().ext)
            ));
        }
    }
    files.insert(
        url.clone(),
        File {
            path: url,
            contents: contents.to_vec(),
            mime: mime.into(),
        },
    );
    Ok(())
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__track_resolution_failure(
    _ptr: *mut (),
    _source: &[u8],
    _specifier: &[u8],
    _side: Graph,
    _loader: bun_ast::Loader,
) -> Result<(), Error> {
    // Resolution logs insert the failed importer in the graph. The watcher
    // retries that importer when directory contents change.
    Ok(())
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__is_file_cached(
    ptr: *mut (),
    path: &[u8],
    side: Graph,
) -> Option<CacheEntry> {
    unsafe { (*ptr.cast::<Driver>()).graph.cached(path, side) }
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__asset_hash(ptr: *mut (), path: &[u8]) -> Option<u64> {
    unsafe { (*ptr.cast::<Driver>()).asset_hashes.get(path).copied() }
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__current_bundle_start_data(ptr: *mut ()) -> *mut () {
    unsafe {
        let start = &mut (*ptr.cast::<Driver>()).start;
        start.as_mut().expect("active bundle") as *mut _ as *mut ()
    }
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__register_barrel_with_deferrals(
    ptr: *mut (),
    path: &[u8],
) -> Result<(), Error> {
    unsafe {
        (*ptr.cast::<Driver>())
            .graph
            .barrel_files_with_deferrals
            .put(path, ())?;
    }
    Ok(())
}
#[unsafe(no_mangle)]
fn __bun_dispatch__DevServerHandle__Bake__register_barrel_export(
    ptr: *mut (),
    path: &[u8],
    alias: &[u8],
) {
    let exports = unsafe { &mut (*ptr.cast::<Driver>()).graph.barrel_needed_exports };
    let entry = exports.get_or_put(path).expect("allocation");
    entry.value_ptr.put(alias, ()).expect("allocation");
}

fn hex(value: u64) -> String {
    let mut bytes = [0u8; 16];
    bun_core::fmt::bytes_to_hex_lower(&value.to_ne_bytes(), &mut bytes);
    String::from_utf8(bytes.to_vec()).unwrap()
}
