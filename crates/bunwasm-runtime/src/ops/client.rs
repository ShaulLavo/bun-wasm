use super::*;
use crate::data::NativeResult;

impl Reply {
    pub fn into_result(self) -> NativeResult {
        match self.status {
            Status::Ok => codec::decode(&self.bytes).map_err(transport_error),
            Status::NativeError => decode_error(&self.bytes).and_then(Err),
            Status::BadCall => Err(NativeError::error("invalid core data call")),
            Status::ResourceLimit => Err(NativeError::error("core data allocation failed")),
        }
    }
}

impl Dispatcher {
    pub fn new(session: NonZeroU32, native_id: u32, function: DataFn) -> Option<Self> {
        let op = DATA_NATIVE.checked_add(native_id)?;
        Self::registry(session, vec![(op, function)])
    }
    pub fn call(&self, args: Vec<Val>) -> NativeResult {
        if self.functions.len() != 1 {
            return Err(NativeError::error("expected one data native"));
        }
        let op = *self.functions.keys().next().expect("one data native");
        abi::call(self, op, self.session.get(), args)
    }
}

pub(super) fn transport_error(error: CodecError) -> NativeError {
    match error {
        CodecError::Invalid(message) => NativeError::error(format!("invalid core data: {message}")),
        CodecError::Allocation => NativeError::error("core data allocation failed"),
    }
}

pub(super) fn decode_error(bytes: &[u8]) -> Result<NativeError, NativeError> {
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
