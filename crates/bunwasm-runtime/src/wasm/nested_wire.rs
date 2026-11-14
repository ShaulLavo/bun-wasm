//! Data-only runtime_nested request ABI. JS values never cross this boundary.
use serde::{Deserialize, Serialize};

pub const BACKEND: u32 = 1 << 31;
pub const MAX_RESOURCES: usize = 4096;
pub const MAX_REQUEST_BYTES: u32 = 1 << 20;

/// The `Count` a `Withdraw` request is answered with. The publication is gone after the first
/// two. The caller may be told nothing at all about a withdrawal that happened (a lost reply),
/// so it asks again: tokens are never reused, and the second answer is `WITHDRAW_ABSENT`.
pub const WITHDRAWN: u32 = 0;
/// The token names no publication of this member: withdrawn before, or never its own.
pub const WITHDRAW_ABSENT: u32 = 1;
/// The group owner refused for good, for example because the member is no longer running.
pub const WITHDRAW_REFUSED: u32 = 2;

/// What a `Withdraw` reply says, when it says anything. Only the three counts are an answer.
/// An error reply is not one, whatever it names: the host turns anything it catches on the
/// way to or from the group owner into one, before the owner acted or after. Nor is another
/// reply or a count this caller does not know. With no answer the caller asks again.
pub fn withdraw_answer(reply: &Reply) -> Option<u32> {
    match reply {
        Reply::Count(answer @ (WITHDRAWN | WITHDRAW_ABSENT | WITHDRAW_REFUSED)) => Some(*answer),
        _ => None,
    }
}

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

    #[test]
    fn only_the_three_counts_answer_a_withdrawal() {
        use super::{Reply, WITHDRAW_ABSENT, WITHDRAW_REFUSED, WITHDRAWN, withdraw_answer};
        for answer in [WITHDRAWN, WITHDRAW_ABSENT, WITHDRAW_REFUSED] {
            assert_eq!(withdraw_answer(&Reply::Count(answer)), Some(answer));
        }
        // An error reply is whatever the host caught, before or after the owner acted. It
        // settles nothing, whatever category or text it carries.
        for (category, message) in [
            ("RuntimeError", "one-shot host entry failure"),
            ("RangeError", "Maximum call stack size exceeded"),
            ("RuntimeError", "shared publication withdrawal: BadF"),
        ] {
            let reply = Reply::Error {
                category: category.into(),
                message: message.into(),
            };
            assert_eq!(withdraw_answer(&reply), None);
        }
        assert_eq!(withdraw_answer(&Reply::Count(3)), None);
        assert_eq!(withdraw_answer(&Reply::Count(u32::MAX)), None);
        assert_eq!(withdraw_answer(&Reply::Handle(0)), None);
        assert_eq!(withdraw_answer(&Reply::PendingException), None);
        assert_eq!(withdraw_answer(&Reply::Null), None);
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
    TableExport {
        instance: u32,
        name: String,
    },
    TableLength {
        table: u32,
    },
    TableGet {
        table: u32,
        index: u32,
    },
    TableSet {
        table: u32,
        index: u32,
        function: Option<u32>,
    },
    TableGrow {
        table: u32,
        delta: u32,
        function: Option<u32>,
    },
    GlobalGet {
        instance: u32,
        name: String,
    },
    GlobalSet {
        instance: u32,
        name: String,
        value: Number,
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
    Null,
}
