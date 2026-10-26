//! Strict codec for owned data calls. The browser legacy codec is separate.

#![cfg(any(
    feature = "engine-split",
    feature = "engine-jsc",
    not(feature = "engine-host")
))]

use super::{Val, drop_tree};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodecError {
    Invalid(&'static str),
    Allocation,
}

type Result<T> = std::result::Result<T, CodecError>;

fn push<T>(items: &mut Vec<T>, value: T) -> Result<()> {
    items.try_reserve(1).map_err(|_| CodecError::Allocation)?;
    items.push(value);
    Ok(())
}

fn append(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    out.try_reserve(bytes.len())
        .map_err(|_| CodecError::Allocation)?;
    out.extend_from_slice(bytes);
    Ok(())
}

fn length(out: &mut Vec<u8>, len: usize) -> Result<()> {
    let len = u32::try_from(len).map_err(|_| CodecError::Invalid("length exceeds u32"))?;
    append(out, &len.to_le_bytes())
}

fn string(out: &mut Vec<u8>, text: &str) -> Result<()> {
    length(out, text.len())?;
    append(out, text.as_bytes())
}

enum Part<'a> {
    Value(&'a Val),
    Key(&'a str),
}

pub(crate) fn encode(value: &Val) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut pending = Vec::new();
    push(&mut pending, Part::Value(value))?;
    while let Some(part) = pending.pop() {
        encode_part(part, &mut pending, &mut out)?;
    }
    Ok(out)
}

fn encode_part<'a>(part: Part<'a>, pending: &mut Vec<Part<'a>>, out: &mut Vec<u8>) -> Result<()> {
    let value = match part {
        Part::Key(key) => return string(out, key),
        Part::Value(value) => value,
    };
    push(out, tag(value))?;
    match value {
        Val::Num(n) => append(out, &n.to_le_bytes()),
        Val::BigInt(n) => append(out, &n.to_le_bytes()),
        Val::BigUint(n) => append(out, &n.to_le_bytes()),
        Val::Str(s) => string(out, s),
        Val::Bytes(bytes) => {
            length(out, bytes.len())?;
            append(out, bytes)
        }
        Val::Array(items) => encode_array(items, pending, out),
        Val::Object(fields) => encode_object(fields, pending, out),
        _ => Ok(()),
    }
}

fn tag(value: &Val) -> u8 {
    match value {
        Val::Undefined => 0,
        Val::Null => 1,
        Val::Bool(false) => 2,
        Val::Bool(true) => 3,
        Val::Num(_) => 4,
        Val::Str(_) => 5,
        Val::Bytes(_) => 6,
        Val::Array(_) => 7,
        Val::Object(_) => 8,
        Val::BigInt(_) => 9,
        Val::BigUint(_) => 10,
    }
}

fn encode_array<'a>(
    items: &'a [Val],
    pending: &mut Vec<Part<'a>>,
    out: &mut Vec<u8>,
) -> Result<()> {
    length(out, items.len())?;
    for item in items.iter().rev() {
        push(pending, Part::Value(item))?;
    }
    Ok(())
}

fn encode_object<'a>(
    fields: &'a [(String, Val)],
    pending: &mut Vec<Part<'a>>,
    out: &mut Vec<u8>,
) -> Result<()> {
    length(out, fields.len())?;
    for (key, value) in fields.iter().rev() {
        push(pending, Part::Value(value))?;
        push(pending, Part::Key(key))?;
    }
    Ok(())
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(CodecError::Invalid("span overflow"))?;
        let bytes = self
            .bytes
            .get(self.pos..end)
            .ok_or(CodecError::Invalid("truncated value"))?;
        self.pos = end;
        Ok(bytes)
    }

    fn word(&mut self) -> Result<usize> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize)
    }

    fn eight(&mut self) -> Result<[u8; 8]> {
        Ok(self.take(8)?.try_into().unwrap())
    }

    fn blob(&mut self) -> Result<Vec<u8>> {
        let len = self.word()?;
        let mut out = Vec::new();
        append(&mut out, self.take(len)?)?;
        Ok(out)
    }

    fn text(&mut self) -> Result<String> {
        String::from_utf8(self.blob()?).map_err(|_| CodecError::Invalid("invalid UTF-8"))
    }

    fn count(&mut self, minimum_bytes: usize) -> Result<usize> {
        let count = self.word()?;
        if count > (self.bytes.len() - self.pos) / minimum_bytes {
            return Err(CodecError::Invalid("impossible item count"));
        }
        Ok(count)
    }
}

enum Items {
    Array(Vec<Val>),
    Object(Vec<(String, Val)>),
}

struct Container {
    remaining: usize,
    items: Items,
    key: Option<String>,
}

impl Container {
    fn read_key(&mut self, reader: &mut Reader<'_>) -> Result<()> {
        if matches!(self.items, Items::Object(_)) && self.key.is_none() {
            self.key = Some(reader.text()?);
        }
        Ok(())
    }

    fn add(&mut self, value: Val) -> Result<()> {
        let reservation = match &mut self.items {
            Items::Array(items) => items.try_reserve(1),
            Items::Object(fields) => fields.try_reserve(1),
        };
        if reservation.is_err() {
            drop_tree(value);
            return Err(CodecError::Allocation);
        }
        match &mut self.items {
            Items::Array(items) => items.push(value),
            Items::Object(fields) => fields.push((self.key.take().unwrap(), value)),
        }
        self.remaining -= 1;
        Ok(())
    }

    fn finish(mut self) -> Val {
        match &mut self.items {
            Items::Array(items) => Val::Array(std::mem::take(items)),
            Items::Object(fields) => Val::Object(std::mem::take(fields)),
        }
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        match &mut self.items {
            Items::Array(items) if items.is_empty() => {}
            Items::Object(fields) if fields.is_empty() => {}
            Items::Array(items) => drop_tree(Val::Array(std::mem::take(items))),
            Items::Object(fields) => drop_tree(Val::Object(std::mem::take(fields))),
        }
    }
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Val> {
    let mut reader = Reader { bytes, pos: 0 };
    let mut stack: Vec<Container> = Vec::new();
    loop {
        read_key(&mut stack, &mut reader)?;
        let Some(value) = read_value(&mut reader, &mut stack)? else {
            continue;
        };
        let Some(value) = attach(value, &mut stack)? else {
            continue;
        };
        if reader.pos != bytes.len() {
            drop_tree(value);
            return Err(CodecError::Invalid("trailing bytes"));
        }
        return Ok(value);
    }
}

fn read_key(stack: &mut [Container], reader: &mut Reader<'_>) -> Result<()> {
    if let Some(parent) = stack.last_mut() {
        parent.read_key(reader)?;
    }
    Ok(())
}

fn attach(mut value: Val, stack: &mut Vec<Container>) -> Result<Option<Val>> {
    while let Some(parent) = stack.last_mut() {
        parent.add(value)?;
        if parent.remaining != 0 {
            return Ok(None);
        }
        value = stack.pop().unwrap().finish();
    }
    Ok(Some(value))
}

fn read_value(reader: &mut Reader<'_>, stack: &mut Vec<Container>) -> Result<Option<Val>> {
    let tag = reader.take(1)?[0];
    let value = match tag {
        0 => Val::Undefined,
        1 => Val::Null,
        2 => Val::Bool(false),
        3 => Val::Bool(true),
        4 => Val::Num(f64::from_le_bytes(reader.eight()?)),
        5 => Val::Str(reader.text()?),
        6 => Val::Bytes(reader.blob()?),
        7 | 8 => return read_container(tag, reader, stack),
        9 => Val::BigInt(i64::from_le_bytes(reader.eight()?)),
        10 => Val::BigUint(u64::from_le_bytes(reader.eight()?)),
        _ => return Err(CodecError::Invalid("unknown tag")),
    };
    Ok(Some(value))
}

fn read_container(
    tag: u8,
    reader: &mut Reader<'_>,
    stack: &mut Vec<Container>,
) -> Result<Option<Val>> {
    let count = reader.count(if tag == 7 { 1 } else { 5 })?;
    let items = if tag == 7 {
        Items::Array(Vec::new())
    } else {
        Items::Object(Vec::new())
    };
    let container = Container {
        remaining: count,
        items,
        key: None,
    };
    if count == 0 {
        return Ok(Some(container.finish()));
    }
    push(stack, container)?;
    Ok(None)
}
