use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::rc::Rc;

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};
use flate2::write::{DeflateEncoder, MultiGzDecoder, GzEncoder, ZlibEncoder};
use flate2::{Compression, Decompress, FlushDecompress, Status};

use crate::engine::{NativeError, Record, Val};
use crate::natives::Table;

enum Codec {
    Gzip(GzEncoder<Vec<u8>>),
    Zlib(ZlibEncoder<Vec<u8>>),
    Raw(DeflateEncoder<Vec<u8>>),
    Brotli(Option<Box<brotli::CompressorWriter<Vec<u8>>>>),
    Unbrotli(Box<brotli::DecompressorWriter<Vec<u8>>>),
    Gunzip(MultiGzDecoder<Vec<u8>>),
    Zstd(Option<zstd::stream::write::Encoder<'static, Vec<u8>>>),
    Unzstd(bun_zstd::StreamingDecoder),
    Inflate { decoder: Decompress, ended: bool },
}

impl Codec {
    fn new(format: &str, decompress: bool, level: i32, parameters: Option<&str>) -> Result<Self, NativeError> {
        let parameters: BTreeMap<u32, i32> = match parameters {
            Some(json) => serde_json::from_str(json).map_err(|e| NativeError::type_error(e.to_string()))?,
            None => BTreeMap::new(),
        };
        let zlib_level = Compression::new(if level < 0 { 6 } else { level as u32 });
        match (format, decompress) {
            ("gzip", false) => Ok(Self::Gzip(GzEncoder::new(Vec::new(), zlib_level))),
            ("deflate", false) => Ok(Self::Zlib(ZlibEncoder::new(Vec::new(), zlib_level))),
            ("deflate-raw", false) => Ok(Self::Raw(DeflateEncoder::new(Vec::new(), zlib_level))),
            ("brotli", false) => Ok(Self::Brotli(Some(Box::new(brotli::CompressorWriter::with_params(
                Vec::new(),
                4096,
                &brotli_parameters(level, &parameters)?,
            ))))),
            ("brotli", true) => Ok(Self::Unbrotli(Box::new(brotli::DecompressorWriter::new(
                Vec::new(),
                4096,
            )))),
            ("gzip", true) => Ok(Self::Gunzip(MultiGzDecoder::new(Vec::new()))),
            ("zstd", false) => Ok(Self::Zstd(Some(zstd_encoder(level, &parameters)?))),
            ("zstd", true) => Ok(Self::Unzstd(bun_zstd::StreamingDecoder::new()
                .map_err(|e| compression_error(format!("{e:?}")))?)),
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
            Self::Zstd(writer) => {
                let stream = writer.as_mut().ok_or_else(|| compression_error("closed codec"))?;
                stream.write_all(bytes).map_err(compression_error)?;
                if last {
                    writer.take().ok_or_else(|| compression_error("closed codec"))?
                        .finish().map_err(compression_error)
                } else {
                    stream.flush().map_err(compression_error)?;
                    Ok(std::mem::take(stream.get_mut()))
                }
            }
            Self::Unzstd(decoder) => zstd_chunk(decoder, bytes, last),
            Self::Inflate { decoder, ended } => inflate_chunk(decoder, ended, bytes, last),
        }
    }
}

fn zstd_chunk(decoder: &mut bun_zstd::StreamingDecoder, bytes: &[u8], last: bool) -> Result<Vec<u8>, NativeError> {
    let mut output = Vec::new();
    match decoder.decompress(bytes, &mut output, usize::MAX, last) {
        Ok(_) | Err(bun_zstd::ZstdError::ShortRead) => Ok(output),
        Err(error) => Err(compression_error(format!("{error:?}"))),
    }
}

fn brotli_parameters(level: i32, parameters: &BTreeMap<u32, i32>) -> Result<brotli::enc::BrotliEncoderParams, NativeError> {
    use brotli::enc::encode::BrotliEncoderParameter as P;
    let mut params = brotli::enc::BrotliEncoderParams {
        quality: if level < 0 { 5 } else { level }, ..Default::default()
    };
    for (&key, &value) in parameters {
        if value < 0 || (key == 7 && value > 3) || (key == 8 && value > 120) {
            return Err(NativeError::range_error("Invalid Brotli parameter value"));
        }
        if key == 7 { params.dist.distance_postfix_bits = value as u32; continue; }
        if key == 8 { params.dist.num_direct_distance_codes = value as u32; continue; }
        let parameter = match key {
            0 => P::BROTLI_PARAM_MODE,
            1 => P::BROTLI_PARAM_QUALITY,
            2 => P::BROTLI_PARAM_LGWIN,
            3 => P::BROTLI_PARAM_LGBLOCK,
            4 => P::BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING,
            5 => P::BROTLI_PARAM_SIZE_HINT,
            6 => P::BROTLI_PARAM_LARGE_WINDOW,
            _ => return Err(NativeError::range_error("Invalid Brotli parameter")),
        };
        if !brotli::enc::encode::set_parameter(&mut params, parameter, value as u32) {
            return Err(NativeError::range_error("Invalid Brotli parameter value"));
        }
    }
    let postfix = params.dist.distance_postfix_bits;
    let direct = params.dist.num_direct_distance_codes;
    if direct > (15 << postfix) || direct & ((1 << postfix) - 1) != 0 {
        return Err(NativeError::range_error("Invalid Brotli distance parameters"));
    }
    Ok(params)
}

fn zstd_encoder(level: i32, parameters: &BTreeMap<u32, i32>) -> Result<zstd::stream::write::Encoder<'static, Vec<u8>>, NativeError> {
    use zstd::zstd_safe::CParameter as P;
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), level).map_err(compression_error)?;
    for (&key, &value) in parameters {
        let parameter = match key {
            100 => P::CompressionLevel(value),
            101 => P::WindowLog(value as u32),
            102 => P::HashLog(value as u32),
            103 => P::ChainLog(value as u32),
            104 => P::SearchLog(value as u32),
            105 => P::MinMatch(value as u32),
            106 => P::TargetLength(value as u32),
            107 if value == 0 => continue,
            107 => P::Strategy(zstd_strategy(value)?),
            200 => P::ContentSizeFlag(value != 0),
            201 => P::ChecksumFlag(value != 0),
            202 => P::DictIdFlag(value != 0),
            400 => P::NbWorkers(value as u32),
            _ => return Err(NativeError::range_error("Invalid zstd parameter")),
        };
        encoder.set_parameter(parameter).map_err(compression_error)?;
    }
    Ok(encoder)
}

fn zstd_strategy(value: i32) -> Result<zstd::zstd_safe::Strategy, NativeError> {
    use zstd::zstd_safe::Strategy as S;
    Ok(match value {
        1 => S::ZSTD_fast, 2 => S::ZSTD_dfast, 3 => S::ZSTD_greedy,
        4 => S::ZSTD_lazy, 5 => S::ZSTD_lazy2, 6 => S::ZSTD_btlazy2,
        7 => S::ZSTD_btopt, 8 => S::ZSTD_btultra, 9 => S::ZSTD_btultra2,
        _ => return Err(NativeError::range_error("Invalid zstd strategy")),
    })
}

pub fn compress(bytes: &[u8], format: &str, level: i32, parameters: Option<&str>) -> Result<Vec<u8>, NativeError> {
    Codec::new(format, false, level, parameters)?.push(bytes, true)
}

pub fn decompress_limited(bytes: &[u8], format: &str, limit: usize) -> Result<Vec<u8>, NativeError> {
    if format == "zstd" {
        let mut output = Vec::new();
        let mut decoder = bun_zstd::StreamingDecoder::new().map_err(|e| compression_error(format!("{e:?}")))?;
        decoder.decompress(bytes, &mut output, limit.saturating_add(1), true)
            .map_err(|e| compression_error(format!("{e:?}")))?;
        return check_limit(output, limit);
    }
    let reader: Box<dyn Read + '_> = match format {
        "brotli" => Box::new(brotli::Decompressor::new(bytes, 4096)),
        "raw" => Box::new(flate2::read::DeflateDecoder::new(bytes)),
        "zlib" => Box::new(flate2::read::ZlibDecoder::new(bytes)),
        "gzip" => Box::new(flate2::read::MultiGzDecoder::new(bytes)),
        _ => return Err(NativeError::type_error("Unsupported compression format")),
    };
    let mut output = Vec::new();
    reader.take(limit as u64 + 1).read_to_end(&mut output)
        .map_err(|e| NativeError::error(e.to_string()).prop("code", "Z_DATA_ERROR").prop("errno", -3))?;
    check_limit(output, limit)
}

fn check_limit(output: Vec<u8>, limit: usize) -> Result<Vec<u8>, NativeError> {
    if output.len() > limit {
        return Err(NativeError::range_error(format!("Cannot create a Buffer larger than {limit} bytes"))
            .prop("code", "ERR_BUFFER_TOO_LARGE"));
    }
    Ok(output)
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
        let codec = Codec::new(a.str(0)?, a.bool(1), a.opt_num(2).unwrap_or(-1.0) as i32, a.opt_str(3))?;
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
