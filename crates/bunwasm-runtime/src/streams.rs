use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use crate::data::{NativeError, Record, Val};
use crate::natives::Table;

use crate::compression::{Handle, Mode, Options, WebCoder, WebFormat};

struct TextDecoder {
    decoder: Decoder,
    fatal: bool,
}

impl TextDecoder {
    fn push(&mut self, bytes: &[u8], last: bool) -> Result<String, NativeError> {
        let capacity = self
            .decoder
            .max_utf8_buffer_length(bytes.len())
            .ok_or_else(|| NativeError::range_error("Input is too large"))?;
        let mut text = String::with_capacity(capacity);
        if self.fatal {
            let (result, _) = self
                .decoder
                .decode_to_string_without_replacement(bytes, &mut text, last);
            if result != DecoderResult::InputEmpty {
                return Err(NativeError::type_error("The encoded data was not valid"));
            }
        } else {
            let (result, _, _) = self.decoder.decode_to_string(bytes, &mut text, last);
            if result != CoderResult::InputEmpty {
                return Err(NativeError::range_error("Decoded text is too large"));
            }
        }
        Ok(text)
    }
}

enum Resource {
    /// A node:zlib native handle.
    Zlib(Handle),
    /// A Web CompressionStream/DecompressionStream coder.
    Web(WebCoder),
    Text(TextDecoder),
}

#[derive(Default)]
struct Resources {
    next: u32,
    values: HashMap<u32, Resource>,
}

impl Resources {
    fn insert(&mut self, value: Resource) -> u32 {
        self.next += 1;
        self.values.insert(self.next, value);
        self.next
    }
}

pub fn install(table: &mut Table) {
    let resources = Rc::new(RefCell::new(Resources::default()));
    let r = resources.clone();
    // node:zlib's `handle.init()`: (mode, options JSON, dictionary).
    table.add("streams.codec", move |a| {
        let options = Options::parse(a.opt_str(1), a.opt_bytes(2).unwrap_or(&[]))?;
        let handle = Handle::new(Mode::parse(a.str(0)?)?, &options)?;
        Ok(r.borrow_mut().insert(Resource::Zlib(handle)).into())
    });
    let r = resources.clone();
    table.add("streams.decoder", move |a| {
        let encoding = Encoding::for_label(a.str(0)?.as_bytes())
            .filter(|e| *e != encoding_rs::REPLACEMENT)
            .ok_or_else(|| NativeError::range_error("Unsupported encoding label"))?;
        let decoder = if a.bool(2) {
            encoding.new_decoder_without_bom_handling()
        } else {
            encoding.new_decoder_with_bom_removal()
        };
        let id = r.borrow_mut().insert(Resource::Text(TextDecoder {
            decoder,
            fatal: a.bool(1),
        }));
        Ok(Record::new()
            .set("id", id)
            .set("encoding", encoding.name().to_ascii_lowercase())
            .into())
    });
    let r = resources.clone();
    table.add("streams.push", move |a| {
        let id = a.u32(0)?;
        let mut resources = r.borrow_mut();
        let resource = resources
            .values
            .get_mut(&id)
            .ok_or_else(|| NativeError::type_error("Stream is closed"))?;
        match resource {
            Resource::Text(decoder) => decoder.push(a.bytes(1)?, a.bool(2)).map(Val::Str),
            _ => Err(NativeError::type_error("Not a text decoder")),
        }
    });
    // node:zlib's `handle.write()`: one codec call into an `outLength` buffer.
    // Returns the output and the input bytes left over.
    let r = resources.clone();
    table.add("streams.write", move |a| {
        let mut resources = r.borrow_mut();
        let Some(Resource::Zlib(handle)) = resources.values.get_mut(&a.u32(0)?) else {
            return Err(NativeError::type_error("zlib binding closed"));
        };
        let mut output = Vec::new();
        let size = a.u32(3)? as usize;
        output
            .try_reserve_exact(size)
            .map_err(|_| crate::compression::out_of_memory())?;
        output.resize(size, 0);
        let (available_in, available_out) = handle.write(a.bytes(1)?, a.i32(2)?, &mut output)?;
        output.truncate(size - available_out);
        Ok(Record::new()
            .set("bytes", Val::Bytes(output))
            .set("availIn", available_in as f64)
            .into())
    });
    let r = resources.clone();
    table.add("streams.params", move |a| {
        let mut resources = r.borrow_mut();
        let Some(Resource::Zlib(handle)) = resources.values.get_mut(&a.u32(0)?) else {
            return Err(NativeError::type_error("zlib binding closed"));
        };
        handle.params(a.i32(1)?, a.i32(2)?)?;
        Ok(Val::Undefined)
    });
    // Bun's CompressionStreamCoder: (format, decompress, highWaterMark, level).
    let r = resources.clone();
    table.add("streams.webCodec", move |a| {
        let format = WebFormat::parse(a.str(0)?)
            .ok_or_else(|| NativeError::type_error("Unsupported compression format"))?;
        let high_water_mark = a.opt_num(2).unwrap_or(65536.0) as usize;
        let level = a.opt_num(3).map(|n| n as i32);
        let coder = WebCoder::new(format, a.bool(1), high_water_mark, level)?;
        Ok(r.borrow_mut().insert(Resource::Web(coder)).into())
    });
    let r = resources.clone();
    table.add("streams.webStep", move |a| {
        let mut resources = r.borrow_mut();
        let Some(Resource::Web(coder)) = resources.values.get_mut(&a.u32(0)?) else {
            return Err(NativeError::type_error("Compression stream is closed"));
        };
        let (bytes, more) = coder.step(a.bytes(1)?, a.bool(2))?;
        Ok(Record::new()
            .set("bytes", Val::Bytes(bytes))
            .set("more", more)
            .into())
    });
    table.add("streams.release", move |a| {
        resources.borrow_mut().values.remove(&a.u32(0)?);
        Ok(Val::Undefined)
    });
}
