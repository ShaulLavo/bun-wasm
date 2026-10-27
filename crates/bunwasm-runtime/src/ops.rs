//! Per-call data transport. VM values and exceptions stay with the caller.

use std::num::NonZeroU32;
use std::ops::Range;

use crate::data::codec::{self, CodecError};
use crate::data::{Args, DataFn, ErrorKind, NativeError, Record, Val, drop_tree};

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
}

/// Process-local plain-data operations. No engine methods or VM handles.
pub(crate) struct Dispatcher {
    session: NonZeroU32,
    functions: std::collections::HashMap<u32, DataFn>,
}

impl Dispatcher {
    pub fn registry(session: NonZeroU32, entries: Vec<(u32, DataFn)>) -> Option<Self> {
        if entries.is_empty() {
            return None;
        }
        let count = entries.len();
        let functions: std::collections::HashMap<_, _> = entries.into_iter().collect();
        if functions.len() != count {
            return None;
        }
        Some(Self { session, functions })
    }

    #[cfg(test)]
    pub fn op(&self) -> u32 {
        *self.functions.keys().next().expect("nonempty registry")
    }

    pub fn dispatch(&self, op: u32, session: u32, request: &[u8]) -> Reply {
        if session != self.session.get() {
            return Reply::failed(Status::BadCall);
        }
        let Some(function) = self.functions.get(&op).cloned() else {
            return Reply::failed(Status::BadCall);
        };
        let args = match codec::decode(request) {
            Ok(Val::Array(args)) => args,
            Ok(value) => {
                drop_tree(value);
                return Reply::failed(Status::BadCall);
            }
            Err(error) => return Reply::failed(error_status(error)),
        };
        let result = function(Args(&args));
        drop_tree(Val::Array(args));
        match result {
            Ok(value) => Reply::encoded(Status::Ok, value),
            Err(error) => Reply::encoded(Status::NativeError, error_value(error)),
        }
    }
}

fn error_status(error: CodecError) -> Status {
    match error {
        CodecError::Invalid(_) => Status::BadCall,
        CodecError::Allocation => Status::ResourceLimit,
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

#[cfg(test)]
#[path = "ops/tests.rs"]
mod tests;

#[path = "ops/abi.rs"]
pub(crate) mod abi;

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::rc::Rc;

    #[test]
    fn registry_routes_multiple_natives_and_source_ops() {
        let entries: Vec<(u32, DataFn)> = vec![
            (1, Rc::new(|_| Ok("description".into()))),
            (DATA_NATIVE + 2, Rc::new(|args| Ok(args.str(0)?.into()))),
        ];
        let dispatcher = Dispatcher::registry(NonZeroU32::MIN, entries).unwrap();
        assert_eq!(
            abi::call(&dispatcher, 1, 1, vec![]).unwrap(),
            "description".into()
        );
        assert_eq!(
            abi::call(&dispatcher, DATA_NATIVE + 2, 1, vec!["second".into()]).unwrap(),
            "second".into()
        );
        assert!(abi::call(&dispatcher, DATA_NATIVE + 1, 1, vec![]).is_err());
        assert!(abi::call(&dispatcher, 1, 2, vec![]).is_err());
    }

    #[test]
    fn registry_rejects_duplicate_operations() {
        let entries: Vec<(u32, DataFn)> = vec![
            (1, Rc::new(|_| Ok(Val::Undefined))),
            (1, Rc::new(|_| Ok(Val::Undefined))),
        ];
        assert!(Dispatcher::registry(NonZeroU32::MIN, entries).is_none());
    }
}

#[cfg(any(test, not(feature = "engine-split")))]
#[path = "ops/client.rs"]
mod client;
#[cfg(any(test, not(feature = "engine-split")))]
use client::transport_error;

#[cfg(test)]
use crate::data::NativeResult;
#[cfg(test)]
use client::decode_error;
