//! Per-call data transport. VM values and exceptions stay with the caller.

#![cfg(any(
    feature = "engine-quickjs",
    feature = "engine-jsc",
    not(feature = "engine-host")
))]

use std::num::NonZeroU32;
use std::ops::Range;

use crate::data::codec::{self, CodecError};
use crate::data::{Args, DataFn, ErrorKind, NativeError, NativeResult, Record, Val, drop_tree};

pub(crate) const DATA_NATIVE: u32 = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum Status {
    Ok = 0,
    NativeError = 1,
    BadCall = 2,
    ResourceLimit = 3,
}

/// The physical wrapper reads/writes these words as little-endian u32s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Frame {
    pub op: u32,
    pub session: u32,
    pub request_ptr: u32,
    pub request_len: u32,
    pub reply_ptr: u32,
    pub reply_len: u32,
}

impl Frame {
    pub const SIZE: usize = 24;
    pub const ALIGN: u32 = 8;

    pub fn decode(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() != Self::SIZE {
            return Err(Status::BadCall);
        }
        let mut words = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|word| u32::from_le_bytes(*word));
        Ok(Self {
            op: words.next().unwrap(),
            session: words.next().unwrap(),
            request_ptr: words.next().unwrap(),
            request_len: words.next().unwrap(),
            reply_ptr: words.next().unwrap(),
            reply_len: words.next().unwrap(),
        })
    }

    #[cfg(test)]
    pub fn read(memory: &[u8], offset: u32) -> Result<Self, Status> {
        if !offset.is_multiple_of(Self::ALIGN) {
            return Err(Status::BadCall);
        }
        let range = span(offset, Self::SIZE as u32, memory.len())?;
        Self::decode(&memory[range])
    }

    pub fn request(&self, frame_ptr: u32, memory_len: usize) -> Result<Range<usize>, Status> {
        if self.reply_ptr != 0 || self.reply_len != 0 || self.session == 0 {
            return Err(Status::BadCall);
        }
        if !frame_ptr.is_multiple_of(Self::ALIGN) || !self.request_ptr.is_multiple_of(Self::ALIGN) {
            return Err(Status::BadCall);
        }
        let frame = span(frame_ptr, Self::SIZE as u32, memory_len)?;
        let request = span(self.request_ptr, self.request_len, memory_len)?;
        if request.start < frame.end && frame.start < request.end {
            return Err(Status::BadCall);
        }
        Ok(request)
    }
}

fn span(ptr: u32, len: u32, memory_len: usize) -> Result<Range<usize>, Status> {
    if ptr == 0 {
        return Err(Status::BadCall);
    }
    let end = u64::from(ptr) + u64::from(len);
    if end > memory_len as u64 {
        return Err(Status::BadCall);
    }
    Ok(ptr as usize..end as usize)
}

pub(crate) struct Reply {
    pub status: Status,
    pub bytes: Vec<u8>,
}

impl Reply {
    fn encoded(status: Status, value: Val) -> Self {
        let reply = match codec::encode(&value) {
            Ok(bytes) => Self { status, bytes },
            Err(error) => Self::failed(error_status(error)),
        };
        drop_tree(value);
        reply
    }

    fn failed(status: Status) -> Self {
        Self {
            status,
            bytes: Vec::new(),
        }
    }

    pub fn into_result(self) -> NativeResult {
        match self.status {
            Status::Ok => codec::decode(&self.bytes).map_err(transport_error),
            Status::NativeError => decode_error(&self.bytes).and_then(Err),
            Status::BadCall => Err(NativeError::error("invalid core data call")),
            Status::ResourceLimit => Err(NativeError::error("core data allocation failed")),
        }
    }
}

/// This unit registers one migrated native, not an engine-method opcode table.
pub(crate) struct Dispatcher {
    session: NonZeroU32,
    op: u32,
    function: DataFn,
}

impl Dispatcher {
    pub fn new(session: NonZeroU32, native_id: u32, function: DataFn) -> Option<Self> {
        let op = DATA_NATIVE.checked_add(native_id)?;
        Some(Self {
            session,
            op,
            function,
        })
    }

    #[cfg(test)]
    pub fn op(&self) -> u32 {
        self.op
    }

    pub fn dispatch(&self, op: u32, session: u32, request: Vec<u8>) -> Reply {
        if op != self.op || session != self.session.get() {
            return Reply::failed(Status::BadCall);
        }
        let args = match codec::decode(&request) {
            Ok(Val::Array(args)) => args,
            Ok(value) => {
                drop_tree(value);
                return Reply::failed(Status::BadCall);
            }
            Err(error) => return Reply::failed(error_status(error)),
        };
        drop(request);
        let function = self.function.clone();
        let result = function(Args(&args));
        drop_tree(Val::Array(args));
        match result {
            Ok(value) => Reply::encoded(Status::Ok, value),
            Err(error) => Reply::encoded(Status::NativeError, error_value(error)),
        }
    }

    pub fn call(&self, args: Vec<Val>) -> NativeResult {
        abi::call(self, self.op, self.session.get(), args)
    }
}

fn error_status(error: CodecError) -> Status {
    match error {
        CodecError::Invalid(_) => Status::BadCall,
        CodecError::Allocation => Status::ResourceLimit,
    }
}

fn transport_error(error: CodecError) -> NativeError {
    match error {
        CodecError::Invalid(message) => NativeError::error(format!("invalid core data: {message}")),
        CodecError::Allocation => NativeError::error("core data allocation failed"),
    }
}

fn error_value(error: NativeError) -> Val {
    let kind = match error.kind {
        ErrorKind::Error => "Error",
        ErrorKind::TypeError => "TypeError",
        ErrorKind::RangeError => "RangeError",
        ErrorKind::SyntaxError => "SyntaxError",
    };
    let props = error
        .props
        .into_iter()
        .map(|(key, value)| Val::Array(vec![Val::Str(key), value]))
        .collect();
    Record::new()
        .set("kind", kind)
        .set("message", error.message)
        .set("name", error.name.map_or(Val::Null, Val::Str))
        .set("props", Val::Array(props))
        .into()
}

fn decode_error(bytes: &[u8]) -> Result<NativeError, NativeError> {
    let Val::Object(fields) = codec::decode(bytes).map_err(transport_error)? else {
        return Err(NativeError::error("invalid core error record"));
    };
    let mut fields = fields.into_iter();
    let kind = match field(&mut fields, "kind")? {
        Val::Str(kind) => parse_kind(&kind)?,
        _ => return Err(NativeError::error("invalid core error kind")),
    };
    let Val::Str(message) = field(&mut fields, "message")? else {
        return Err(NativeError::error("invalid core error message"));
    };
    let name = match field(&mut fields, "name")? {
        Val::Null => None,
        Val::Str(name) => Some(name),
        _ => return Err(NativeError::error("invalid core error name")),
    };
    let Val::Array(props) = field(&mut fields, "props")? else {
        return Err(NativeError::error("invalid core error properties"));
    };
    if fields.next().is_some() {
        return Err(NativeError::error("unexpected core error field"));
    }
    let props = props
        .into_iter()
        .map(error_prop)
        .collect::<Result<_, _>>()?;
    Ok(NativeError {
        kind,
        message,
        name,
        props,
    })
}

fn field(
    fields: &mut impl Iterator<Item = (String, Val)>,
    expected: &str,
) -> Result<Val, NativeError> {
    let Some((key, value)) = fields.next() else {
        return Err(NativeError::error("missing core error field"));
    };
    if key != expected {
        return Err(NativeError::error("unexpected core error field"));
    }
    Ok(value)
}

fn parse_kind(kind: &str) -> Result<ErrorKind, NativeError> {
    match kind {
        "Error" => Ok(ErrorKind::Error),
        "TypeError" => Ok(ErrorKind::TypeError),
        "RangeError" => Ok(ErrorKind::RangeError),
        "SyntaxError" => Ok(ErrorKind::SyntaxError),
        _ => Err(NativeError::error("invalid core error kind")),
    }
}

fn error_prop(value: Val) -> Result<(String, Val), NativeError> {
    let Val::Array(pair) = value else {
        return Err(NativeError::error("invalid core error property"));
    };
    let mut pair = pair.into_iter();
    let (Some(Val::Str(key)), Some(value), None) = (pair.next(), pair.next(), pair.next()) else {
        return Err(NativeError::error("invalid core error property"));
    };
    Ok((key, value))
}

#[cfg(test)]
#[path = "ops/tests.rs"]
mod tests;

#[path = "ops/abi.rs"]
pub(crate) mod abi;
