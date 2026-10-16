use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::rc::Rc;

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};
use flate2::write::{DeflateEncoder, GzDecoder, GzEncoder, ZlibEncoder};
use flate2::{Compression, Decompress, FlushDecompress, Status};

use crate::engine::{NativeError, Record, Val};
use crate::natives::Table;

enum Codec {
    Gzip(GzEncoder<Vec<u8>>),
    Zlib(ZlibEncoder<Vec<u8>>),
    Raw(DeflateEncoder<Vec<u8>>),
    Brotli(Option<Box<brotli::CompressorWriter<Vec<u8>>>>),
    Unbrotli(Box<brotli::DecompressorWriter<Vec<u8>>>),
    Gunzip(GzDecoder<Vec<u8>>),
    Inflate { decoder: Decompress, ended: bool },
}

impl Codec {
    fn new(format: &str, decompress: bool) -> Result<Self, NativeError> {
        let level = Compression::default();
        match (format, decompress) {
            ("gzip", false) => Ok(Self::Gzip(GzEncoder::new(Vec::new(), level))),
            ("deflate", false) => Ok(Self::Zlib(ZlibEncoder::new(Vec::new(), level))),
            ("deflate-raw", false) => Ok(Self::Raw(DeflateEncoder::new(Vec::new(), level))),
            ("brotli", false) => Ok(Self::Brotli(Some(Box::new(brotli::CompressorWriter::new(
                Vec::new(),
                4096,
                5,
                22,
            ))))),
            ("brotli", true) => Ok(Self::Unbrotli(Box::new(brotli::DecompressorWriter::new(
                Vec::new(),
                4096,
            )))),
            ("gzip", true) => Ok(Self::Gunzip(GzDecoder::new(Vec::new()))),
            ("deflate" | "deflate-raw", true) => Ok(Self::Inflate {
                decoder: Decompress::new(format == "deflate"),
                ended: false,
            }),
            _ => Err(NativeError::type_error("Unsupported compression format")),
        }
    }

    fn push(&mut self, bytes: &[u8], last: bool) -> Result<Vec<u8>, NativeError> {
        macro_rules! write_chunk {
            ($writer:expr) => {{
                let writer = $writer;
                writer.write_all(bytes).map_err(compression_error)?;
                if last {
                    writer.try_finish().map_err(compression_error)?;
                } else {
                    writer.flush().map_err(compression_error)?;
                }
                Ok(std::mem::take(writer.get_mut()))
            }};
        }
        match self {
            Self::Gzip(w) => write_chunk!(w),
            Self::Zlib(w) => write_chunk!(w),
            Self::Raw(w) => write_chunk!(w),
            Self::Gunzip(w) => write_chunk!(w),
            Self::Brotli(writer) => {
                let stream = writer
                    .as_mut()
                    .ok_or_else(|| compression_error("closed codec"))?;
                stream.write_all(bytes).map_err(compression_error)?;
                if last {
                    Ok(writer
                        .take()
                        .ok_or_else(|| compression_error("closed codec"))?
                        .into_inner())
                } else {
                    stream.flush().map_err(compression_error)?;
                    Ok(std::mem::take(stream.get_mut()))
                }
            }
            Self::Unbrotli(writer) => {
                writer.write_all(bytes).map_err(compression_error)?;
                if last {
                    writer.close().map_err(compression_error)?;
                }
                Ok(std::mem::take(writer.get_mut()))
            }
            Self::Inflate { decoder, ended } => inflate_chunk(decoder, ended, bytes, last),
        }
    }
}

fn compression_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::type_error(format!("Invalid compressed stream: {error}"))
}

fn inflate_chunk(
    decoder: &mut Decompress,
    ended: &mut bool,
    mut bytes: &[u8],
    last: bool,
) -> Result<Vec<u8>, NativeError> {
    let mut output = Vec::new();
    while !*ended {
        let mut block = [0; 16384];
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder
            .decompress(bytes, &mut block, FlushDecompress::None)
            .map_err(compression_error)?;
        let read = (decoder.total_in() - before_in) as usize;
        let written = (decoder.total_out() - before_out) as usize;
        bytes = &bytes[read..];
        output.extend_from_slice(&block[..written]);
        *ended = status == Status::StreamEnd;
        if read == 0 && written == 0 {
            break;
        }
    }
    if !bytes.is_empty() {
        return Err(compression_error("trailing data"));
    }
    if last && !*ended {
        return Err(compression_error("unexpected end of input"));
    }
    Ok(output)
}

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
    Compression(Codec),
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
    table.add("streams.codec", move |a| {
        let codec = Codec::new(a.str(0)?, a.bool(1))?;
        Ok(r.borrow_mut().insert(Resource::Compression(codec)).into())
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
            Resource::Compression(codec) => codec.push(a.bytes(1)?, a.bool(2)).map(Val::Bytes),
            Resource::Text(decoder) => decoder.push(a.bytes(1)?, a.bool(2)).map(Val::Str),
        }
    });
    table.add("streams.release", move |a| {
        resources.borrow_mut().values.remove(&a.u32(0)?);
        Ok(Val::Undefined)
    });
}
