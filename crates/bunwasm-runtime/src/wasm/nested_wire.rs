//! Data-only runtime_nested request ABI. JS values never cross this boundary.
use serde::{Deserialize, Serialize};

pub const BACKEND: u32 = 1 << 31;
pub const MAX_RESOURCES: usize = 4096;
pub const MAX_REQUEST_BYTES: u32 = 1 << 20;

pub fn request_length(length: usize) -> Option<u32> {
    let length = u32::try_from(length).ok()?;
    (length <= MAX_REQUEST_BYTES).then_some(length)
}

#[cfg(test)]
mod request_tests {
    #[test]
    fn serialized_request_length_is_bounded_before_transport() {
        use super::{MAX_REQUEST_BYTES, request_length};
        assert_eq!(request_length(0), Some(0));
        assert_eq!(
            request_length(MAX_REQUEST_BYTES as usize),
            Some(MAX_REQUEST_BYTES)
        );
        assert_eq!(request_length(MAX_REQUEST_BYTES as usize + 1), None);
        assert_eq!(request_length(usize::MAX), None);
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum Number {
    I32(i32),
    I64(i64),
    F32(u32),
    F64(u64),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Binding {
    Callback {
        module: String,
        name: String,
        id: u32,
    },
    Function {
        module: String,
        name: String,
        id: u32,
    },
    Global {
        module: String,
        name: String,
        value: Number,
    },
}

#[derive(Serialize, Deserialize)]
pub enum Request {
    Reserve {
        initial: u32,
        maximum: u32,
    },
    Span {
        memory: u32,
    },
    Grow {
        memory: u32,
        delta: u32,
    },
    Release {
        memory: u32,
    },
    Compile {
        pointer: u32,
        length: u32,
    },
    Instantiate {
        module: u32,
        memory: u32,
        bindings: Vec<Binding>,
        invocation: u32,
    },
    Function {
        instance: u32,
        name: String,
    },
    Call {
        function: u32,
        arguments: Vec<Number>,
        invocation: u32,
    },
    PublishMemory {
        memory: u32,
    },
    AttachMemory {
        token: u32,
    },
    PublishModule {
        module: u32,
        description: String,
    },
    AttachModule {
        token: u32,
    },
    Withdraw {
        token: u32,
    },
}

#[derive(Serialize, Deserialize)]
pub enum Reply {
    Handle(u32),
    Count(u32),
    Memory {
        pointer: u32,
        pages: u32,
        maximum: u32,
        committed: u64,
    },
    Function {
        id: u32,
        params: Vec<String>,
        results: Vec<String>,
    },
    Values(Vec<Number>),
    AttachedModule {
        id: u32,
        description: String,
    },
    Error {
        category: String,
        message: String,
    },
    PendingException,
}
