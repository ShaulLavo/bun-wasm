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
        let (available_in, _) =
            handle.write_into(a.bytes(1)?, a.i32(2)?, a.u32(3)? as usize, &mut output)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compression::convert;
    use crate::compression::tests::measure;
    use crate::data::Args;

    /// webpack's pack cache streams ask for 100 MiB per write (FileMiddleware's chunkSize).
    const WEBPACK_CHUNK: usize = 100 << 20;
    const PAIRS: [(&str, &str); 5] = [
        ("gzip", "gunzip"),
        ("deflate", "inflate"),
        ("deflateRaw", "inflateRaw"),
        ("brotliEncode", "brotliDecode"),
        ("zstdCompress", "zstdDecompress"),
    ];

    fn call(table: &Table, name: &str, args: Vec<Val>) -> Val {
        let (_, function) = table
            .functions
            .iter()
            .find(|(key, _)| *key == name)
            .expect("streams native");
        function(Args(&args)).expect(name)
    }

    fn codec(table: &Table, mode: &str) -> Val {
        call(table, "streams.codec", vec![mode.into()])
    }

    /// One `handle.write()` with `room` bytes of output space: (bytes, availIn).
    fn write(table: &Table, id: &Val, input: &[u8], flush: i32, room: usize) -> (Vec<u8>, f64) {
        let args = vec![
            id.clone(),
            Val::Bytes(input.to_vec()),
            Val::Num(f64::from(flush)),
            Val::Num(room as f64),
        ];
        let Val::Object(fields) = call(table, "streams.write", args) else {
            panic!("write record");
        };
        let mut bytes = Vec::new();
        let mut available_in = f64::NAN;
        for (key, value) in fields {
            match (key.as_str(), value) {
                ("bytes", Val::Bytes(value)) => bytes = value,
                ("availIn", Val::Num(value)) => available_in = value,
                _ => {}
            }
        }
        (bytes, available_in)
    }

    /// The sync convenience functions' loop with `chunk`-byte writes.
    fn convert_all(mode: &str, input: &[u8], chunk: usize) -> Vec<u8> {
        let mode = Mode::parse(mode).unwrap();
        let options = Options::default();
        convert(
            mode,
            &options,
            input,
            mode.finish_flush(),
            chunk,
            usize::MAX,
        )
        .unwrap()
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i % 251) ^ (i / 4093)) as u8).collect()
    }

    #[test]
    fn large_out_lengths_allocate_what_the_codec_writes() {
        let plain = sample(3 << 20);
        let mut table = Table::default();
        install(&mut table);
        for (encode, decode) in PAIRS {
            let finish = Mode::parse(encode).unwrap().finish_flush();
            let packed = convert_all(encode, &plain, 16384);
            let id = codec(&table, decode);
            let ((bytes, available_in), largest, _) =
                measure(|| write(&table, &id, &packed, finish, WEBPACK_CHUNK));
            assert!(bytes == plain && available_in == 0.0, "{decode} output");
            assert!(largest < 16 << 20, "{decode} allocated {largest} bytes");
            let (bytes, largest, _) = measure(|| convert_all(decode, &packed, WEBPACK_CHUNK));
            assert!(bytes == plain, "{decode} sync output");
            assert!(
                largest < 16 << 20,
                "{decode} sync allocated {largest} bytes"
            );
            let id = codec(&table, encode);
            let ((bytes, available_in), largest, _) =
                measure(|| write(&table, &id, &plain, finish, WEBPACK_CHUNK));
            assert!(available_in == 0.0, "{encode} input");
            assert!(
                convert_all(decode, &bytes, 16384) == plain,
                "{encode} round trip"
            );
            assert!(largest < 16 << 20, "{encode} allocated {largest} bytes");
        }
    }

    #[test]
    fn a_member_ending_on_a_piece_boundary_does_not_end_the_write() {
        let member = convert_all("gzip", &sample(1 << 20), 16384);
        let mut table = Table::default();
        install(&mut table);
        let id = codec(&table, "gunzip");
        let input = [member.as_slice(), member.as_slice()].concat();
        let (bytes, available_in) = write(&table, &id, &input, 4, WEBPACK_CHUNK);
        assert_eq!(available_in, 0.0);
        assert!(bytes == [sample(1 << 20), sample(1 << 20)].concat());
    }
}
