//! Per-call data transport. VM values and exceptions stay with the caller.

use std::num::NonZeroU32;
use std::ops::Range;

#[cfg(any(test, not(feature = "engine-split")))]
use crate::data::ErrorKind;
use crate::data::codec::{self, CodecError};
use crate::data::{Args, DataFn, NativeError, Val, WORD_ARGS, WordFn, drop_tree};

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

/// The frame of a word call: operation, session and the argument words as little-endian u32s,
/// then the i64 result. Its size tells the transport which kind of call a frame carries.
pub(crate) struct WordFrame {
    pub op: u32,
    pub session: u32,
    pub words: [u32; WORD_ARGS],
}

impl WordFrame {
    pub const RESULT: usize = 8 + WORD_ARGS * 4;
    pub const SIZE: usize = Self::RESULT + 8;

    pub fn decode(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() != Self::SIZE {
            return Err(Status::BadCall);
        }
        let mut input = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|word| u32::from_le_bytes(*word));
        let op = input.next().unwrap();
        let session = input.next().unwrap();
        let mut words = [0; WORD_ARGS];
        words.fill_with(|| input.next().unwrap());
        Ok(Self { op, session, words })
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

/// Owned native output, or a transport failure without a payload.
pub(crate) enum Reply {
    Value(Val),
    NativeError(NativeError),
    Failed(Status),
}

impl Reply {
    pub fn status(&self) -> Status {
        match self {
            Self::Value(_) => Status::Ok,
            Self::NativeError(_) => Status::NativeError,
            Self::Failed(status) => *status,
        }
    }
}

/// Operations below `DATA_NATIVE` are the split API's own, numbered from zero; this many at most.
const API_OPS: u32 = 64;

/// Word operations from this number on are the split API's own, after every word native.
pub(crate) const WORD_API: u32 = 1 << 31;

/// Process-local plain-data operations. No engine methods or VM handles.
pub(crate) struct Dispatcher {
    session: NonZeroU32,
    /// Split API operations, indexed by operation number.
    api: Vec<Option<DataFn>>,
    /// Data natives, indexed by operation number less `DATA_NATIVE`.
    natives: Vec<Option<DataFn>>,
    /// Word natives by operation number.
    words: Vec<WordFn>,
    /// Split API words, by operation number less `WORD_API`.
    api_words: Vec<WordFn>,
}

impl Dispatcher {
    pub fn registry(session: NonZeroU32, entries: Vec<(u32, DataFn)>) -> Option<Self> {
        if entries.is_empty() {
            return None;
        }
        let mut dispatcher = Self {
            session,
            api: Vec::new(),
            natives: Vec::new(),
            words: Vec::new(),
            api_words: Vec::new(),
        };
        for (op, function) in entries {
            let (table, index) = dispatcher.table(op)?;
            if table.len() <= index {
                table.resize(index + 1, None);
            }
            // A duplicate operation number is a broken registry.
            if table[index].replace(function).is_some() {
                return None;
            }
        }
        Some(dispatcher)
    }

    /// The table and index that hold `op`, or `None` for a number no operation can have.
    fn table(&mut self, op: u32) -> Option<(&mut Vec<Option<DataFn>>, usize)> {
        if let Some(index) = op.checked_sub(DATA_NATIVE) {
            return Some((&mut self.natives, index as usize));
        }
        (op < API_OPS).then_some((&mut self.api, op as usize))
    }

    fn function(&self, op: u32) -> Option<&DataFn> {
        let slot = match op.checked_sub(DATA_NATIVE) {
            Some(index) => self.natives.get(index as usize),
            None => self.api.get(op as usize),
        };
        slot?.as_ref()
    }

    pub fn with_words(mut self, words: Vec<WordFn>) -> Self {
        self.words = words;
        self
    }

    /// The split API's own words, numbered from `WORD_API`.
    pub fn with_api_words(mut self, words: Vec<WordFn>) -> Self {
        self.api_words = words;
        self
    }

    /// Runs a word native. `None` is a wrong session or operation: a broken engine, which the
    /// engine side treats as terminal and never turns into a JavaScript exception.
    pub fn word(&self, op: u32, session: u32, words: &[u32; WORD_ARGS]) -> Option<i64> {
        if session != self.session.get() {
            return None;
        }
        let function = match op.checked_sub(WORD_API) {
            Some(index) => self.api_words.get(index as usize),
            None => self.words.get(op as usize),
        };
        function.map(|function| function(words))
    }

    #[cfg(test)]
    pub fn op(&self) -> u32 {
        let api = self.api.iter().position(Option::is_some);
        let native = || self.natives.iter().position(Option::is_some);
        match api {
            Some(op) => op as u32,
            None => DATA_NATIVE + native().expect("nonempty registry") as u32,
        }
    }

    /// How many data operations the registry holds.
    #[cfg(any(test, not(feature = "engine-split")))]
    fn len(&self) -> usize {
        let count = |table: &[Option<DataFn>]| table.iter().flatten().count();
        count(&self.api) + count(&self.natives)
    }

    pub fn dispatch(&self, op: u32, session: u32, request: &[u8]) -> Reply {
        if session != self.session.get() {
            return Reply::Failed(Status::BadCall);
        }
        let Some(function) = self.function(op) else {
            return Reply::Failed(Status::BadCall);
        };
        let args = match codec::decode(request) {
            Ok(Val::Array(args)) => args,
            Ok(value) => {
                drop_tree(value);
                return Reply::Failed(Status::BadCall);
            }
            Err(error) => return Reply::Failed(error_status(error)),
        };
        let result = function(Args(&args));
        drop_tree(Val::Array(args));
        match result {
            Ok(value) => Reply::Value(value),
            Err(error) => Reply::NativeError(error),
        }
    }
}

fn error_status(error: CodecError) -> Status {
    match error {
        CodecError::Invalid(_) => Status::BadCall,
        CodecError::Allocation => Status::ResourceLimit,
    }
}

#[cfg(test)]
#[path = "ops/tests.rs"]
mod tests;

// Engine crates include this module without the core crate's allocation tracker.
#[cfg(all(test, feature = "engine-split"))]
#[path = "ops/memory_tests.rs"]
mod memory_tests;

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
