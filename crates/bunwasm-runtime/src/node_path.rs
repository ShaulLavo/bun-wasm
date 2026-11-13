use bun_core::{ffi, strings};
use bun_node_path as path;
#[cfg(windows)]
use bun_paths::w_path_buffer_pool;
use bun_paths::{MAX_PATH_BYTES, PATH_MAX_WIDE};
use bytemuck::cast_slice;
#[cfg(windows)]
use bytemuck::cast_slice_mut;

use crate::data::{Args, NativeError, NativeResult, Record, Val};
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

#[derive(Clone, Copy)]
enum Encoding {
    String,
    Units,
}

impl Encoding {
    fn read(self, a: &Args<'_>, index: usize) -> Result<Vec<u16>, NativeError> {
        match self {
            Self::String => Ok(a.str(index)?.encode_utf16().collect()),
            Self::Units => Ok(units(a.bytes(index)?)),
        }
    }

    fn write(self, units: &[u16]) -> NativeResult {
        match self {
            Self::String => String::from_utf16(units).map(Val::Str).map_err(|_| {
                NativeError::error("Path string result contains an unpaired surrogate")
            }),
            Self::Units => Ok(bytes(units)),
        }
    }

    fn parsed(self, value: path::PathParsed<'_, u16>) -> NativeResult {
        Ok(Record::new()
            .set("root", self.write(value.root)?)
            .set("dir", self.write(value.dir)?)
            .set("base", self.write(value.base)?)
            .set("ext", self.write(value.ext)?)
            .set("name", self.write(value.name)?)
            .into())
    }
}

fn lexical(a: Args<'_>, encoding: Encoding) -> NativeResult {
    let windows = a.bool(0);
    let operation = a.str(1)?;
    let input = encoding.read(&a, 2)?;
    let suffix = if a.is_missing(3) {
        None
    } else {
        Some(encoding.read(&a, 3)?)
    };
    let value = match (operation, windows) {
        ("basename", false) => path::basename_posix_t(&input, suffix.as_deref()),
        ("basename", true) => path::basename_windows_t(&input, suffix.as_deref()),
        ("dirname", false) => path::dirname_posix_t(&input),
        ("dirname", true) => path::dirname_windows_t(&input),
        ("extname", false) => path::extname_posix_t(&input),
        ("extname", true) => path::extname_windows_t(&input),
        ("isAbsolute", false) => return Ok(path::is_absolute_posix_t(&input).into()),
        ("isAbsolute", true) => return Ok(path::is_absolute_windows_t(&input).into()),
        ("parse", false) => return encoding.parsed(path::parse_posix_t(&input)),
        ("parse", true) => return encoding.parsed(path::parse_windows_t(&input)),
        ("normalize", _) => {
            let mut output = vec![0; path::normalize_buf_len(&input)];
            let result = if windows {
                path::normalize_windows_t(&input, &mut output)
            } else {
                path::normalize_posix_t(&input, &mut output)
            };
            return encoding.write(result);
        }
        _ => return Err(NativeError::type_error("Unknown path operation")),
    };
    encoding.write(value)
}

fn path_slices(
    a: Args<'_>,
    index: usize,
    encoding: Encoding,
) -> Result<Vec<Vec<u16>>, NativeError> {
    let input = a
        .array(index)
        .ok_or_else(|| NativeError::type_error("Expected path array"))?;
    input
        .iter()
        .map(|v| encoding.read(&Args(std::slice::from_ref(v)), 0))
        .collect()
}

fn resolve_windows(a: Args<'_>) -> NativeResult {
    let cwd = units(a.bytes(0)?);
    let paths = path_slices(a, 1, Encoding::Units)?;
    let slices: Vec<_> = paths.iter().map(Vec::as_slice).collect();
    let size = path::resolve_buf_len(true, &slices).max(cwd.len() + 2);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    let result =
        windows_resolver::resolve_windows_guest_t(&slices, &cwd, &mut output, &mut scratch)
            .map_err(|error| NativeError::error(error.to_string()))?;
    Ok(bytes(result))
}

fn join(a: Args<'_>, encoding: Encoding) -> NativeResult {
    if matches!(encoding, Encoding::String) {
        return join_string(a);
    }
    let windows = a.bool(0);
    let paths = path_slices(a, 1, encoding)?;
    let slices: Vec<_> = paths.iter().map(Vec::as_slice).collect();
    let size = path::join_buf_len(windows, &slices);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    let result = if windows {
        path::join_windows_t(&slices, &mut output, &mut scratch)
    } else {
        path::join_posix_t(&slices, &mut output, &mut scratch)
    };
    encoding.write(result)
}

fn join_string(a: Args<'_>) -> NativeResult {
    let windows = a.bool(0);
    let input = a
        .array(1)
        .ok_or_else(|| NativeError::type_error("Expected path array"))?;
    let slices: Vec<_> = input
        .iter()
        .map(|value| Args(std::slice::from_ref(value)).str(0).map(str::as_bytes))
        .collect::<Result<_, _>>()?;
    let size = path::join_buf_len(windows, &slices);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    let result = if windows {
        path::join_windows_t(&slices, &mut output, &mut scratch)
    } else {
        path::join_posix_t(&slices, &mut output, &mut scratch)
    };
    std::str::from_utf8(result)
        .map(|value| Val::Str(value.to_owned()))
        .map_err(|_| NativeError::error("Path string result contains invalid UTF-8"))
}

fn relative(a: Args<'_>, encoding: Encoding) -> NativeResult {
    let from = encoding.read(&a, 1)?;
    let to = encoding.read(&a, 2)?;
    let size = path::relative_buf_len(&from, &to);
    let mut output = vec![0; size];
    let mut scratch = vec![0; size];
    output[..to.len()].copy_from_slice(&to);
    let result = if a.bool(0) {
        relative_windows_resolved(&from, &mut output, to.len(), &mut scratch)?
    } else {
        relative_posix_resolved(&from, &mut output, to.len(), &mut scratch)?
    };
    encoding.write(result)
}

pub fn install(table: &mut Table) {
    table.add("nodePath.lexicalString", |a| lexical(a, Encoding::String));
    table.add("nodePath.lexicalUnits", |a| lexical(a, Encoding::Units));
    table.add("nodePath.resolveWindows", resolve_windows);
    table.add("nodePath.joinString", |a| join(a, Encoding::String));
    table.add("nodePath.joinUnits", |a| join(a, Encoding::Units));
    table.add("nodePath.relativeString", |a| relative(a, Encoding::String));
    table.add("nodePath.relativeUnits", |a| relative(a, Encoding::Units));
}
