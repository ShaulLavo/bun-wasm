use std::cell::Cell;

use crate::data::{NativeError, NativeResult, Val, WORD_ARGS, codec, drop_tree};
use crate::ops;
use crate::transport::{
    TransportBuffer, bun_core_dispatch, bun_core_exit, bun_core_idle, bun_core_poll,
};

#[derive(Clone, Copy)]
pub(crate) struct CoreClient {
    pub(crate) session: u32,
    /// The one frame every word call reuses, allocated before any program code runs.
    word_frame: u32,
}

impl CoreClient {
    pub(crate) fn new(session: u32) -> Self {
        let frame = TransportBuffer::new(ops::WordFrame::SIZE as u32).expect("word call frame");
        let word_frame = frame.pointer;
        // Kept for the life of the process, like the engine itself.
        std::mem::forget(frame);
        Self {
            session,
            word_frame,
        }
    }

    /// Calls a word native through the preallocated frame. This function allocates nothing and
    /// returns no error: the call yields its result, or the guest ends on a broken transport.
    pub(crate) fn word(self, op: u32, words: [u32; WORD_ARGS]) -> i64 {
        let frame = self.word_frame as *mut u32;
        // SAFETY: core allocated WordFrame::SIZE bytes, 8-aligned, at word_frame for this
        // client's life. Word natives never reenter the engine, so one call uses it at a time.
        unsafe {
            frame.write(op);
            frame.add(1).write(self.session);
            std::ptr::copy_nonoverlapping(words.as_ptr(), frame.add(2), WORD_ARGS);
        }
        let status = unsafe { bun_core_dispatch(self.word_frame) };
        assert_eq!(status, ops::Status::Ok as u32, "terminal core word call");
        // SAFETY: as above; core wrote the result at this 8-aligned offset.
        unsafe {
            (self.word_frame as *const u8)
                .add(ops::WordFrame::RESULT)
                .cast::<i64>()
                .read()
        }
    }

    pub(crate) fn call(self, op: u32, args: Vec<Val>) -> NativeResult {
        let args = Val::Array(args);
        let request = request(&args);
        drop_tree(args);
        let (request, request_len) = request?;
        let Some(frame) = Spare::FRAME.take(ops::Frame::SIZE as u32) else {
            Spare::REQUEST.keep(request);
            return allocation_failed();
        };
        let words = [op, self.session, request.pointer, request_len, 0, 0];
        // SAFETY: core allocated Frame::SIZE bytes, 8-aligned, at frame.pointer, and this call
        // holds the frame alone until it is kept again.
        let (status, pointer, bytes) = unsafe {
            let frame = frame.pointer as *mut u32;
            std::ptr::copy_nonoverlapping(words.as_ptr(), frame, words.len());
            let status = bun_core_dispatch(frame as u32);
            (status, frame.add(4).read(), frame.add(5).read())
        };
        Spare::REQUEST.keep(request);
        Spare::FRAME.keep(frame);
        reply(status, pointer, bytes)
    }

    pub(crate) fn native(self, id: u32, args: Vec<Val>) -> NativeResult {
        self.call(ops::DATA_NATIVE.checked_add(id).expect("native op"), args)
    }
}

/// Decodes the reply core wrote for a data call, and frees it.
fn reply(status: u32, pointer: u32, bytes: u32) -> NativeResult {
    let status = match status {
        0 => ops::Status::Ok,
        1 => ops::Status::NativeError,
        3 => ops::Status::ResourceLimit,
        status => panic!("terminal core transport failure {status}"),
    };
    if status == ops::Status::ResourceLimit {
        // Core failed to allocate the reply and wrote none.
        assert!(
            pointer == 0 && bytes == 0,
            "core resource limit with a reply"
        );
        return allocation_failed();
    }
    let reply = TransportBuffer { pointer, bytes };
    // Decode the reply where core wrote it; copying it out would hold the payload twice.
    let bytes: &[u8] = if reply.bytes == 0 {
        &[]
    } else {
        // SAFETY: core allocated reply.bytes initialized bytes at reply.pointer for this reply.
        unsafe { std::slice::from_raw_parts(reply.pointer as *const u8, reply.bytes as usize) }
    };
    ops::Reply::decode(status, bytes)
}

/// A core buffer the client keeps between calls: allocating one per call costs about as much
/// as a small call itself. Calls nest (a core native can call back into the engine, which calls
/// core again while the outer call holds its buffers), so a call takes the spare and a nested
/// call allocates its own. The slot holds a pointer and a size, not a value with a destructor,
/// so nothing frees core memory at thread exit.
struct Spare(&'static std::thread::LocalKey<Cell<(u32, u32)>>);

thread_local! {
    static SPARE_FRAME: Cell<(u32, u32)> = const { Cell::new((0, 0)) };
    static SPARE_REQUEST: Cell<(u32, u32)> = const { Cell::new((0, 0)) };
}

/// Requests up to this size encode into a kept buffer. A larger one gets its own exact buffer,
/// freed after the call, so one large write does not hold its size for the life of the process.
const SPARE_LIMIT: u32 = 64 << 10;
/// The smallest kept request buffer: most requests are a path or a few numbers.
const SPARE_REQUEST_MIN: u32 = 4 << 10;

impl Spare {
    const FRAME: Self = Self(&SPARE_FRAME);
    const REQUEST: Self = Self(&SPARE_REQUEST);

    /// The spare when it holds at least `bytes`, otherwise a new buffer of exactly `bytes`.
    fn take(&self, bytes: u32) -> Option<TransportBuffer> {
        let (pointer, size) = self.0.with(|slot| slot.replace((0, 0)));
        if pointer != 0 && size >= bytes {
            return Some(TransportBuffer {
                pointer,
                bytes: size,
            });
        }
        if pointer != 0 {
            drop(TransportBuffer {
                pointer,
                bytes: size,
            });
        }
        TransportBuffer::new(bytes)
    }

    /// Keeps `buffer` for the next call unless it is over the limit or the slot already holds
    /// one at least as large. Whatever is not kept is freed.
    fn keep(&self, buffer: TransportBuffer) {
        let (pointer, bytes) = self.0.with(Cell::get);
        if buffer.bytes > SPARE_LIMIT || (pointer != 0 && bytes >= buffer.bytes) {
            return;
        }
        let buffer = std::mem::ManuallyDrop::new(buffer);
        self.0.with(|slot| slot.set((buffer.pointer, buffer.bytes)));
        if pointer != 0 {
            drop(TransportBuffer { pointer, bytes });
        }
    }
}

/// Encodes the request in one pass into the kept buffer when it fits. Otherwise it measures the
/// request and encodes it into a buffer that holds it. Returns the buffer and the request's
/// length, which may be shorter than the buffer.
fn request(args: &Val) -> Result<(TransportBuffer, u32), NativeError> {
    let encode_error = |_| NativeError::error("encode core request");
    let Some(spare) = Spare::REQUEST.take(SPARE_REQUEST_MIN) else {
        return allocation_failed();
    };
    let encoded = codec::encode_prefix(args, buffer_bytes(&spare));
    if let Some(len) = encoded.map_err(encode_error)? {
        return Ok((spare, u32::try_from(len).expect("request size")));
    }
    Spare::REQUEST.keep(spare);
    let len = codec::encoded_len(args).map_err(encode_error)?;
    let len = u32::try_from(len).expect("request size");
    // A request that outgrew the spare but stays under the limit gets a larger kept buffer.
    let size = match len.checked_next_power_of_two() {
        Some(size) if size <= SPARE_LIMIT => size,
        _ => len,
    };
    let Some(request) = Spare::REQUEST.take(size) else {
        return allocation_failed();
    };
    let bytes = &mut buffer_bytes(&request)[..len as usize];
    codec::encode_into(args, bytes).map_err(encode_error)?;
    Ok((request, len))
}

/// The whole of a buffer core allocated for this client.
#[allow(clippy::mut_from_ref, reason = "core memory the client holds alone")]
fn buffer_bytes(buffer: &TransportBuffer) -> &mut [u8] {
    // SAFETY: core allocated buffer.bytes initialized bytes at buffer.pointer. The client holds
    // the buffer alone until it dispatches, and core reads it only during that dispatch.
    unsafe { std::slice::from_raw_parts_mut(buffer.pointer as *mut u8, buffer.bytes as usize) }
}

fn allocation_failed<T>() -> Result<T, NativeError> {
    Err(NativeError::error("core data allocation failed"))
}

pub(crate) struct NativeTable {
    pub(crate) functions: Vec<String>,
    /// Word natives, in operation order.
    pub(crate) words: Vec<String>,
    pub(crate) constants: Vec<(String, Val)>,
}

/// What core tells the engine once, at startup: the program to run and the natives to install.
pub(crate) struct Description {
    pub(crate) entry: crate::driver::Entry,
    pub(crate) main: String,
    pub(crate) natives: NativeTable,
}

fn malformed() -> NativeError {
    NativeError::error("invalid core operation reply")
}

/// Moves the field named `key` out of a record's fields.
fn field(fields: &mut Vec<(String, Val)>, key: &str) -> Result<Val, NativeError> {
    let index = fields
        .iter()
        .position(|(name, _)| name == key)
        .ok_or_else(malformed)?;
    Ok(fields.swap_remove(index).1)
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

fn entry(value: Val) -> Result<crate::driver::Entry, NativeError> {
    let Val::Array(entry) = value else {
        return Err(malformed());
    };
    let mut entry = entry.into_iter();
    let (Some(kind), Some(value), None) = (entry.next(), entry.next(), entry.next()) else {
        return Err(malformed());
    };
    match string(kind)?.as_str() {
        "file" => Ok(crate::driver::Entry::File(string(value)?)),
        "eval" => Ok(crate::driver::Entry::Eval(string(value)?)),
        "test" => Ok(crate::driver::Entry::Test(strings(value)?)),
        _ => Err(malformed()),
    }
}

impl CoreClient {
    /// Reads core's description. Core hands it over once.
    pub(crate) fn describe(self) -> Result<Description, NativeError> {
        let Val::Object(mut fields) = self.call(crate::split_api::DESCRIBE, vec![])? else {
            return Err(malformed());
        };
        let main = string(field(&mut fields, "main")?)?;
        let entry = entry(field(&mut fields, "entry")?)?;
        let functions = strings(field(&mut fields, "functions")?)?;
        let words = strings(field(&mut fields, "words")?)?;
        let Val::Object(constants) = field(&mut fields, "constants")? else {
            return Err(malformed());
        };
        drop_tree(Val::Object(fields));
        Ok(Description {
            entry,
            main,
            natives: NativeTable {
                functions,
                words,
                constants,
            },
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

    pub(crate) fn module_record(self, name: &str) -> Result<(String, String), NativeError> {
        pair(self.source("record", name)?)
    }

    pub(crate) fn lower_script(self, source: &str, filename: &str) -> Result<String, NativeError> {
        string(self.call(
            crate::split_api::LOWER_SCRIPT,
            vec![source.into(), filename.into()],
        )?)
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

    /// Whether a `process.nextTick` callback was queued since the last check. Called on every
    /// job drain, so it is a word call.
    pub(crate) fn take_tick(self) -> bool {
        self.word(crate::split_api::WORD_TAKE_TICK, [0; WORD_ARGS]) != 0
    }

    pub(crate) fn flush(self) {
        self.word(crate::split_api::WORD_FLUSH, [0; WORD_ARGS]);
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
