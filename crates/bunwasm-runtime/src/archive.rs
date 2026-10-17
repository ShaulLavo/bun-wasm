use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use crate::engine::{Args, NativeError, Record, Val};
use crate::natives::Table;

fn archive_error(error: std::io::Error) -> NativeError {
    let mut message = format!("ReadError: {error}");
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    NativeError::error(message)
}

fn normalized(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => output.push(name),
            Component::ParentDir => { output.pop(); }
            _ => {}
        }
    }
    output
}

fn tar_bytes(bytes: &[u8]) -> Result<Vec<u8>, NativeError> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut output = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes).read_to_end(&mut output).map_err(archive_error)?;
        return Ok(output);
    }
    Ok(bytes.to_vec())
}

fn create(entries: &[Val], gzip: bool, level: u8, mtime: u64) -> Result<Vec<u8>, NativeError> {
    let mut builder = tar::Builder::new(Vec::new());
    for entry in entries {
        let Val::Array(fields) = entry else { return Err(NativeError::type_error("Expected archive entry")); };
        let fields = Args(fields);
        let name = normalized(Path::new(fields.str(0)?));
        if name.as_os_str().is_empty() { continue; }
        let directory = fields.str(0)?.ends_with('/');
        let bytes = if directory { &[][..] } else { fields.bytes(1)? };
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(if directory { tar::EntryType::Directory } else { tar::EntryType::Regular });
        header.set_size(bytes.len() as u64);
        header.set_mode(if directory { 0o755 } else { 0o644 });
        header.set_mtime(mtime);
        header.set_cksum();
        let name_bytes = name.as_os_str().as_encoded_bytes();
        if !name_bytes.is_ascii() {
            builder.append_pax_extensions(Some(("path", name_bytes))).map_err(archive_error)?;
        }
        builder.append_data(&mut header, name, bytes).map_err(archive_error)?;
    }
    let bytes = builder.into_inner().map_err(archive_error)?;
    if !gzip { return Ok(bytes); }
    Ok(crate::encoding::compress(&bytes, level.min(10), crate::encoding::Wrapper::Gzip))
}

fn matches(path: &str, patterns: &[Val]) -> bool {
    let patterns: Vec<&str> = patterns.iter().filter_map(|v| if let Val::Str(s) = v { Some(s.as_str()) } else { None }).collect();
    let positives = patterns.iter().filter(|p| !p.starts_with('!'));
    let included = patterns.is_empty() || positives.clone().next().is_none()
        || positives.into_iter().any(|p| bun_glob::r#match(p.as_bytes(), path.as_bytes()).matches());
    included && !patterns.iter().filter_map(|p| p.strip_prefix('!'))
        .any(|p| bun_glob::r#match(p.as_bytes(), path.as_bytes()).matches())
}

fn files(bytes: &[u8], patterns: &[Val]) -> Result<Val, NativeError> {
    let bytes = tar_bytes(bytes)?;
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut files = Vec::new();
    for entry in archive.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        if !entry.header().entry_type().is_file() && !entry.header().entry_type().is_gnu_sparse() { continue; }
        let raw_name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let name = normalized(Path::new(&raw_name)).to_string_lossy().into_owned();
        if !matches(&name, patterns) { continue; }
        let mtime = mtime(entry.header());
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(archive_error)?;
        files.push(Record::new().set("name", name).set("bytes", Val::Bytes(bytes)).set("mtime", mtime).into());
    }
    Ok(Val::Array(files))
}

fn mtime(header: &tar::Header) -> f64 {
    let field = &header.as_bytes()[136..148];
    if field[0] & 0x80 == 0 { return header.mtime().unwrap_or(0) as f64 * 1000.0; }
    let mut seconds = i128::from(field[0] & 0x7f);
    for byte in &field[1..] { seconds = (seconds << 8) | i128::from(*byte); }
    if field[0] & 0x40 != 0 { seconds -= 1i128 << 95; }
    seconds as f64 * 1000.0
}

fn extract(bytes: &[u8], root: &str, patterns: &[Val]) -> Result<usize, NativeError> {
    let bytes = tar_bytes(bytes)?;
    std::fs::create_dir_all(root).map_err(archive_error)?;
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut count = 0;
    for entry in archive.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        let raw_name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let name = normalized(Path::new(&raw_name)).to_string_lossy().into_owned();
        if name.len() >= 4096 || !matches(&name, patterns) { continue; }
        let is_file = entry.header().entry_type().is_file() || entry.header().entry_type().is_gnu_sparse();
        if entry.unpack_in(root).map_err(archive_error)? && is_file { count += 1; }
    }
    Ok(count)
}


pub fn install(table: &mut Table) {
    table.add("archive.create", |a| {
        let entries = a.array(0).ok_or_else(|| NativeError::type_error("Expected archive entries"))?;
        create(entries, a.bool(1), a.u32(2)? as u8, a.num(3)? as u64).map(Val::Bytes)
    });
    table.add("archive.files", |a| files(a.bytes(0)?, a.array(1).unwrap_or(&[])));
    table.add("archive.extract", |a| {
        extract(a.bytes(0)?, a.str(1)?, a.array(2).unwrap_or(&[])).map(|count| Val::Num(count as f64))
    });
}
