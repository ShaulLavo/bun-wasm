use std::cell::RefCell;
use std::fmt;
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

#[derive(Clone, Copy)]
enum Value {
    Undefined,
    Boolean(bool),
    Number(i32),
    Slot(usize),
}

#[derive(Clone, Copy)]
pub struct JSValue(Value);

enum StoredValue {
    String(String),
    HostObject(Vec<HostFunction>),
}

#[derive(Default)]
pub struct JSGlobalObject {
    values: RefCell<Vec<StoredValue>>,
}

impl JSGlobalObject {
    fn store(&self, value: StoredValue) -> JSValue {
        let mut values = self.values.borrow_mut();
        let slot = values.len();
        values.push(value);
        JSValue(Value::Slot(slot))
    }

    pub fn string(&self, value: &str) -> JSValue {
        self.store(StoredValue::String(value.to_owned()))
    }

    pub fn host_functions(&self, value: JSValue) -> Vec<HostFunction> {
        let Value::Slot(slot) = value.0 else {
            panic!("expected a host function object");
        };
        let values = self.values.borrow();
        let StoredValue::HostObject(functions) = &values[slot] else {
            panic!("expected a host function object");
        };
        functions.clone()
    }

    pub fn throw(&self, message: fmt::Arguments<'_>) -> JsError {
        JsError::Error(message.to_string())
    }

    pub fn throw_out_of_memory(&self) -> JsError {
        JsError::OutOfMemory
    }
}

impl JSValue {
    pub const FALSE: Self = Self(Value::Boolean(false));
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

    pub fn to_js_string_view(self, global: &JSGlobalObject) -> JsResult<JSStringView> {
        let Value::Slot(slot) = self.0 else {
            return Err(JsError::TypeError("expected a string argument".to_owned()));
        };
        let values = global.values.borrow();
        match &values[slot] {
            StoredValue::String(value) => Ok(JSStringView(value.clone())),
            _ => Err(JsError::TypeError("expected a string argument".to_owned())),
        }
    }

    pub fn to_utf8(self, global: &JSGlobalObject) -> JsResult<Utf8Bytes> {
        Ok(self.to_js_string_view(global)?.to_utf8())
    }
}

pub struct JSStringView(String);

impl JSStringView {
    pub fn to_utf8(&self) -> Utf8Bytes {
        Utf8Bytes(self.0.as_bytes().into())
    }
}

pub struct Utf8Bytes(Box<[u8]>);

impl Utf8Bytes {
    pub fn slice(&self) -> &[u8] {
        &self.0
    }
}

impl Deref for Utf8Bytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        self.slice()
    }
}

pub struct CallFrame(Vec<JSValue>);

impl CallFrame {
    pub fn new(arguments: Vec<JSValue>) -> Self {
        Self(arguments)
    }

    pub fn arguments(&self) -> &[JSValue] {
        &self.0
    }

    pub fn argument(&self, index: usize) -> JSValue {
        self.0.get(index).copied().unwrap_or(JSValue::UNDEFINED)
    }
}

pub fn create_host_function_object(global: &JSGlobalObject, functions: &[HostFunction]) -> JSValue {
    global.store(StoredValue::HostObject(functions.to_vec()))
}
