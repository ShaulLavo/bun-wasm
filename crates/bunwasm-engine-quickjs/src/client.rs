use crate::data::{NativeError, NativeResult, Val, codec, drop_tree};
use crate::ops;
use crate::transport::{
    TransportBuffer, bun_core_dispatch, bun_core_exit, bun_core_idle, bun_core_poll,
};

#[derive(Clone, Copy)]
pub(crate) struct CoreClient {
    pub(crate) session: u32,
}

impl CoreClient {
    pub(crate) fn call(self, op: u32, args: Vec<Val>) -> NativeResult {
        let args = Val::Array(args);
        let bytes = codec::encode(&args).map_err(|_| NativeError::error("encode core request"));
        drop_tree(args);
        let bytes = bytes?;
        let request = TransportBuffer::new(u32::try_from(bytes.len()).expect("request size"));
        let frame = TransportBuffer::new(24);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), request.pointer as *mut u8, bytes.len());
        }
        let words = [op, self.session, request.pointer, request.bytes, 0, 0];
        unsafe {
            std::ptr::copy_nonoverlapping(words.as_ptr(), frame.pointer as *mut u32, words.len());
        }
        drop(bytes);
        let status = match unsafe { bun_core_dispatch(frame.pointer) } {
            0 => ops::Status::Ok,
            1 => ops::Status::NativeError,
            3 => ops::Status::ResourceLimit,
            status => panic!("terminal core transport failure {status}"),
        };
        let pointer = unsafe { (frame.pointer as *const u32).add(4).read() };
        let bytes = unsafe { (frame.pointer as *const u32).add(5).read() };
        if status == ops::Status::ResourceLimit {
            // Core failed to allocate the request copy or the reply and wrote no reply.
            assert!(pointer == 0 && bytes == 0, "core resource limit with a reply");
            return ops::Reply { status, bytes: Vec::new() }.into_result();
        }
        let reply = TransportBuffer { pointer, bytes };
        let bytes = unsafe {
            std::slice::from_raw_parts(reply.pointer as *const u8, reply.bytes as usize).to_vec()
        };
        ops::Reply { status, bytes }.into_result()
    }

    pub(crate) fn native(self, id: u32, args: Vec<Val>) -> NativeResult {
        self.call(ops::DATA_NATIVE.checked_add(id).expect("native op"), args)
    }
}

pub(crate) struct NativeTable {
    pub(crate) functions: Vec<String>,
    pub(crate) constants: Vec<(String, Val)>,
}

fn malformed() -> NativeError {
    NativeError::error("invalid core operation reply")
}

fn field(value: Val, key: &str) -> Result<Val, NativeError> {
    let Val::Object(fields) = value else {
        return Err(malformed());
    };
    fields
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
        .ok_or_else(malformed)
}

fn string(value: Val) -> Result<String, NativeError> {
    let Val::Str(value) = value else {
        return Err(malformed());
    };
    Ok(value)
}

fn strings(value: Val) -> Result<Vec<String>, NativeError> {
    let Val::Array(values) = value else {
        return Err(malformed());
    };
    values.into_iter().map(string).collect()
}

fn pair(value: Val) -> Result<(String, String), NativeError> {
    let Val::Array(values) = value else {
        return Err(malformed());
    };
    let mut values = values.into_iter();
    let (Some(first), Some(second), None) = (values.next(), values.next(), values.next()) else {
        return Err(malformed());
    };
    Ok((string(first)?, string(second)?))
}

impl CoreClient {
    pub(crate) fn entry(self) -> Result<(crate::driver::Entry, String), NativeError> {
        let description = self.call(crate::split_api::DESCRIBE, vec![])?;
        let main = string(field(description.clone(), "main")?)?;
        let Val::Array(entry) = field(description, "entry")? else {
            return Err(malformed());
        };
        let mut entry = entry.into_iter();
        let (Some(kind), Some(value), None) = (entry.next(), entry.next(), entry.next()) else {
            return Err(malformed());
        };
        let entry = match string(kind)?.as_str() {
            "file" => crate::driver::Entry::File(string(value)?),
            "eval" => crate::driver::Entry::Eval(string(value)?),
            "test" => crate::driver::Entry::Test(strings(value)?),
            _ => return Err(malformed()),
        };
        Ok((entry, main))
    }

    pub(crate) fn natives(self) -> Result<NativeTable, NativeError> {
        let description = self.call(crate::split_api::DESCRIBE, vec![])?;
        let functions = strings(field(description.clone(), "functions")?)?;
        let Val::Object(constants) = field(description, "constants")? else {
            return Err(malformed());
        };
        Ok(NativeTable {
            functions,
            constants,
        })
    }

    pub(crate) fn resolve(self, specifier: &str, referrer: &str) -> Result<String, NativeError> {
        let Val::Array(values) = self.call(
            crate::split_api::RESOLVE,
            vec![specifier.into(), referrer.into()],
        )?
        else {
            return Err(malformed());
        };
        values
            .into_iter()
            .next()
            .ok_or_else(malformed)
            .and_then(string)
    }

    fn source(self, mode: &str, name: &str) -> NativeResult {
        self.call(
            crate::split_api::PREPARE_SOURCE,
            vec![mode.into(), name.into()],
        )
    }

    pub(crate) fn eval_source(self, code: &str) -> Result<(String, String), NativeError> {
        pair(self.source("eval", code)?)
    }

    pub(crate) fn module_source(self, name: &str) -> Result<(String, String), NativeError> {
        pair(self.source("module", name)?)
    }

    pub(crate) fn cjs_source(self, name: &str) -> Result<(String, i32), NativeError> {
        let Val::Array(values) = self.source("cjs", name)? else {
            return Err(malformed());
        };
        let mut values = values.into_iter();
        let (Some(source), Some(Val::Num(line)), None) =
            (values.next(), values.next(), values.next())
        else {
            return Err(malformed());
        };
        Ok((string(source)?, line as i32))
    }

    pub(crate) fn polyfill(self, name: &str) -> Result<String, NativeError> {
        string(self.call(crate::split_api::POLYFILL_SOURCE, vec![name.into()])?)
    }

    pub(crate) fn wrapper(self, keys: Vec<String>) -> Result<String, NativeError> {
        string(self.call(
            crate::split_api::WRAPPER_SOURCE,
            vec![Val::Array(keys.into_iter().map(Val::from).collect())],
        )?)
    }

    pub(crate) fn is_main(self, name: &str) -> Result<bool, NativeError> {
        Ok(string(self.call(crate::split_api::MAIN_PATH, vec![])?)? == name)
    }

    pub(crate) fn take_tick(self) -> bool {
        self.call(crate::split_api::TAKE_TICK, vec![])
            .expect("take nextTick")
            == Val::Bool(true)
    }

    pub(crate) fn flush(self) {
        self.call(crate::split_api::FLUSH, vec![])
            .expect("flush stdout");
    }

    pub(crate) fn idle(self, ms: i32) {
        unsafe { bun_core_idle(ms) };
    }

    pub(crate) fn poll(self, ms: i32) {
        unsafe { bun_core_poll(ms) };
    }

    pub(crate) fn interrupt(self) -> bool {
        unsafe { crate::transport::core_checkpoint() != 0 }
    }

    pub(crate) fn exit(self, code: i32) -> ! {
        unsafe { bun_core_exit(code) }
    }
}
