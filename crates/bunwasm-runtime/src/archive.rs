use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use crate::engine::{Args, NativeError, Record, Val};
use crate::natives::Table;

fn archive_error(error: std::io::Error) -> NativeError {
    if error.kind() == std::io::ErrorKind::OutOfMemory {
        return crate::compression::out_of_memory();
    }
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
            Component::ParentDir => {
                output.pop();
            }
            _ => {}
        }
    }
    output
}

/// Reads the tar stream through the gzip decoder as the parser asks for it, so
/// a small hostile archive never expands into memory as a whole.
fn tar_reader(bytes: &[u8]) -> Box<dyn Read + '_> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Box::new(flate2::read::MultiGzDecoder::new(bytes));
    }
    Box::new(Cursor::new(bytes))
}

/// Bun's `Archive.files()` loop: entry data is read in 64 KiB steps with
/// fallible reservations, so an untrusted header size never drives allocation.
fn entry_bytes(entry: &mut impl Read, size: u64) -> Result<Vec<u8>, NativeError> {
    const STEP: usize = 64 * 1024;
    let size = usize::try_from(size).map_err(|_| crate::compression::out_of_memory())?;
    let mut data = Vec::new();
    while data.len() < size {
        let step = (size - data.len()).min(STEP);
        data.try_reserve(step)
            .map_err(|_| crate::compression::out_of_memory())?;
        let start = data.len();
        data.resize(start + step, 0);
        let read = entry.read(&mut data[start..]).map_err(archive_error)?;
        data.truncate(start + read);
        if read == 0 {
            break;
        }
    }
    Ok(data)
}

fn create(entries: &[Val], gzip: bool, level: u8, mtime: u64) -> Result<Vec<u8>, NativeError> {
    let mut builder = tar::Builder::new(Vec::new());
    for entry in entries {
        let Val::Array(fields) = entry else {
            return Err(NativeError::type_error("Expected archive entry"));
        };
        let fields = Args(fields);
        let name = normalized(Path::new(fields.str(0)?));
        if name.as_os_str().is_empty() {
            continue;
        }
        let directory = fields.str(0)?.ends_with('/');
        let bytes = if directory { &[][..] } else { fields.bytes(1)? };
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(if directory {
            tar::EntryType::Directory
        } else {
            tar::EntryType::Regular
        });
        header.set_size(bytes.len() as u64);
        header.set_mode(if directory { 0o755 } else { 0o644 });
        header.set_mtime(mtime);
        header.set_cksum();
        let name_bytes = name.as_os_str().as_encoded_bytes();
        if !name_bytes.is_ascii() {
            builder
                .append_pax_extensions(Some(("path", name_bytes)))
                .map_err(archive_error)?;
        }
        builder
            .append_data(&mut header, name, bytes)
            .map_err(archive_error)?;
    }
    let bytes = builder.into_inner().map_err(archive_error)?;
    if !gzip {
        return Ok(bytes);
    }
    let options = crate::compression::Options {
        level: i32::from(level.min(9)),
        ..Default::default()
    };
    let mode = crate::compression::Mode::Gzip;
    crate::compression::convert(
        mode,
        &options,
        &bytes,
        mode.finish_flush(),
        64 * 1024,
        usize::MAX,
    )
}

fn matches(path: &str, patterns: &[Val]) -> bool {
    let patterns: Vec<&str> = patterns
        .iter()
        .filter_map(|v| {
            if let Val::Str(s) = v {
                Some(s.as_str())
            } else {
                None
            }
        })
        .collect();
    let positives = patterns.iter().filter(|p| !p.starts_with('!'));
    let included = patterns.is_empty()
        || positives.clone().next().is_none()
        || positives
            .into_iter()
            .any(|p| bun_glob::r#match(p.as_bytes(), path.as_bytes()).matches());
    included
        && !patterns
            .iter()
            .filter_map(|p| p.strip_prefix('!'))
            .any(|p| bun_glob::r#match(p.as_bytes(), path.as_bytes()).matches())
}

fn files(bytes: &[u8], patterns: &[Val]) -> Result<Val, NativeError> {
    let mut archive = tar::Archive::new(tar_reader(bytes));
    let mut files = Vec::new();
    for entry in archive.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        if !entry.header().entry_type().is_file() && !entry.header().entry_type().is_gnu_sparse() {
            continue;
        }
        let raw_name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let name = normalized(Path::new(&raw_name))
            .to_string_lossy()
            .into_owned();
        if !matches(&name, patterns) {
            continue;
        }
        let mtime = mtime(entry.header());
        let size = entry.size();
        let bytes = entry_bytes(&mut entry, size)?;
        files.push(
            Record::new()
                .set("name", name)
                .set("bytes", Val::Bytes(bytes))
                .set("mtime", mtime)
                .into(),
        );
    }
    Ok(Val::Array(files))
}

fn mtime(header: &tar::Header) -> f64 {
    let field = &header.as_bytes()[136..148];
    if field[0] & 0x80 == 0 {
        return header.mtime().unwrap_or(0) as f64 * 1000.0;
    }
    let mut seconds = i128::from(field[0] & 0x7f);
    for byte in &field[1..] {
        seconds = (seconds << 8) | i128::from(*byte);
    }
    if field[0] & 0x40 != 0 {
        seconds -= 1i128 << 95;
    }
    seconds as f64 * 1000.0
}

fn extract(bytes: &[u8], root: &str, patterns: &[Val]) -> Result<usize, NativeError> {
    std::fs::create_dir_all(root).map_err(archive_error)?;
    let mut archive = tar::Archive::new(tar_reader(bytes));
    let mut count = 0;
    for entry in archive.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        let raw_name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let name = normalized(Path::new(&raw_name))
            .to_string_lossy()
            .into_owned();
        if name.len() >= 4096 || !matches(&name, patterns) {
            continue;
        }
        // Bun's libarchive loop counts every entry it writes, directories included.
        if entry.unpack_in(root).map_err(archive_error)? {
            count += 1;
        }
    }
    Ok(count)
}

pub fn install(table: &mut Table) {
    table.add("archive.create", |a| {
        let entries = a
            .array(0)
            .ok_or_else(|| NativeError::type_error("Expected archive entries"))?;
        create(entries, a.bool(1), a.u32(2)? as u8, a.num(3)? as u64).map(Val::Bytes)
    });
    table.add("archive.files", |a| {
        files(a.bytes(0)?, a.array(1).unwrap_or(&[]))
    });
    table.add("archive.extract", |a| {
        extract(a.bytes(0)?, a.str(1)?, a.array(2).unwrap_or(&[]))
            .map(|count| Val::Num(count as f64))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compression::{Mode, Options, convert, tests::measure};

    fn gzip_tar(name: &str, declared: u64, data: &[u8]) -> Vec<u8> {
        let mut header = tar::Header::new_ustar();
        header.set_path(name).unwrap();
        header.set_size(declared);
        header.set_mode(0o644);
        header.set_cksum();
        let mut tar = header.as_bytes().to_vec();
        tar.extend_from_slice(data);
        tar.resize(tar.len().next_multiple_of(512) + 1024, 0);
        convert(
            Mode::Gzip,
            &Options::default(),
            &tar,
            Mode::Gzip.finish_flush(),
            64 * 1024,
            usize::MAX,
        )
        .unwrap()
    }

    /// A gzip tar whose first member is a GNU long-name ('L'), long-link ('K')
    /// or PAX ('x') record with a `body`-byte body, followed by a small file.
    fn gzip_tar_with_metadata(kind: u8, body: usize) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.set_path("././@LongLink").unwrap();
        header.set_entry_type(tar::EntryType::new(kind));
        header.set_size(body as u64);
        header.set_cksum();
        let mut tar = header.as_bytes().to_vec();
        let record = if kind == b'x' {
            pax_record(body)
        } else {
            vec![b'a'; body]
        };
        tar.extend_from_slice(&record);
        tar.resize(tar.len().next_multiple_of(512), 0);
        let mut file = tar::Header::new_gnu();
        file.set_path("file.txt").unwrap();
        file.set_size(5);
        file.set_cksum();
        tar.extend_from_slice(file.as_bytes());
        tar.extend_from_slice(b"hello");
        tar.resize(tar.len().next_multiple_of(512) + 1024, 0);
        convert(
            Mode::Gzip,
            &Options::default(),
            &tar,
            Mode::Gzip.finish_flush(),
            64 * 1024,
            usize::MAX,
        )
        .unwrap()
    }

    /// One `path=` PAX record exactly `size` bytes long.
    fn pax_record(size: usize) -> Vec<u8> {
        (1..=8)
            .map(|digits| {
                format!(
                    "{size} path={}\n",
                    "a".repeat(size - digits - " path=\n".len())
                )
            })
            .find(|record| record.len() == size)
            .expect("a PAX record of that size")
            .into_bytes()
    }

    fn names(value: Val) -> Vec<String> {
        let Val::Array(entries) = value else {
            panic!("expected entries")
        };
        entries
            .into_iter()
            .map(|entry| {
                let Val::Object(fields) = entry else {
                    panic!("expected an object")
                };
                match fields.into_iter().find(|(key, _)| key == "name") {
                    Some((_, Val::Str(name))) => name,
                    _ => panic!("missing name"),
                }
            })
            .collect()
    }

    #[test]
    fn oversized_metadata_is_skipped_without_being_read_into_memory() {
        let root =
            std::env::temp_dir().join(format!("bunwasm-archive-metadata-{}", std::process::id()));
        for kind in *b"LKx" {
            // Like libarchive (Bun): over 1 MiB the record is ignored and the
            // member keeps its own header fields.
            let archive = gzip_tar_with_metadata(kind, 4 * 1024 * 1024);
            let (result, largest, _) = measure(|| files(&archive, &[]));
            assert_eq!(names(result.unwrap()), ["file.txt"], "{}", kind as char);
            assert!(
                largest < 512 * 1024,
                "{}: allocated {largest} bytes",
                kind as char
            );
            let (result, largest, _) = measure(|| extract(&archive, root.to_str().unwrap(), &[]));
            assert_eq!(result.unwrap(), 1, "{}", kind as char);
            assert!(
                largest < 512 * 1024,
                "{}: extract allocated {largest} bytes",
                kind as char
            );
        }
        let _ = std::fs::remove_dir_all(&root);
        // Up to the limit the record applies to its member.
        let name = names(files(&gzip_tar_with_metadata(b'L', 1024 * 1024), &[]).unwrap());
        assert_eq!(name[0].len(), 1024 * 1024);
        let name = names(files(&gzip_tar_with_metadata(b'x', 4096), &[]).unwrap());
        assert_eq!(name[0], "a".repeat(4096 - "4096 path=\n".len()));
    }

    #[test]
    fn extract_streams_a_large_gzip_entry() {
        let size = 32 * 1024 * 1024;
        let archive = gzip_tar("large.bin", size as u64, &vec![0; size]);
        let root =
            std::env::temp_dir().join(format!("bunwasm-archive-test-{}", std::process::id()));
        let (count, _, peak) = measure(|| extract(&archive, root.to_str().unwrap(), &[]));
        let written = std::fs::metadata(root.join("large.bin")).map(|m| m.len());
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(count.unwrap(), 1);
        assert_eq!(written.unwrap(), size as u64);
        assert!(peak < 2 * 1024 * 1024, "extraction held {peak} bytes");
    }

    #[test]
    fn files_does_not_trust_the_declared_size() {
        let archive = gzip_tar(
            "huge.bin",
            8 * 1024 * 1024 * 1024 - 1,
            &vec![0; 1024 * 1024],
        );
        let (result, largest, _) = measure(|| files(&archive, &[]));
        assert!(result.is_err(), "a truncated entry must fail");
        assert!(
            largest < 4 * 1024 * 1024,
            "allocated {largest} bytes for a 1 MiB entry"
        );
    }
}
