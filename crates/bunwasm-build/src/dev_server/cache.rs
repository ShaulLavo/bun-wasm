//! Persist clean package modules after Bun compiles them. The browser keys
//! this file by the complete project/dependency fingerprint. This payload
//! retains Bun's emitted wrappers, graph links and packed source maps.
use std::collections::HashSet;

use super::graph::{DevServer, FileKind, Side, incremental_graph, packed_map};

pub(crate) const PATH: &str = "/.bunwasm/deps-cache";
const MAGIC: &[u8; 8] = b"BUNDEPS1";

type ClientGraph = incremental_graph::IncrementalGraph<{ Side::Client }>;
type FileIndex = incremental_graph::FileIndex<{ Side::Client }>;

struct Node {
    path: Box<[u8]>,
    code: Box<[u8]>,
    special: bool,
    source_map: packed_map::Shared,
    imports: Vec<u32>,
}

pub(crate) fn restore(dev: &mut DevServer) -> Result<usize, String> {
    let bytes = match std::fs::read(PATH) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Cannot read dependency cache: {error}")),
    };
    restore_bytes(dev, &bytes)
}

pub(crate) fn restore_bytes(dev: &mut DevServer, bytes: &[u8]) -> Result<usize, String> {
    if !dev.client_graph.bundled_files.is_empty() {
        return Err("Dependency cache must be restored before the first build".into());
    }
    let nodes = decode(dev, bytes)?;
    let count = nodes.len();
    let restored = restore_nodes(nodes)?;
    dev.client_graph = restored;
    Ok(count)
}

pub(crate) fn encode(dev: &DevServer) -> Vec<u8> {
    let graph = &dev.client_graph;
    let selected = select(dev);
    let indices = remap(&selected);
    let mut bytes = MAGIC.to_vec();
    write_bytes(&mut bytes, &dev.root);
    bytes.extend_from_slice(&dev.configuration_hash_key);
    write_u32(
        &mut bytes,
        selected.iter().filter(|value| **value).count() as u32,
    );
    for (index, file) in graph.bundled_files.values().iter().enumerate() {
        if !selected[index] {
            continue;
        }
        write_node(&mut bytes, graph, index, file, &indices);
    }
    bytes
}

fn select(dev: &DevServer) -> Vec<bool> {
    let graph = &dev.client_graph;
    let mut selected: Vec<bool> = graph
        .bundled_files
        .iter()
        .enumerate()
        .map(|(index, (path, file))| eligible(dev, index, path, file))
        .collect();
    let mut excluded: Vec<usize> = selected
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| (!selected).then_some(index))
        .collect();
    while let Some(index) = excluded.pop() {
        exclude_dependents(graph, index, &mut selected, &mut excluded);
    }
    selected
}

fn eligible(dev: &DevServer, index: usize, path: &[u8], file: &incremental_graph::File) -> bool {
    package_path(&dev.root, path)
        && matches!(file.content, incremental_graph::Content::Js(_))
        && file.kind == FileKind::Js
        && !file.failed
        && !file.is_hmr_root
        && file.html_route_bundle_index.is_none()
        && !dev.barrel_files_with_deferrals.contains_key(path)
        && !dev.client_graph.stale_files.is_set(index)
}

fn package_path(root: &[u8], path: &[u8]) -> bool {
    path.starts_with(root)
        && (root == b"/" || path.get(root.len()) == Some(&b'/'))
        && path
            .windows(b"/node_modules/".len())
            .any(|part| part == b"/node_modules/")
}

fn exclude_dependents(
    graph: &ClientGraph,
    index: usize,
    selected: &mut [bool],
    excluded: &mut Vec<usize>,
) {
    let mut edge = graph.edge_lists[index].first_dep;
    while let Some(index) = edge {
        let link = graph.edges[index.get() as usize];
        edge = link.next_dependency;
        let dependent = link.dependency.get() as usize;
        if !selected[dependent] {
            continue;
        }
        selected[dependent] = false;
        excluded.push(dependent);
    }
}

fn remap(selected: &[bool]) -> Vec<Option<u32>> {
    let mut next = 0;
    selected
        .iter()
        .map(|selected| {
            if !selected {
                return None;
            }
            let index = next;
            next += 1;
            Some(index)
        })
        .collect()
}

fn write_node(
    bytes: &mut Vec<u8>,
    graph: &ClientGraph,
    index: usize,
    file: &incremental_graph::File,
    indices: &[Option<u32>],
) {
    let incremental_graph::Content::Js(code) = &file.content else {
        unreachable!()
    };
    write_bytes(bytes, &graph.bundled_files.keys()[index]);
    write_bytes(bytes, code);
    bytes.push(u8::from(file.is_special_framework_file));
    write_map(bytes, &file.source_map);
    let mut imports = Vec::new();
    let mut edge = graph.edge_lists[index].first_import;
    while let Some(index) = edge {
        let link = graph.edges[index.get() as usize];
        imports.push(
            indices[link.imported.get() as usize].expect("selected modules form a closed graph"),
        );
        edge = link.next_import;
    }
    write_u32(bytes, imports.len() as u32);
    for index in imports {
        write_u32(bytes, index);
    }
}

fn write_map(bytes: &mut Vec<u8>, map: &packed_map::Shared) {
    match map {
        packed_map::Shared::None => bytes.push(0),
        packed_map::Shared::LineCount(lines) => {
            bytes.push(1);
            write_u32(bytes, lines.get());
        }
        packed_map::Shared::Some(map) => {
            bytes.push(2);
            write_bytes(bytes, map.vlq());
            write_bytes(bytes, map.quoted_contents());
            bytes.extend_from_slice(&map.end_state.original_line.to_le_bytes());
            bytes.extend_from_slice(&map.end_state.original_column.to_le_bytes());
        }
    }
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn write_bytes(bytes: &mut Vec<u8>, value: &[u8]) {
    write_u32(bytes, value.len() as u32);
    bytes.extend_from_slice(value);
}

fn decode(dev: &DevServer, bytes: &[u8]) -> Result<Vec<Node>, String> {
    let mut reader = Reader(bytes);
    if reader.take(MAGIC.len())? != MAGIC {
        return Err("Invalid dependency cache format".into());
    }
    if reader.bytes()? != dev.root.as_ref() {
        return Err("Dependency cache belongs to a different project root".into());
    }
    if reader.take(16)? != dev.configuration_hash_key {
        return Err("Dependency cache belongs to a different build".into());
    }
    let count = reader.u32()? as usize;
    if count > reader.0.len() / 15 {
        return Err("Invalid dependency cache module count".into());
    }
    let mut nodes = Vec::with_capacity(count);
    let mut paths = HashSet::new();
    for _ in 0..count {
        let node = read_node(&mut reader, count)?;
        if !package_path(&dev.root, &node.path)
            || std::str::from_utf8(&node.path).is_err()
            || !paths.insert(node.path.clone())
        {
            return Err("Invalid or duplicate dependency cache path".into());
        }
        nodes.push(node);
    }
    if !reader.0.is_empty() {
        return Err("Unexpected bytes after dependency cache".into());
    }
    Ok(nodes)
}

fn read_node(reader: &mut Reader<'_>, count: usize) -> Result<Node, String> {
    let path = reader.bytes()?.into();
    let code = reader.bytes()?;
    if code.is_empty() || bun_core::strings::is_all_whitespace(code) {
        return Err("Empty module in dependency cache".into());
    }
    let special = match reader.byte()? {
        0 => false,
        1 => true,
        _ => return Err("Invalid dependency cache module flags".into()),
    };
    let source_map = reader.source_map(code)?;
    let imports = reader.u32()? as usize;
    if imports > reader.0.len() / 4 {
        return Err("Invalid dependency cache import count".into());
    }
    let mut imported = Vec::with_capacity(imports);
    let mut seen = HashSet::new();
    for _ in 0..imports {
        let index = reader.u32()?;
        if index as usize >= count || !seen.insert(index) {
            return Err("Invalid dependency cache import".into());
        }
        imported.push(index);
    }
    Ok(Node {
        path,
        code: code.into(),
        special,
        source_map,
        imports: imported,
    })
}

fn restore_nodes(nodes: Vec<Node>) -> Result<ClientGraph, String> {
    let mut graph = ClientGraph::default();
    let mut imports = Vec::with_capacity(nodes.len());
    for node in nodes {
        let slot = graph
            .bundled_files
            .get_or_put(&node.path)
            .map_err(|error| error.to_string())?;
        *slot.key_ptr = node.path;
        *slot.value_ptr = incremental_graph::File {
            kind: FileKind::Js,
            content: incremental_graph::Content::Js(node.code),
            source_map: node.source_map,
            is_special_framework_file: node.special,
            ..Default::default()
        };
        graph.edge_lists.push(Default::default());
        imports.push(node.imports);
    }
    for (index, imported) in imports.into_iter().enumerate() {
        for imported in imported.into_iter().rev() {
            restore_edge(&mut graph, index as u32, imported);
        }
    }
    graph
        .ensure_stale_bit_capacity(false)
        .map_err(|error| error.to_string())?;
    Ok(graph)
}

/// Recreate the serialized edge lists. Subsequent changes use Bun's unchanged
/// process_chunk_dependencies, invalidate and trace routines.
fn restore_edge(graph: &mut ClientGraph, dependency: u32, imported: u32) {
    let index = incremental_graph::EdgeIndex::init(graph.edges.len() as u32);
    let next_dependency = graph.edge_lists[imported as usize].first_dep;
    graph.edges.push(incremental_graph::Edge {
        dependency: FileIndex::init(dependency),
        imported: FileIndex::init(imported),
        next_import: graph.edge_lists[dependency as usize].first_import,
        next_dependency,
        prev_dependency: None,
    });
    if let Some(next) = next_dependency {
        graph.edges[next.get() as usize].prev_dependency = Some(index);
    }
    graph.edge_lists[dependency as usize].first_import = Some(index);
    graph.edge_lists[imported as usize].first_dep = Some(index);
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        if len > self.0.len() {
            return Err("Truncated dependency cache".into());
        }
        let (value, rest) = self.0.split_at(len);
        self.0 = rest;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    fn source_map(&mut self, code: &[u8]) -> Result<packed_map::Shared, String> {
        match self.byte()? {
            0 => Ok(packed_map::Shared::None),
            1 => {
                let lines = self.u32()?;
                if lines == u32::MAX || lines as usize != bun_core::strings::count_char(code, b'\n')
                {
                    return Err("Invalid dependency cache line count".into());
                }
                Ok(packed_map::Shared::LineCount(packed_map::LineCount::init(
                    lines,
                )))
            }
            2 => self.packed_map(),
            _ => Err("Invalid dependency cache source map".into()),
        }
    }

    fn packed_map(&mut self) -> Result<packed_map::Shared, String> {
        let mappings = self.bytes()?;
        if mappings.is_empty() {
            return Err("Empty dependency cache source map".into());
        }
        validate_mappings(mappings)?;
        let source = self.bytes()?;
        if source.len() < 2 || source[0] != b'"' || source[source.len() - 1] != b'"' {
            return Err("Invalid dependency cache source contents".into());
        }
        let line = self.u32()? as i32;
        let column = self.u32()? as i32;
        if line < 0 || column < 0 {
            return Err("Invalid dependency cache source map end state".into());
        }
        let mut chunk = bun_sourcemap::Chunk::init_empty();
        chunk
            .buffer
            .append_slice(mappings)
            .map_err(|error| error.to_string())?;
        chunk.end_state.original_line = line;
        chunk.end_state.original_column = column;
        Ok(packed_map::Shared::Some(
            packed_map::PackedMap::new_non_empty(&mut chunk, source.into()),
        ))
    }
}

/// Bun rewrites the first four VLQ fields with its assume-valid decoder.
/// Validate complete segments before those bytes enter the trusted graph.
fn validate_mappings(mappings: &[u8]) -> Result<(), String> {
    let mut original = [0i32; 4];
    let mut first = true;
    for line in mappings.split(|byte| *byte == b';') {
        let mut column = 0i32;
        if line.is_empty() {
            continue;
        }
        for segment in line.split(|byte| *byte == b',') {
            validate_segment(segment, &mut original, &mut column, first)?;
            first = false;
        }
    }
    if first {
        return Err("Dependency cache source map has no mappings".into());
    }
    Ok(())
}

fn validate_segment(
    segment: &[u8],
    original: &mut [i32; 4],
    column: &mut i32,
    first: bool,
) -> Result<(), String> {
    let mut fields = [0i32; 5];
    let mut count = 0;
    let mut offset = 0;
    while offset < segment.len() {
        if count == fields.len() {
            return Err("Invalid dependency cache source map segment".into());
        }
        let decoded = validated_vlq(segment, offset)?;
        fields[count] = decoded.value;
        count += 1;
        offset = decoded.start;
    }
    if !matches!(count, 1 | 4 | 5) || (first && count < 4) {
        return Err("Invalid dependency cache source map segment".into());
    }
    *column = add_coordinate(*column, fields[0])?;
    for (state, delta) in original.iter_mut().zip(fields[1..count].iter()) {
        *state = add_coordinate(*state, *delta)?;
    }
    // PackedMap stores one source. The joining code adds its own source index.
    if original[0] != 0 {
        return Err("Invalid dependency cache source index".into());
    }
    Ok(())
}

fn add_coordinate(value: i32, delta: i32) -> Result<i32, String> {
    value
        .checked_add(delta)
        .filter(|value| *value >= 0)
        .ok_or_else(|| "Invalid dependency cache source map coordinate".into())
}

fn validated_vlq(bytes: &[u8], offset: usize) -> Result<bun_sourcemap::vlq::VLQResult, String> {
    let end = bytes[offset..]
        .iter()
        .position(|byte| vlq_digit(*byte).is_some_and(|digit| digit < 32))
        .map(|len| offset + len + 1)
        .ok_or("Truncated dependency cache VLQ")?;
    let number = &bytes[offset..end];
    if number.len() > 7 || number.iter().any(|byte| vlq_digit(*byte).is_none()) {
        return Err("Invalid dependency cache VLQ".into());
    }
    if number.len() == 7 && vlq_digit(number[6]).unwrap() > 3 {
        return Err("Overflowing dependency cache VLQ".into());
    }
    Ok(bun_sourcemap::vlq::decode(bytes, offset))
}

fn vlq_digit(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}
