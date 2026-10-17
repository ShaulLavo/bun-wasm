use std::io::{self, Read};

use crate::archive::ArchiveInner;
use crate::entry::{EntryFields, EntryIo};
use crate::other;
use crate::pax::*;

struct Metadata {
    name: Vec<u8>,
    size: u64,
}

fn metadata(bytes: &[u8]) -> io::Result<Option<Metadata>> {
    let mut major = None;
    let mut minor = None;
    let mut size = None;
    let mut name = None;
    let mut sparse = false;
    for item in PaxExtensions::new(bytes) {
        let item = item?;
        let key = item.key().map_err(|_| other("invalid PAX key"))?;
        sparse |= key.starts_with(PAX_GNUSPARSE);
        match key {
            PAX_GNUSPARSEMAJOR => major = Some(number(item.value_bytes())?),
            PAX_GNUSPARSEMINOR => minor = Some(number(item.value_bytes())?),
            PAX_GNUSPARSEREALSIZE => size = Some(number(item.value_bytes())?),
            PAX_GNUSPARSENAME => name = Some(item.value_bytes().to_vec()),
            _ => continue
        }
    }
    if !sparse { return Ok(None); }
    if major != Some(1) || minor != Some(0) { return Err(other("unsupported GNU PAX sparse version")); }
    Ok(Some(Metadata {
        name: name.ok_or_else(|| other("missing GNU PAX sparse name"))?,
        size: size.ok_or_else(|| other("missing GNU PAX sparse size"))?,
    }))
}

fn number(bytes: &[u8]) -> io::Result<u64> {
    if bytes.is_empty() { return Err(other("empty GNU PAX sparse number")); }
    bytes.iter().try_fold(0u64, |value, byte| {
        if !byte.is_ascii_digit() { return Err(other("invalid GNU PAX sparse number")); }
        value.checked_mul(10).and_then(|value| value.checked_add(u64::from(byte - b'0')))
            .ok_or_else(|| other("GNU PAX sparse number overflow"))
    })
}

fn line(reader: &mut impl Read, used: &mut u64) -> io::Result<u64> {
    let mut bytes = [0; 20];
    let mut length = 0;
    loop {
        let mut byte = [0];
        reader.read_exact(&mut byte)?;
        *used = used.checked_add(1).ok_or_else(|| other("GNU PAX sparse map overflow"))?;
        if byte[0] == b'\n' { return number(&bytes[..length]); }
        if length == bytes.len() { return Err(other("GNU PAX sparse number overflow")); }
        bytes[length] = byte[0];
        length += 1;
    }
}

pub(crate) fn parse<'a>(entry: &mut EntryFields<'a>, reader: &'a ArchiveInner<dyn Read + 'a>) -> io::Result<()> {
    let Some(extensions) = &entry.pax_extensions else { return Ok(()); };
    let Some(meta) = metadata(extensions)? else { return Ok(()); };
    if !entry.header.entry_type().is_file() { return Err(other("GNU PAX sparse member is not a file")); }
    let stored_size = entry.size;
    let mut input = reader.take(stored_size);
    let mut used = 0;
    let count = line(&mut input, &mut used)?;
    if count > stored_size / 4 { return Err(other("GNU PAX sparse map exceeds its entry")); }
    let mut blocks = Vec::new();
    let mut position = 0;
    let mut payload = 0u64;
    for _ in 0..count {
        let offset = line(&mut input, &mut used)?;
        let length = line(&mut input, &mut used)?;
        let end = offset.checked_add(length).ok_or_else(|| other("GNU PAX sparse block overflow"))?;
        if offset < position || end > meta.size { return Err(other("invalid GNU PAX sparse block order or size")); }
        if offset > position { blocks.push(EntryIo::Pad(io::repeat(0).take(offset - position))); }
        payload = payload.checked_add(length).ok_or_else(|| other("GNU PAX sparse data overflow"))?;
        blocks.push(EntryIo::Data(reader.take(length)));
        position = end;
    }
    let padding = (512 - used % 512) % 512;
    let mut ignored = [0; 512];
    input.read_exact(&mut ignored[..padding as usize])?;
    if used.checked_add(padding).and_then(|map| map.checked_add(payload)) != Some(stored_size) {
        return Err(other("GNU PAX sparse data does not match its entry size"));
    }
    if position < meta.size { blocks.push(EntryIo::Pad(io::repeat(0).take(meta.size - position))); }
    entry.long_pathname = Some(meta.name);
    entry.size = meta.size;
    entry.data = blocks;
    Ok(())
}
