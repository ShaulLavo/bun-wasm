use bun_core::{ffi, strings};
use bun_node_path as path;
#[cfg(windows)]
use bun_paths::w_path_buffer_pool;
use bun_paths::{MAX_PATH_BYTES, PATH_MAX_WIDE};
use bytemuck::cast_slice;
#[cfg(windows)]
use bytemuck::cast_slice_mut;

use crate::engine::{Args, NativeError, NativeResult, Record, Val};
use crate::natives::Table;

use path::{CHAR_BACKWARD_SLASH, CHAR_FORWARD_SLASH};
const CHAR_DOT: u8 = b'.';
fn memmove<T: Copy>(destination: &mut [T], source: &[T]) {
    destination.copy_from_slice(source);
}

fn to_lower_t(value: u16) -> u16 {
    if (65..=90).contains(&value) {
        value + 32
    } else {
        value
    }
}

fn eql_ignore_case_t(a: &[u16], b: &[u16]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| to_lower_t(*x) == to_lower_t(*y))
}

include!(concat!(env!("OUT_DIR"), "/node_path_relative.rs"));

fn units(bytes: &[u8]) -> Vec<u16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_le_bytes)
        .collect()
}

fn bytes(units: &[u16]) -> Val {
    Val::Bytes(units.iter().flat_map(|c| c.to_le_bytes()).collect())
}

fn parsed(value: path::PathParsed<'_, u16>) -> Val {
    Record::new()
        .set("root", bytes(value.root))
        .set("dir", bytes(value.dir))
        .set("base", bytes(value.base))
        .set("ext", bytes(value.ext))
        .set("name", bytes(value.name))
        .into()
}

fn lexical(a: Args<'_>) -> NativeResult {
    let windows = a.bool(0);
    let operation = a.str(1)?;
    let input = units(a.bytes(2)?);
    let suffix = a.opt_bytes(3).map(units);
    let value = match (operation, windows) {
        ("basename", false) => path::basename_posix_t(&input, suffix.as_deref()),
        ("basename", true) => path::basename_windows_t(&input, suffix.as_deref()),
        ("dirname", false) => path::dirname_posix_t(&input),
        ("dirname", true) => path::dirname_windows_t(&input),
        ("extname", false) => path::extname_posix_t(&input),
        ("extname", true) => path::extname_windows_t(&input),
        ("isAbsolute", false) => return Ok(path::is_absolute_posix_t(&input).into()),
        ("isAbsolute", true) => return Ok(path::is_absolute_windows_t(&input).into()),
        ("parse", false) => return Ok(parsed(path::parse_posix_t(&input))),
        ("parse", true) => return Ok(parsed(path::parse_windows_t(&input))),
        ("normalize", _) => {
            let mut output = vec![0; path::normalize_buf_len(&input)];
            let result = if windows {
                path::normalize_windows_t(&input, &mut output)
            } else {
                path::normalize_posix_t(&input, &mut output)
            };
            return Ok(bytes(result));
        }
        _ => return Err(NativeError::type_error("Unknown path operation")),
    };
    Ok(bytes(value))
}

fn path_slices(a: Args<'_>, index: usize) -> Result<Vec<Vec<u16>>, NativeError> {
    let input = a
        .array(index)
        .ok_or_else(|| NativeError::type_error("Expected path array"))?;
    input
        .iter()
        .map(|v| Args(std::slice::from_ref(v)).bytes(0).map(units))
        .collect()
}

fn resolve_windows(a: Args<'_>) -> NativeResult {
    let cwd = units(a.bytes(0)?);
    let paths = path_slices(a, 1)?;
    let slices: Vec<_> = paths.iter().map(Vec::as_slice).collect();
    let size = path::resolve_buf_len(true, &slices).max(cwd.len() + 2);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    let result =
        windows_resolver::resolve_windows_guest_t(&slices, &cwd, &mut output, &mut scratch)
            .map_err(|error| NativeError::error(error.to_string()))?;
    Ok(bytes(result))
}

fn join(a: Args<'_>) -> NativeResult {
    let windows = a.bool(0);
    let paths = path_slices(a, 1)?;
    let slices: Vec<_> = paths.iter().map(Vec::as_slice).collect();
    let size = path::join_buf_len(windows, &slices);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    let result = if windows {
        path::join_windows_t(&slices, &mut output, &mut scratch)
    } else {
        path::join_posix_t(&slices, &mut output, &mut scratch)
    };
    Ok(bytes(result))
}

pub fn install(table: &mut Table) {
    table.add("nodePath.lexical", lexical);
    table.add("nodePath.resolveWindows", resolve_windows);
    table.add("nodePath.join", join);
    table.add("nodePath.relative", |a| {
        let from = units(a.bytes(1)?);
        let to = units(a.bytes(2)?);
        let size = path::relative_buf_len(&from, &to);
        let mut output = vec![0; size];
        let mut scratch = vec![0; size];
        output[..to.len()].copy_from_slice(&to);
        let result = if a.bool(0) {
            relative_windows_resolved(&from, &mut output, to.len(), &mut scratch)?
        } else {
            relative_posix_resolved(&from, &mut output, to.len(), &mut scratch)?
        };
        Ok(bytes(result))
    });
}
