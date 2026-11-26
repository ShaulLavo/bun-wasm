use std::cell::RefCell;
use std::ops::Deref;

pub use bunwasm_bun_jsc_macros::host_fn;

pub type JsResult<T> = Result<T, JsError>;
pub type HostFn = fn(&JSGlobalObject, &CallFrame) -> JsResult<JSValue>;
pub type HostFunction = (&'static str, HostFn, u32);

#[derive(Debug)]
pub enum JsError {
    Error(String),
    TypeError(String),
    OutOfMemory,
}

/// The part of Bun's bindgen runtime that plain-data functions name in their signatures.
pub mod bindgen {
    use std::fmt;
    use std::marker::PhantomData;

    use super::JsError;

    /// Stands in for the engine heap that Bun hands to functions which create errors.
    #[derive(Default)]
    pub struct JsHeap<'a>(PhantomData<&'a ()>);

    impl<'a> JsHeap<'a> {
        pub fn error(&self, message: fmt::Arguments<'_>) -> Error<'a> {
            Error(JsError::Error(message.to_string()), PhantomData)
        }
    }

    pub struct Error<'a>(JsError, PhantomData<&'a ()>);
    pub type Result<'a, T> = core::result::Result<T, Error<'a>>;

    impl From<bun_alloc::AllocError> for Error<'_> {
        fn from(_: bun_alloc::AllocError) -> Self {
            Self(JsError::OutOfMemory, PhantomData)
        }
    }

    impl From<Error<'_>> for JsError {
        fn from(error: Error<'_>) -> Self {
            error.0
        }
    }
}

#[derive(Clone, Copy)]
enum Value {
    Undefined,
    Boolean(bool),
    Number(i32),
    Slot(usize),
}

#[derive(Clone, Copy)]
pub struct JSValue(Value);

#[derive(Default)]
pub struct JSGlobalObject {
    strings: RefCell<Vec<String>>,
}

impl JSGlobalObject {
    pub fn string(&self, value: &str) -> JSValue {
        let mut strings = self.strings.borrow_mut();
        let slot = strings.len();
        strings.push(value.to_owned());
        JSValue(Value::Slot(slot))
    }

    pub fn throw_out_of_memory(&self) -> JsError {
        JsError::OutOfMemory
    }
}

impl JSValue {
    pub const UNDEFINED: Self = Self(Value::Undefined);

    pub fn js_number_from_int32(value: i32) -> Self {
        Self(Value::Number(value))
    }

    pub fn js_boolean(value: bool) -> Self {
        Self(Value::Boolean(value))
    }

    pub fn as_bool(self) -> Option<bool> {
        match self.0 {
            Value::Boolean(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_int32(self) -> Option<i32> {
        match self.0 {
            Value::Number(value) => Some(value),
            _ => None,
        }
    }

    pub fn to_utf8(self, global: &JSGlobalObject) -> JsResult<Utf8Bytes> {
        let Value::Slot(slot) = self.0 else {
            return Err(JsError::TypeError("expected a string argument".to_owned()));
        };
        Ok(Utf8Bytes(global.strings.borrow()[slot].as_bytes().into()))
    }
}

pub struct Utf8Bytes(Box<[u8]>);

impl Deref for Utf8Bytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

pub struct CallFrame(Vec<JSValue>);

impl CallFrame {
    pub fn new(arguments: Vec<JSValue>) -> Self {
        Self(arguments)
    }

    pub fn argument(&self, index: usize) -> JSValue {
        self.0.get(index).copied().unwrap_or(JSValue::UNDEFINED)
    }
}
