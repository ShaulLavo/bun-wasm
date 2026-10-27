//! Owned plain data for core natives. No engine values or roots.

use std::rc::Rc;

/// Plain data crossing between natives and JS. Engines convert both ways:
/// `Bytes` is a `Uint8Array` in JS, `Object` a plain object, `BigInt` a
/// BigInt.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    BigInt(i64),
    BigUint(u64),
    Str(String),
    Bytes(Vec<u8>),
    Array(Vec<Val>),
    Object(Vec<(String, Val)>),
}

/// Releases an owned tree without recursing through its descendants' drop glue.
#[cfg(any(feature = "engine-split", not(feature = "engine-host")))]
pub(crate) fn drop_tree(value: Val) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Val::Array(items) => pending.extend(items),
            Val::Object(fields) => {
                pending.extend(fields.into_iter().map(|(_, value)| value));
            }
            _ => {}
        }
    }
}

impl From<()> for Val {
    fn from(_: ()) -> Val {
        Val::Undefined
    }
}
impl From<bool> for Val {
    fn from(v: bool) -> Val {
        Val::Bool(v)
    }
}
impl From<f64> for Val {
    fn from(v: f64) -> Val {
        Val::Num(v)
    }
}
impl From<i32> for Val {
    fn from(v: i32) -> Val {
        Val::Num(f64::from(v))
    }
}
impl From<u32> for Val {
    fn from(v: u32) -> Val {
        Val::Num(f64::from(v))
    }
}
impl From<String> for Val {
    fn from(v: String) -> Val {
        Val::Str(v)
    }
}
impl From<&str> for Val {
    fn from(v: &str) -> Val {
        Val::Str(v.to_owned())
    }
}
impl From<Vec<u8>> for Val {
    fn from(v: Vec<u8>) -> Val {
        Val::Bytes(v)
    }
}
impl<T: Into<Val>> From<Option<T>> for Val {
    fn from(v: Option<T>) -> Val {
        v.map_or(Val::Undefined, Into::into)
    }
}
impl From<Vec<Val>> for Val {
    fn from(v: Vec<Val>) -> Val {
        Val::Array(v)
    }
}

/// Builds a `Val::Object` field by field.
#[derive(Default)]
pub struct Record(Vec<(String, Val)>);

impl Record {
    pub fn new() -> Record {
        Record(Vec::new())
    }
    pub fn set(mut self, key: &str, value: impl Into<Val>) -> Record {
        self.0.push((key.to_owned(), value.into()));
        self
    }
    pub fn push(&mut self, key: &str, value: impl Into<Val>) {
        self.0.push((key.to_owned(), value.into()));
    }
}

impl From<Record> for Val {
    fn from(r: Record) -> Val {
        Val::Object(r.0)
    }
}

/// Which built-in error constructor a native error uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Error,
    TypeError,
    RangeError,
    SyntaxError,
}

/// An error thrown by a native: becomes a JS error object with `message`
/// and the extra own properties in `props` (in order; e.g. Node's
/// `path`/`syscall`/`errno`/`code`).
#[derive(Clone, Debug)]
pub struct NativeError {
    pub kind: ErrorKind,
    pub message: String,
    pub name: Option<String>,
    pub props: Vec<(String, Val)>,
}

impl NativeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> NativeError {
        NativeError {
            kind,
            message: message.into(),
            name: None,
            props: Vec::new(),
        }
    }
    pub fn error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::Error, message)
    }
    pub fn type_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::TypeError, message)
    }
    pub fn range_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::RangeError, message)
    }
    pub fn syntax_error(message: impl Into<String>) -> NativeError {
        NativeError::new(ErrorKind::SyntaxError, message)
    }
    pub fn prop(mut self, key: &str, value: impl Into<Val>) -> NativeError {
        self.props.push((key.to_owned(), value.into()));
        self
    }
    pub fn named(mut self, name: &str) -> NativeError {
        self.name = Some(name.to_owned());
        self
    }
}

pub type NativeResult = Result<Val, NativeError>;

/// Positional arguments of a data native, with conversions that report
/// Bun-style type errors.
pub struct Args<'a>(pub &'a [Val]);

impl<'a> Args<'a> {
    pub fn get(&self, i: usize) -> &'a Val {
        self.0.get(i).unwrap_or(&Val::Undefined)
    }
    pub fn is_missing(&self, i: usize) -> bool {
        matches!(self.get(i), Val::Undefined | Val::Null)
    }
    pub fn str(&self, i: usize) -> Result<&'a str, NativeError> {
        match self.get(i) {
            Val::Str(s) => Ok(s),
            other => Err(NativeError::type_error(format!(
                "expected a string argument, got {}",
                describe(other)
            ))),
        }
    }
    pub fn string(&self, i: usize) -> Result<String, NativeError> {
        self.str(i).map(str::to_owned)
    }
    pub fn opt_str(&self, i: usize) -> Option<&'a str> {
        match self.get(i) {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
    /// A string (as UTF-8) or a byte buffer.
    pub fn bytes(&self, i: usize) -> Result<&'a [u8], NativeError> {
        match self.get(i) {
            Val::Str(s) => Ok(s.as_bytes()),
            Val::Bytes(b) => Ok(b),
            other => Err(NativeError::type_error(format!(
                "expected a string, Uint8Array or ArrayBuffer, got {}",
                describe(other)
            ))),
        }
    }
    pub fn opt_bytes(&self, i: usize) -> Option<&'a [u8]> {
        if self.is_missing(i) {
            None
        } else {
            self.bytes(i).ok()
        }
    }
    pub fn num(&self, i: usize) -> Result<f64, NativeError> {
        match self.get(i) {
            Val::Num(n) => Ok(*n),
            Val::Bool(b) => Ok(f64::from(u8::from(*b))),
            Val::BigInt(n) => Ok(*n as f64),
            Val::BigUint(n) => Ok(*n as f64),
            other => Err(NativeError::type_error(format!(
                "expected a number argument, got {}",
                describe(other)
            ))),
        }
    }
    pub fn opt_num(&self, i: usize) -> Option<f64> {
        self.num(i).ok().filter(|n| !n.is_nan())
    }
    pub fn i32(&self, i: usize) -> Result<i32, NativeError> {
        self.num(i).map(|n| n as i32)
    }
    pub fn u32(&self, i: usize) -> Result<u32, NativeError> {
        self.num(i).map(|n| n as u32)
    }
    pub fn bool(&self, i: usize) -> bool {
        match self.get(i) {
            Val::Bool(b) => *b,
            Val::Num(n) => *n != 0.0,
            Val::Undefined | Val::Null => false,
            _ => true,
        }
    }
    pub fn opt_bool(&self, i: usize) -> Option<bool> {
        match self.get(i) {
            Val::Undefined | Val::Null => None,
            _ => Some(self.bool(i)),
        }
    }
    pub fn array(&self, i: usize) -> Option<&'a [Val]> {
        match self.get(i) {
            Val::Array(items) => Some(items),
            _ => None,
        }
    }
}

fn describe(v: &Val) -> &'static str {
    match v {
        Val::Undefined => "undefined",
        Val::Null => "null",
        Val::Bool(_) => "a boolean",
        Val::Num(_) => "a number",
        Val::BigInt(_) | Val::BigUint(_) => "a bigint",
        Val::Str(_) => "a string",
        Val::Bytes(_) => "a byte buffer",
        Val::Array(_) => "an array",
        Val::Object(_) => "an object",
    }
}

/// A native over plain data.
pub type DataFn = Rc<dyn Fn(Args<'_>) -> NativeResult>;

#[path = "data/codec.rs"]
pub(crate) mod codec;
