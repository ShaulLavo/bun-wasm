//! Native codecs behind node:zlib, Bun's compression functions, the Web
//! CompressionStream/DecompressionStream and Bun.Archive.
//!
//! [`Handle`] ports one Node/Bun native zlib, Brotli or Zstd handle (Bun's
//! `src/runtime/node/zlib/Native{Zlib,Brotli,Zstd}.rs`, Node's `node_zlib.cc`):
//! each [`Handle::write`] makes one codec call into an output buffer the caller
//! sizes, and reports the input and output space left. node:zlib's JavaScript
//! decides from those whether to call again, so output is produced in bounded
//! pieces and only as the consumer asks for it.
//!
//! [`WebCoder`] ports Bun's `src/runtime/webcore/CompressionStreamCoder.rs`: one
//! step returns at most the stream's high-water mark of output (or the chunk's own
//! size if larger) and keeps the rest of the chunk for the next step.

use std::ffi::CStr;
use std::ptr;

use crate::zlib_ffi as z;
use bun_brotli_sys::brotli_c as br;
use bun_zstd::c as zs;
// Links the Zstd C library that `bun_zstd` declares.
use zstd_sys as _;

use crate::data::NativeError;

pub fn too_large(limit: usize) -> NativeError {
    NativeError::range_error(format!("Cannot create a Buffer larger than {limit} bytes"))
        .prop("code", "ERR_BUFFER_TOO_LARGE")
}

pub fn trailing_junk() -> NativeError {
    NativeError::type_error("Trailing junk found after the end of the compressed stream")
        .prop("code", "ERR_TRAILING_JUNK_AFTER_STREAM_END")
}

pub fn out_of_memory() -> NativeError {
    NativeError::range_error("Out of memory")
}

/// Node's `CompressionError`, thrown by `zlibOnError` as a plain Error.
fn codec_error(message: impl Into<String>, code: impl Into<String>, errno: i32) -> NativeError {
    NativeError::error(message)
        .prop("errno", errno)
        .prop("code", code.into())
}

fn init_failed(message: &str) -> NativeError {
    NativeError::error(message).prop("code", "ERR_ZLIB_INITIALIZATION_FAILED")
}

/// Grows `output` by `size` zeroed bytes without aborting when memory runs out.
fn grow(output: &mut Vec<u8>, size: usize) -> Result<(), NativeError> {
    output.try_reserve(size).map_err(|_| out_of_memory())?;
    output.resize(output.len() + size, 0);
    Ok(())
}

/// Node's `node_zlib_mode`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
    DeflateRaw,
    InflateRaw,
    Unzip,
    BrotliEncode,
    BrotliDecode,
    ZstdCompress,
    ZstdDecompress,
}

impl Mode {
    pub fn parse(name: &str) -> Result<Self, NativeError> {
        Ok(match name {
            "deflate" => Self::Deflate,
            "inflate" => Self::Inflate,
            "gzip" => Self::Gzip,
            "gunzip" => Self::Gunzip,
            "deflateRaw" => Self::DeflateRaw,
            "inflateRaw" => Self::InflateRaw,
            "unzip" => Self::Unzip,
            "brotliEncode" => Self::BrotliEncode,
            "brotliDecode" => Self::BrotliDecode,
            "zstdCompress" => Self::ZstdCompress,
            "zstdDecompress" => Self::ZstdDecompress,
            _ => {
                return Err(NativeError::type_error(format!(
                    "Unsupported compression mode {name}"
                )));
            }
        })
    }

    /// `Z_FINISH`, `BROTLI_OPERATION_FINISH` or `ZSTD_e_end`.
    pub fn finish_flush(self) -> i32 {
        match self {
            Self::BrotliEncode | Self::BrotliDecode | Self::ZstdCompress | Self::ZstdDecompress => {
                2
            }
            _ => z::Z_FINISH,
        }
    }
}

/// The arguments of Node's `handle.init()`, already validated by node:zlib.
pub struct Options<'a> {
    pub level: i32,
    pub window_bits: i32,
    pub mem_level: i32,
    pub strategy: i32,
    /// Brotli or Zstd `(parameter, value)` pairs, in key order.
    pub params: Vec<(u32, u32)>,
    pub dictionary: &'a [u8],
    /// Node's `rejectGarbageAfterEnd`: input after the end of the stream is an
    /// error, and gzip members and Zstd frames do not continue.
    pub reject_garbage: bool,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Self {
            level: -1,
            window_bits: 15,
            mem_level: 8,
            strategy: 0,
            params: Vec::new(),
            dictionary: &[],
            reject_garbage: false,
        }
    }
}

impl<'a> Options<'a> {
    /// Reads the JSON object node:zlib passes: `level`, `windowBits`, `memLevel`,
    /// `strategy` and `params` (`{ key: value }`).
    pub fn parse(json: Option<&str>, dictionary: &'a [u8]) -> Result<Self, NativeError> {
        let mut options = Self {
            dictionary,
            ..Self::default()
        };
        let Some(json) = json else { return Ok(options) };
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| NativeError::type_error(e.to_string()))?;
        let int = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .map(|n| n as i32)
        };
        options.level = int("level").unwrap_or(options.level);
        options.window_bits = int("windowBits").unwrap_or(options.window_bits);
        options.mem_level = int("memLevel").unwrap_or(options.mem_level);
        options.strategy = int("strategy").unwrap_or(options.strategy);
        options.reject_garbage = value
            .get("rejectGarbageAfterEnd")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if let Some(params) = value.get("params").and_then(serde_json::Value::as_object) {
            for (key, value) in params {
                let key = key
                    .parse::<u32>()
                    .map_err(|_| NativeError::type_error("Invalid parameter"))?;
                let value = match value {
                    serde_json::Value::Bool(flag) => u32::from(*flag),
                    other => other.as_f64().unwrap_or(0.0) as i64 as u32,
                };
                options.params.push((key, value));
            }
            options.params.sort_unstable();
        }
        Ok(options)
    }
}

unsafe extern "C" fn zlib_alloc(_: z::voidpf, items: z::uInt, size: z::uInt) -> z::voidpf {
    unsafe { libc::calloc(items as usize, size as usize) }
}
unsafe extern "C" fn zlib_free(_: z::voidpf, address: z::voidpf) {
    unsafe { libc::free(address) }
}

fn new_stream() -> Box<z::z_stream> {
    Box::new(z::z_stream {
        next_in: ptr::null_mut(),
        avail_in: 0,
        total_in: 0,
        next_out: ptr::null_mut(),
        avail_out: 0,
        total_out: 0,
        msg: ptr::null_mut(),
        state: ptr::null_mut(),
        zalloc: zlib_alloc,
        zfree: zlib_free,
        opaque: ptr::null_mut(),
        data_type: 0,
        adler: 0,
        reserved: 0,
    })
}

fn zlib_code(status: i32) -> &'static str {
    match status {
        z::Z_OK => "Z_OK",
        z::Z_STREAM_END => "Z_STREAM_END",
        z::Z_NEED_DICT => "Z_NEED_DICT",
        z::Z_ERRNO => "Z_ERRNO",
        z::Z_STREAM_ERROR => "Z_STREAM_ERROR",
        z::Z_DATA_ERROR => "Z_DATA_ERROR",
        z::Z_MEM_ERROR => "Z_MEM_ERROR",
        z::Z_BUF_ERROR => "Z_BUF_ERROR",
        z::Z_VERSION_ERROR => "Z_VERSION_ERROR",
        _ => "Z_UNKNOWN_ERROR",
    }
}

/// Bun's `NativeZlib` context.
struct Zlib {
    stream: Box<z::z_stream>,
    mode: Mode,
    /// Copied at init: node:zlib may be handed a buffer the caller later changes.
    dictionary: Vec<u8>,
    gzip_id_bytes_read: u8,
    err: i32,
    flush: i32,
    reject_garbage: bool,
}

impl Drop for Zlib {
    fn drop(&mut self) {
        // SAFETY: the stream was initialized by the matching *Init2_ call in `new`.
        unsafe {
            match self.mode {
                Mode::Deflate | Mode::Gzip | Mode::DeflateRaw => z::deflateEnd(&mut *self.stream),
                _ => z::inflateEnd(&mut *self.stream),
            };
        }
    }
}

impl Zlib {
    const GZIP_HEADER_ID1: u8 = 0x1f;
    const GZIP_HEADER_ID2: u8 = 0x8b;

    fn new(mode: Mode, options: &Options) -> Result<Self, NativeError> {
        let window_bits = match mode {
            Mode::Gzip | Mode::Gunzip => options.window_bits + 16,
            Mode::Unzip => options.window_bits + 32,
            Mode::DeflateRaw | Mode::InflateRaw => -options.window_bits,
            _ => options.window_bits,
        };
        let mut stream = new_stream();
        // SAFETY: zlibVersion returns a static C string.
        let version = unsafe { z::zlibVersion() };
        let size = size_of::<z::z_stream>() as i32;
        // SAFETY: `stream` is a boxed, fully initialized z_stream with valid allocators.
        let status = unsafe {
            match mode {
                Mode::Deflate | Mode::Gzip | Mode::DeflateRaw => z::deflateInit2_(
                    &mut *stream,
                    options.level,
                    z::Z_DEFLATED,
                    window_bits,
                    options.mem_level,
                    options.strategy,
                    version,
                    size,
                ),
                _ => z::inflateInit2_(&mut *stream, window_bits, version, size),
            }
        };
        if status != z::Z_OK {
            return Err(init_failed("Initialization failed"));
        }
        let mut zlib = Self {
            stream,
            mode,
            dictionary: options.dictionary.to_vec(),
            gzip_id_bytes_read: 0,
            err: z::Z_OK,
            flush: z::Z_NO_FLUSH,
            reject_garbage: options.reject_garbage,
        };
        zlib.set_dictionary()
            .map_err(|_| init_failed("Initialization failed"))?;
        Ok(zlib)
    }

    fn error_for_message(&self, fallback: &str) -> NativeError {
        let message = if self.stream.msg.is_null() {
            fallback.to_owned()
        } else {
            // SAFETY: zlib's `msg` is a static C string.
            unsafe { CStr::from_ptr(self.stream.msg) }
                .to_string_lossy()
                .into_owned()
        };
        codec_error(message, zlib_code(self.err), self.err)
    }

    fn set_dictionary(&mut self) -> Result<(), NativeError> {
        if self.dictionary.is_empty() {
            return Ok(());
        }
        let (data, size) = (self.dictionary.as_ptr(), self.dictionary.len() as u32);
        // SAFETY: the stream is initialized; `data` borrows the owned dictionary.
        self.err = unsafe {
            match self.mode {
                Mode::Deflate | Mode::DeflateRaw => {
                    z::deflateSetDictionary(&mut *self.stream, data, size)
                }
                Mode::InflateRaw => z::inflateSetDictionary(&mut *self.stream, data, size),
                _ => z::Z_OK,
            }
        };
        if self.err != z::Z_OK {
            return Err(self.error_for_message("Failed to set dictionary"));
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), NativeError> {
        // SAFETY: the stream is initialized for this mode.
        self.err = unsafe {
            match self.mode {
                Mode::Deflate | Mode::Gzip | Mode::DeflateRaw => z::deflateReset(&mut *self.stream),
                Mode::Inflate | Mode::Gunzip | Mode::InflateRaw => {
                    z::inflateReset(&mut *self.stream)
                }
                _ => z::Z_OK,
            }
        };
        if self.err != z::Z_OK {
            return Err(self.error_for_message("Failed to reset stream"));
        }
        self.set_dictionary()
    }

    fn inflate(&mut self) -> Result<(), NativeError> {
        // SAFETY: the stream is initialized and its buffers were set by `write`.
        self.err = unsafe { z::inflate(&mut *self.stream, self.flush) };
        if self.mode != Mode::InflateRaw
            && self.err == z::Z_NEED_DICT
            && !self.dictionary.is_empty()
        {
            let (data, size) = (self.dictionary.as_ptr(), self.dictionary.len() as u32);
            // SAFETY: as above; `data` borrows the owned dictionary.
            self.err = unsafe { z::inflateSetDictionary(&mut *self.stream, data, size) };
            if self.err == z::Z_OK {
                // SAFETY: as above.
                self.err = unsafe { z::inflate(&mut *self.stream, self.flush) };
            } else if self.err == z::Z_DATA_ERROR {
                // inflateSetDictionary and inflate both report Z_DATA_ERROR; this
                // one means the dictionary was wrong.
                self.err = z::Z_NEED_DICT;
            }
        }
        // More bytes after a gzip member are another member or trailing junk.
        // Trailing zero bytes are padding.
        while self.stream.avail_in > 0
            && self.mode == Mode::Gunzip
            && !self.reject_garbage
            && self.err == z::Z_STREAM_END
            // SAFETY: avail_in > 0, so next_in points at a readable byte.
            && unsafe { *self.stream.next_in } != 0
        {
            self.reset()?;
            // SAFETY: as above.
            self.err = unsafe { z::inflate(&mut *self.stream, self.flush) };
        }
        Ok(())
    }

    /// Node's UNZIP becomes GUNZIP once both gzip magic bytes are seen, else INFLATE.
    fn detect_gzip(&mut self) {
        let available = self.stream.avail_in as usize;
        let mut index = 0;
        while self.mode == Mode::Unzip && index < available {
            // SAFETY: index < avail_in.
            let byte = unsafe { *self.stream.next_in.add(index) };
            let expected = if self.gzip_id_bytes_read == 0 {
                Self::GZIP_HEADER_ID1
            } else {
                Self::GZIP_HEADER_ID2
            };
            if byte != expected {
                self.mode = Mode::Inflate;
            } else {
                self.gzip_id_bytes_read += 1;
                if self.gzip_id_bytes_read == 2 {
                    self.mode = Mode::Gunzip;
                }
            }
            index += 1;
        }
    }

    fn write(
        &mut self,
        input: &[u8],
        flush: i32,
        output: &mut [u8],
    ) -> Result<(usize, usize), NativeError> {
        if !(0..=6).contains(&flush) {
            return Err(NativeError::type_error("Invalid flush value"));
        }
        self.flush = flush;
        self.stream.next_in = input.as_ptr().cast_mut();
        self.stream.avail_in =
            u32::try_from(input.len()).map_err(|_| too_large(u32::MAX as usize))?;
        self.stream.next_out = output.as_mut_ptr();
        self.stream.avail_out =
            u32::try_from(output.len()).map_err(|_| too_large(u32::MAX as usize))?;
        match self.mode {
            Mode::Deflate | Mode::Gzip | Mode::DeflateRaw => {
                // SAFETY: the stream is initialized and its buffers borrow `input`/`output`.
                self.err = unsafe { z::deflate(&mut *self.stream, flush) };
            }
            _ => {
                if self.mode == Mode::Unzip {
                    self.detect_gzip();
                }
                self.inflate()?;
            }
        }
        let left = (
            self.stream.avail_in as usize,
            self.stream.avail_out as usize,
        );
        self.stream.next_in = ptr::null_mut();
        self.stream.next_out = ptr::null_mut();
        match self.err {
            z::Z_OK | z::Z_BUF_ERROR if left.1 != 0 && flush == z::Z_FINISH => {
                Err(self.error_for_message("unexpected end of file"))
            }
            z::Z_OK | z::Z_BUF_ERROR | z::Z_STREAM_END => Ok(left),
            z::Z_NEED_DICT if self.dictionary.is_empty() => {
                Err(self.error_for_message("Missing dictionary"))
            }
            z::Z_NEED_DICT => Err(self.error_for_message("Bad dictionary")),
            _ => Err(self.error_for_message("Zlib error")),
        }
    }
}

/// Bun's `NativeBrotli` context.
struct Brotli {
    encoder: *mut br::BrotliEncoder,
    decoder: *mut br::BrotliDecoder,
    prepared: *mut br::BrotliEncoderPreparedDictionary,
    /// Brotli borrows the dictionary for the life of the coder.
    dictionary: Vec<u8>,
}

impl Drop for Brotli {
    fn drop(&mut self) {
        // SAFETY: each pointer is null or owned by this coder; the coder goes
        // before the prepared dictionary it borrows.
        unsafe {
            if !self.encoder.is_null() {
                br::BrotliEncoderDestroyInstance(self.encoder);
            }
            if !self.decoder.is_null() {
                br::BrotliDecoderDestroyInstance(self.decoder);
            }
            if !self.prepared.is_null() {
                br::BrotliEncoderDestroyPreparedDictionary(self.prepared);
            }
        }
    }
}

impl Brotli {
    fn new(decode: bool, options: &Options) -> Result<Self, NativeError> {
        let mut brotli = Self {
            encoder: ptr::null_mut(),
            decoder: ptr::null_mut(),
            prepared: ptr::null_mut(),
            dictionary: options.dictionary.to_vec(),
        };
        let (data, size) = (brotli.dictionary.as_ptr(), brotli.dictionary.len());
        if decode {
            // SAFETY: FFI with the default allocator.
            brotli.decoder =
                unsafe { br::BrotliDecoderCreateInstance(None, None, ptr::null_mut()) };
            // SAFETY: non-null decoders are exclusively owned here.
            let decoder = unsafe { brotli.decoder.as_mut() }
                .ok_or_else(|| init_failed("Initialization failed"))?;
            for &(key, value) in &options.params {
                if br::BrotliDecoderSetParameter(decoder, key, value) == 0 {
                    return Err(init_failed("Initialization failed"));
                }
            }
            // SAFETY: the decoder is live and the dictionary outlives it.
            if size > 0
                && unsafe { br::BrotliDecoderAttachDictionary(brotli.decoder, 0, size, data) } == 0
            {
                return Err(init_failed("Initialization failed"));
            }
            return Ok(brotli);
        }
        // SAFETY: FFI with the default allocator.
        brotli.encoder = unsafe { br::BrotliEncoderCreateInstance(None, None, ptr::null_mut()) };
        // SAFETY: non-null encoders are exclusively owned here.
        let encoder = unsafe { brotli.encoder.as_mut() }
            .ok_or_else(|| init_failed("Initialization failed"))?;
        for &(key, value) in &options.params {
            if br::BrotliEncoderSetParameter(encoder, key, value) == 0 {
                return Err(init_failed("Initialization failed"));
            }
        }
        if size > 0 {
            // SAFETY: FFI; `data` stays valid while the prepared dictionary lives.
            brotli.prepared = unsafe {
                br::BrotliEncoderPrepareDictionary(
                    0,
                    size,
                    data,
                    br::BROTLI_MAX_QUALITY,
                    None,
                    None,
                    ptr::null_mut(),
                )
            };
            // SAFETY: both pointers are live and owned by this coder.
            if brotli.prepared.is_null()
                || unsafe {
                    br::BrotliEncoderAttachPreparedDictionary(brotli.encoder, brotli.prepared)
                } == 0
            {
                return Err(init_failed("Initialization failed"));
            }
        }
        Ok(brotli)
    }

    fn write(
        &mut self,
        input: &[u8],
        flush: i32,
        output: &mut [u8],
    ) -> Result<(usize, usize), NativeError> {
        let mut available_in = input.len();
        let mut next_in = input.as_ptr();
        let mut available_out = output.len();
        let mut next_out = output.as_mut_ptr();
        if !self.encoder.is_null() {
            let operation = match flush {
                0 => br::BrotliEncoderOperation::process,
                1 => br::BrotliEncoderOperation::flush,
                2 => br::BrotliEncoderOperation::finish,
                3 => br::BrotliEncoderOperation::emit_metadata,
                _ => return Err(NativeError::type_error("Invalid flush value")),
            };
            // SAFETY: the encoder is live; the pointers borrow `input`/`output`.
            let ok = unsafe {
                br::BrotliEncoderCompressStream(
                    self.encoder,
                    operation,
                    &mut available_in,
                    &mut next_in,
                    &mut available_out,
                    &mut next_out,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(codec_error(
                    "Compression failed",
                    "ERR_BROTLI_COMPRESSION_FAILED",
                    -1,
                ));
            }
            return Ok((available_in, available_out));
        }
        if !(0..=3).contains(&flush) {
            return Err(NativeError::type_error("Invalid flush value"));
        }
        // SAFETY: the decoder is live; the pointers borrow `input`/`output`.
        let result = unsafe {
            br::BrotliDecoderDecompressStream(
                self.decoder,
                &mut available_in,
                &mut next_in,
                &mut available_out,
                &mut next_out,
                ptr::null_mut(),
            )
        };
        if result == br::BrotliDecoderResult::err {
            // SAFETY: the decoder is live.
            let code = br::BrotliDecoderGetErrorCode(unsafe { &*self.decoder });
            // SAFETY: Brotli's error strings are static C strings.
            let name =
                unsafe { CStr::from_ptr(br::BrotliDecoderErrorString(code)) }.to_string_lossy();
            return Err(codec_error(
                "Decompression failed",
                format!("ERR_{name}"),
                code as i32,
            ));
        }
        if flush == 2 && result == br::BrotliDecoderResult::needs_more_input {
            return Err(codec_error(
                "unexpected end of file",
                "Z_BUF_ERROR",
                z::Z_BUF_ERROR,
            ));
        }
        Ok((available_in, available_out))
    }
}

fn zstd_code_name(code: u32) -> &'static str {
    match code {
        0 => "ZSTD_error_no_error",
        10 => "ZSTD_error_prefix_unknown",
        12 => "ZSTD_error_version_unsupported",
        14 => "ZSTD_error_frameParameter_unsupported",
        16 => "ZSTD_error_frameParameter_windowTooLarge",
        20 => "ZSTD_error_corruption_detected",
        22 => "ZSTD_error_checksum_wrong",
        24 => "ZSTD_error_literals_headerWrong",
        30 => "ZSTD_error_dictionary_corrupted",
        32 => "ZSTD_error_dictionary_wrong",
        34 => "ZSTD_error_dictionaryCreation_failed",
        40 => "ZSTD_error_parameter_unsupported",
        41 => "ZSTD_error_parameter_combination_unsupported",
        42 => "ZSTD_error_parameter_outOfBound",
        44 => "ZSTD_error_tableLog_tooLarge",
        46 => "ZSTD_error_maxSymbolValue_tooLarge",
        48 => "ZSTD_error_maxSymbolValue_tooSmall",
        50 => "ZSTD_error_stabilityCondition_notRespected",
        60 => "ZSTD_error_stage_wrong",
        62 => "ZSTD_error_init_missing",
        64 => "ZSTD_error_memory_allocation",
        66 => "ZSTD_error_workSpace_tooSmall",
        70 => "ZSTD_error_dstSize_tooSmall",
        72 => "ZSTD_error_srcSize_wrong",
        74 => "ZSTD_error_dstBuffer_null",
        80 => "ZSTD_error_noForwardProgress_destFull",
        82 => "ZSTD_error_noForwardProgress_inputEmpty",
        _ => "ZSTD_error_GENERIC",
    }
}

fn zstd_check(result: usize) -> Result<usize, NativeError> {
    if zs::ZSTD_isError(result) == 0 {
        return Ok(result);
    }
    let code = zs::ZSTD_getErrorCode(result);
    // SAFETY: Zstd's error strings are static C strings.
    let message = unsafe { CStr::from_ptr(zs::ZSTD_getErrorString(code)) }.to_string_lossy();
    Err(codec_error(
        message.into_owned(),
        zstd_code_name(code as u32),
        code as i32,
    ))
}

const ZSTD_MAGIC: [u8; 4] = 0xFD2F_B528u32.to_le_bytes();
const ZSTD_MAGIC_SKIPPABLE: [u8; 3] = [0x2A, 0x4D, 0x18];

/// True when `head` (1..=4 bytes) is a prefix of a Zstd or skippable frame magic.
fn is_zstd_frame_prefix(head: &[u8]) -> bool {
    head.iter().zip(ZSTD_MAGIC).all(|(a, b)| *a == b)
        || ((head[0] & 0xF0) == 0x50
            && head[1..]
                .iter()
                .zip(ZSTD_MAGIC_SKIPPABLE)
                .all(|(a, b)| *a == b))
}

/// Bun's `NativeZstd` context.
struct Zstd {
    encoder: *mut zs::ZSTD_CCtx,
    decoder: *mut zs::ZSTD_DStream,
    /// Decoder: the input so far ends on a frame boundary.
    frame_done: bool,
    reject_garbage: bool,
}

impl Drop for Zstd {
    fn drop(&mut self) {
        // SAFETY: each pointer is null or owned by this coder.
        unsafe {
            if !self.encoder.is_null() {
                zs::ZSTD_freeCCtx(self.encoder);
            }
            if !self.decoder.is_null() {
                zs::ZSTD_freeDCtx(self.decoder);
            }
        }
    }
}

impl Zstd {
    fn new(decode: bool, options: &Options) -> Result<Self, NativeError> {
        let mut zstd = Self {
            encoder: ptr::null_mut(),
            decoder: ptr::null_mut(),
            frame_done: false,
            reject_garbage: options.reject_garbage,
        };
        let (data, size) = (options.dictionary.as_ptr().cast(), options.dictionary.len());
        let load = |result: usize| {
            if zs::ZSTD_isError(result) != 0 {
                return Err(NativeError::error("Failed to load zstd dictionary")
                    .prop("code", "ERR_ZLIB_DICTIONARY_LOAD_FAILED"));
            }
            Ok(())
        };
        let set = |result: usize| {
            if zs::ZSTD_isError(result) != 0 {
                return Err(NativeError::error("Setting parameter failed")
                    .prop("code", "ERR_ZSTD_PARAM_SET_FAILED"));
            }
            Ok(())
        };
        if decode {
            zstd.decoder = zs::ZSTD_createDCtx();
            if zstd.decoder.is_null() {
                return Err(init_failed("Could not initialize zstd instance"));
            }
            // SAFETY: the context is live; Zstd copies the dictionary.
            if size > 0 {
                load(unsafe { zs::ZSTD_DCtx_loadDictionary(zstd.decoder, data, size) })?;
            }
            for &(key, value) in &options.params {
                // SAFETY: the context is live.
                set(unsafe { zs::ZSTD_DCtx_setParameter(zstd.decoder, key, value as i32) })?;
            }
            return Ok(zstd);
        }
        zstd.encoder = zs::ZSTD_createCCtx();
        if zstd.encoder.is_null() {
            return Err(init_failed("Could not initialize zstd instance"));
        }
        // SAFETY: the context is live; Zstd copies the dictionary.
        if size > 0 {
            load(unsafe { zs::ZSTD_CCtx_loadDictionary(zstd.encoder, data, size) })?;
        }
        for &(key, value) in &options.params {
            // SAFETY: the context is live.
            set(unsafe { zs::ZSTD_CCtx_setParameter(zstd.encoder, key, value as i32) })?;
        }
        Ok(zstd)
    }

    fn write(
        &mut self,
        input: &[u8],
        flush: i32,
        output: &mut [u8],
    ) -> Result<(usize, usize), NativeError> {
        if !(0..=2).contains(&flush) {
            return Err(NativeError::type_error("Invalid flush value"));
        }
        let mut source = zs::ZSTD_inBuffer {
            src: input.as_ptr().cast(),
            size: input.len(),
            pos: 0,
        };
        let mut sink = zs::ZSTD_outBuffer {
            dst: output.as_mut_ptr().cast(),
            size: output.len(),
            pos: 0,
        };
        if !self.encoder.is_null() {
            // SAFETY: the context is live; the buffers borrow `input`/`output`.
            zstd_check(unsafe {
                zs::ZSTD_compressStream2(self.encoder, &mut sink, &mut source, flush as u32)
            })?;
            return Ok((input.len() - source.pos, output.len() - sink.pos));
        }
        let mut remaining;
        loop {
            let consumed = source.pos;
            // SAFETY: as above.
            remaining = zstd_check(unsafe {
                zs::ZSTD_decompressStream(self.decoder, &mut sink, &mut source)
            })?;
            if remaining == 0 {
                self.frame_done = true;
            } else if source.pos > consumed {
                self.frame_done = false;
            }
            // A finished frame may be followed by another one (RFC 8878 §3.1).
            let next = &input[source.pos..input.len().min(source.pos + 4)];
            if remaining != 0
                || sink.pos == sink.size
                || next.is_empty()
                || self.reject_garbage
                || !is_zstd_frame_prefix(next)
            {
                break;
            }
        }
        // Zstd reports an unfinished frame only through its size hint; Node
        // calls input that ends inside a frame an unexpected end of file.
        if flush == 2
            && remaining != 0
            && !self.frame_done
            && source.pos == source.size
            && sink.pos < sink.size
        {
            return Err(codec_error(
                "unexpected end of file",
                "Z_BUF_ERROR",
                z::Z_BUF_ERROR,
            ));
        }
        Ok((input.len() - source.pos, output.len() - sink.pos))
    }
}

enum Backend {
    Zlib(Zlib),
    Brotli(Brotli),
    Zstd(Zstd),
}

/// One node:zlib native handle.
pub struct Handle {
    backend: Backend,
}

impl Handle {
    pub fn new(mode: Mode, options: &Options) -> Result<Self, NativeError> {
        let backend = match mode {
            Mode::BrotliEncode | Mode::BrotliDecode => {
                Backend::Brotli(Brotli::new(mode == Mode::BrotliDecode, options)?)
            }
            Mode::ZstdCompress | Mode::ZstdDecompress => {
                Backend::Zstd(Zstd::new(mode == Mode::ZstdDecompress, options)?)
            }
            _ => Backend::Zlib(Zlib::new(mode, options)?),
        };
        Ok(Self { backend })
    }

    /// One codec call. Returns the input and output bytes left over, Node's
    /// `[availInAfter, availOutAfter]` write state.
    pub fn write(
        &mut self,
        input: &[u8],
        flush: i32,
        output: &mut [u8],
    ) -> Result<(usize, usize), NativeError> {
        match &mut self.backend {
            Backend::Zlib(codec) => codec.write(input, flush, output),
            Backend::Brotli(codec) => codec.write(input, flush, output),
            Backend::Zstd(codec) => codec.write(input, flush, output),
        }
    }

    /// node:zlib's `params(level, strategy)`, after the caller's sync flush.
    pub fn params(&mut self, level: i32, strategy: i32) -> Result<(), NativeError> {
        let Backend::Zlib(codec) = &mut self.backend else {
            return Ok(());
        };
        if !matches!(codec.mode, Mode::Deflate | Mode::DeflateRaw) {
            return Ok(());
        }
        let mut empty = [0u8; 0];
        codec.stream.next_in = ptr::null_mut();
        codec.stream.avail_in = 0;
        codec.stream.next_out = empty.as_mut_ptr();
        codec.stream.avail_out = 0;
        // SAFETY: the stream is an initialized deflate stream with empty buffers.
        codec.err = unsafe { z::deflateParams(&mut *codec.stream, level, strategy) };
        codec.stream.next_out = ptr::null_mut();
        if codec.err != z::Z_OK && codec.err != z::Z_BUF_ERROR {
            return Err(codec.error_for_message("Failed to set parameters"));
        }
        Ok(())
    }
}

/// Node's `processChunkSync`: runs one chunk through a fresh handle with
/// `chunk`-sized output buffers and throws `ERR_BUFFER_TOO_LARGE` as soon as
/// the output passes `limit`, so a small hostile input never expands further.
pub fn convert(
    mode: Mode,
    options: &Options,
    input: &[u8],
    flush: i32,
    chunk: usize,
    limit: usize,
) -> Result<Vec<u8>, NativeError> {
    let mut handle = Handle::new(mode, options)?;
    let chunk = chunk.max(1);
    let mut output = Vec::new();
    let mut input = input;
    loop {
        let start = output.len();
        grow(&mut output, chunk)?;
        let (available_in, available_out) = handle.write(input, flush, &mut output[start..])?;
        output.truncate(start + chunk - available_out);
        if output.len() > limit {
            return Err(too_large(limit));
        }
        input = &input[input.len() - available_in..];
        if available_out != 0 {
            if options.reject_garbage && !input.is_empty() {
                return Err(trailing_junk());
            }
            output.shrink_to_fit();
            return Ok(output);
        }
    }
}

/// Bun's Web stream formats (`Bun::WebStreams::CompressionFormat`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WebFormat {
    Deflate,
    DeflateRaw,
    Gzip,
    Brotli,
    Zstd,
}

impl WebFormat {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "deflate" => Self::Deflate,
            "deflate-raw" => Self::DeflateRaw,
            "gzip" => Self::Gzip,
            "brotli" => Self::Brotli,
            "zstd" => Self::Zstd,
            _ => return None,
        })
    }

    fn window_bits(self) -> i32 {
        match self {
            Self::Deflate => 15,
            Self::DeflateRaw => -15,
            _ => 15 + 16,
        }
    }
}

/// Growth granularity of a Web step's output buffer.
const WEB_CHUNK: usize = 16 * 1024;

/// Room for one codec call: grows `out` by up to [`WEB_CHUNK`], clamped to `cap`.
fn web_spare(out: &mut Vec<u8>, cap: usize) -> Result<usize, NativeError> {
    let start = out.len();
    grow(out, (cap - start).min(WEB_CHUNK))?;
    Ok(start)
}

fn web_error(message: &str) -> NativeError {
    NativeError::type_error(message)
}

/// The rest of a chunk (or flush) whose last step stopped at the output cap.
/// Copied, not borrowed: user code runs between steps and may detach the chunk.
struct Pending {
    input: Vec<u8>,
    pos: usize,
    finish: bool,
    /// Per-step output bound, fixed by the chunk's first step.
    cap: usize,
}

enum Progress {
    Done,
    /// Stopped at the output cap; `consumed` bytes of this step's input are used up.
    More {
        consumed: usize,
    },
}

enum WebBackend {
    Deflate(Box<z::z_stream>),
    Inflate {
        stream: Box<z::z_stream>,
        gzip: bool,
    },
    BrotliEncode(*mut br::BrotliEncoder),
    BrotliDecode(*mut br::BrotliDecoder),
    ZstdEncode(*mut zs::ZSTD_CCtx),
    ZstdDecode(*mut zs::ZSTD_DStream),
}

/// Bun's `CompressionStreamCoder`.
pub struct WebCoder {
    backend: WebBackend,
    /// DecompressionStream only: the codec has reported end-of-stream. Any
    /// further input is trailing junk.
    ended: bool,
    /// Zstd decode only: bytes of a split frame magic carried across chunks.
    zstd_head: [u8; 4],
    zstd_head_len: u8,
    high_water_mark: usize,
    pending: Option<Pending>,
}

impl Drop for WebCoder {
    fn drop(&mut self) {
        // SAFETY: each handle was created by `new` and is freed exactly once here.
        unsafe {
            match &mut self.backend {
                WebBackend::Deflate(stream) => {
                    z::deflateEnd(&mut **stream);
                }
                WebBackend::Inflate { stream, .. } => {
                    z::inflateEnd(&mut **stream);
                }
                WebBackend::BrotliEncode(p) => br::BrotliEncoderDestroyInstance(*p),
                WebBackend::BrotliDecode(p) => br::BrotliDecoderDestroyInstance(*p),
                WebBackend::ZstdEncode(p) => {
                    zs::ZSTD_freeCCtx(*p);
                }
                WebBackend::ZstdDecode(p) => {
                    zs::ZSTD_freeDCtx(*p);
                }
            }
        }
    }
}

impl WebCoder {
    /// `level` is range-checked by the caller and ignored for decompression.
    pub fn new(
        format: WebFormat,
        decompress: bool,
        high_water_mark: usize,
        level: Option<i32>,
    ) -> Result<Self, NativeError> {
        let level = level.filter(|_| !decompress);
        // SAFETY: zlibVersion returns a static C string.
        let version = unsafe { z::zlibVersion() };
        let size = size_of::<z::z_stream>() as i32;
        let backend = match (format, decompress) {
            (WebFormat::Brotli, false) => {
                // SAFETY: FFI with the default allocator.
                let p = unsafe { br::BrotliEncoderCreateInstance(None, None, ptr::null_mut()) };
                // SAFETY: non-null encoders are exclusively owned here.
                let encoder = unsafe { p.as_mut() }
                    .ok_or_else(|| web_error("failed to initialize brotli encoder"))?;
                if let Some(quality) = level
                    && br::BrotliEncoderSetParameter(
                        encoder,
                        br::BROTLI_PARAM_QUALITY,
                        quality as u32,
                    ) == 0
                {
                    // SAFETY: `p` is not stored anywhere else.
                    unsafe { br::BrotliEncoderDestroyInstance(p) };
                    return Err(web_error("failed to set brotli quality"));
                }
                WebBackend::BrotliEncode(p)
            }
            (WebFormat::Brotli, true) => {
                // SAFETY: FFI with the default allocator.
                let p = unsafe { br::BrotliDecoderCreateInstance(None, None, ptr::null_mut()) };
                if p.is_null() {
                    return Err(web_error("failed to initialize brotli decoder"));
                }
                WebBackend::BrotliDecode(p)
            }
            (WebFormat::Zstd, false) => {
                let p = zs::ZSTD_createCCtx();
                if p.is_null() {
                    return Err(web_error("failed to initialize zstd encoder"));
                }
                if let Some(level) = level {
                    // SAFETY: `p` is a live context.
                    let result = unsafe {
                        zs::ZSTD_CCtx_setParameter(p, zs::ZSTD_c_compressionLevel, level)
                    };
                    if zs::ZSTD_isError(result) != 0 {
                        // SAFETY: `p` is not stored anywhere else.
                        unsafe { zs::ZSTD_freeCCtx(p) };
                        return Err(web_error("failed to set zstd level"));
                    }
                }
                WebBackend::ZstdEncode(p)
            }
            (WebFormat::Zstd, true) => {
                let p = zs::ZSTD_createDCtx();
                if p.is_null() {
                    return Err(web_error("failed to initialize zstd decoder"));
                }
                WebBackend::ZstdDecode(p)
            }
            (_, false) => {
                let mut stream = new_stream();
                // SAFETY: a boxed, initialized z_stream.
                let rc = unsafe {
                    z::deflateInit2_(
                        &mut *stream,
                        level.unwrap_or(-1),
                        z::Z_DEFLATED,
                        format.window_bits(),
                        8,
                        0,
                        version,
                        size,
                    )
                };
                if rc != z::Z_OK {
                    return Err(web_error("failed to initialize deflate"));
                }
                WebBackend::Deflate(stream)
            }
            (_, true) => {
                let mut stream = new_stream();
                // SAFETY: a boxed, initialized z_stream.
                let rc =
                    unsafe { z::inflateInit2_(&mut *stream, format.window_bits(), version, size) };
                if rc != z::Z_OK {
                    return Err(web_error("failed to initialize inflate"));
                }
                WebBackend::Inflate {
                    stream,
                    gzip: format == WebFormat::Gzip,
                }
            }
        };
        Ok(Self {
            backend,
            ended: false,
            zstd_head: [0; 4],
            zstd_head_len: 0,
            high_water_mark: high_water_mark.max(1),
            pending: None,
        })
    }

    /// One step of the chunk (or, with `finish`, the final flush): returns at most
    /// `max(high_water_mark, chunk length)` bytes and whether the coder stopped at
    /// that cap, in which case the caller steps again with no input before
    /// feeding the next chunk.
    pub fn step(&mut self, input: &[u8], finish: bool) -> Result<(Vec<u8>, bool), NativeError> {
        let mut out = Vec::new();
        if let Some(mut pending) = self.pending.take() {
            let rest = std::mem::take(&mut pending.input);
            return match self.run(
                &rest[pending.pos..],
                pending.finish,
                true,
                pending.cap,
                &mut out,
            )? {
                Progress::Done => Ok((out, false)),
                Progress::More { consumed } => {
                    pending.pos += consumed;
                    pending.input = rest;
                    self.pending = Some(pending);
                    Ok((out, true))
                }
            };
        }
        // Zstd decode: re-attach the frame magic the previous chunk ended inside of.
        let joined;
        let bytes: &[u8] = if self.zstd_head_len > 0 {
            joined = [&self.zstd_head[..self.zstd_head_len as usize], input].concat();
            self.zstd_head_len = 0;
            &joined
        } else {
            input
        };
        let cap = self.high_water_mark.max(input.len());
        match self.run(bytes, finish, false, cap, &mut out)? {
            Progress::Done => Ok((out, false)),
            Progress::More { consumed } => {
                self.pending = Some(Pending {
                    input: bytes[consumed..].to_vec(),
                    pos: 0,
                    finish,
                    cap,
                });
                Ok((out, true))
            }
        }
    }

    /// Drives the codec until the chunk is done or `out` holds `cap` bytes. A
    /// continuing step (not the chunk's first) calls the codec even with no input
    /// left, to drain the output it is holding.
    fn run(
        &mut self,
        input: &[u8],
        finish: bool,
        continuing: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        match &mut self.backend {
            WebBackend::Deflate(stream) => Self::deflate(stream, input, finish, cap, out),
            WebBackend::Inflate { stream, gzip } => Self::inflate(
                stream,
                *gzip,
                &mut self.ended,
                input,
                finish,
                continuing,
                cap,
                out,
            ),
            WebBackend::BrotliEncode(p) => Self::brotli_encode(*p, input, finish, cap, out),
            WebBackend::BrotliDecode(p) => {
                Self::brotli_decode(*p, &mut self.ended, input, finish, cap, out)
            }
            WebBackend::ZstdEncode(p) => Self::zstd_encode(*p, input, finish, cap, out),
            WebBackend::ZstdDecode(p) => {
                let head = (&mut self.zstd_head, &mut self.zstd_head_len);
                Self::zstd_decode(*p, &mut self.ended, head, input, finish, cap, out)
            }
        }
    }

    fn deflate(
        s: &mut z::z_stream,
        input: &[u8],
        finish: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        let mut remaining = input;
        loop {
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: input.len() - remaining.len(),
                });
            }
            let take = remaining.len().min(u32::MAX as usize);
            let tail = remaining.len() > take;
            let flush = if finish && !tail {
                z::Z_FINISH
            } else {
                z::Z_NO_FLUSH
            };
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            s.next_in = remaining.as_ptr().cast_mut();
            s.avail_in = take as u32;
            s.next_out = out[start..].as_mut_ptr();
            s.avail_out = room as u32;
            // SAFETY: the stream is initialized; its buffers borrow `remaining`/`out`.
            let rc = unsafe { z::deflate(s, flush) };
            out.truncate(start + room - s.avail_out as usize);
            let consumed = take - s.avail_in as usize;
            let avail_out = s.avail_out;
            s.next_in = ptr::null_mut();
            s.next_out = ptr::null_mut();
            remaining = &remaining[consumed..];
            match rc {
                z::Z_OK | z::Z_BUF_ERROR => {}
                z::Z_STREAM_END => return Ok(Progress::Done),
                z::Z_MEM_ERROR => return Err(out_of_memory()),
                _ => return Err(web_error("deflate failed")),
            }
            if avail_out != 0 && remaining.is_empty() {
                return Ok(Progress::Done);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn inflate(
        s: &mut z::z_stream,
        gzip: bool,
        ended: &mut bool,
        input: &[u8],
        finish: bool,
        continuing: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        if !continuing {
            // `ended` means the last inflate returned StreamEnd, a member
            // boundary. For gzip a following chunk starts the next member; for
            // deflate it is trailing junk.
            if *ended && !input.is_empty() {
                if !gzip {
                    return Err(trailing_junk());
                }
                // SAFETY: the stream is initialized.
                if unsafe { z::inflateReset(s) } != z::Z_OK {
                    return Err(web_error("inflate failed"));
                }
                *ended = false;
            }
            if input.is_empty() && (*ended || !finish) {
                return Ok(Progress::Done);
            }
        }
        let mut remaining = input;
        loop {
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: input.len() - remaining.len(),
                });
            }
            let take = remaining.len().min(u32::MAX as usize);
            let tail = remaining.len() > take;
            let flush = if finish && !tail {
                z::Z_FINISH
            } else {
                z::Z_NO_FLUSH
            };
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            s.next_in = remaining.as_ptr().cast_mut();
            s.avail_in = take as u32;
            s.next_out = out[start..].as_mut_ptr();
            s.avail_out = room as u32;
            // SAFETY: the stream is initialized; its buffers borrow `remaining`/`out`.
            let rc = unsafe { z::inflate(s, flush) };
            out.truncate(start + room - s.avail_out as usize);
            let consumed = take - s.avail_in as usize;
            let avail_out = s.avail_out;
            s.next_in = ptr::null_mut();
            s.next_out = ptr::null_mut();
            remaining = &remaining[consumed..];
            match rc {
                z::Z_OK => {}
                z::Z_BUF_ERROR => {
                    if finish && !tail {
                        return Err(web_error("unexpected end of file"));
                    }
                }
                z::Z_STREAM_END => {
                    *ended = true;
                    if remaining.is_empty() {
                        return Ok(Progress::Done);
                    }
                    if !gzip {
                        return Err(trailing_junk());
                    }
                    // SAFETY: the stream is initialized.
                    if unsafe { z::inflateReset(s) } != z::Z_OK {
                        return Err(web_error("inflate failed"));
                    }
                    *ended = false;
                    continue;
                }
                z::Z_NEED_DICT => return Err(web_error("Missing dictionary")),
                z::Z_MEM_ERROR => return Err(out_of_memory()),
                _ => return Err(web_error("inflate failed")),
            }
            if avail_out != 0 && remaining.is_empty() {
                if finish && !*ended {
                    return Err(web_error("unexpected end of file"));
                }
                return Ok(Progress::Done);
            }
        }
    }

    fn brotli_encode(
        p: *mut br::BrotliEncoder,
        input: &[u8],
        finish: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        let op = if finish {
            br::BrotliEncoderOperation::finish
        } else {
            br::BrotliEncoderOperation::process
        };
        let mut next_in = input.as_ptr();
        let mut avail_in = input.len();
        loop {
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: input.len() - avail_in,
                });
            }
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            let mut next_out = out[start..].as_mut_ptr();
            let mut avail_out = room;
            // SAFETY: the encoder is live; the pointers borrow `input`/`out`.
            let ok = unsafe {
                br::BrotliEncoderCompressStream(
                    p,
                    op,
                    &mut avail_in,
                    &mut next_in,
                    &mut avail_out,
                    &mut next_out,
                    ptr::null_mut(),
                )
            };
            out.truncate(start + room - avail_out);
            if ok == 0 {
                return Err(web_error("brotli encode failed"));
            }
            if avail_in == 0 && avail_out != 0 {
                return Ok(Progress::Done);
            }
        }
    }

    fn brotli_decode(
        p: *mut br::BrotliDecoder,
        ended: &mut bool,
        input: &[u8],
        finish: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        if *ended {
            if !input.is_empty() {
                return Err(trailing_junk());
            }
            return Ok(Progress::Done);
        }
        let mut next_in = input.as_ptr();
        let mut avail_in = input.len();
        loop {
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: input.len() - avail_in,
                });
            }
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            let mut next_out = out[start..].as_mut_ptr();
            let mut avail_out = room;
            // SAFETY: the decoder is live; the pointers borrow `input`/`out`.
            let result = unsafe {
                br::BrotliDecoderDecompressStream(
                    p,
                    &mut avail_in,
                    &mut next_in,
                    &mut avail_out,
                    &mut next_out,
                    ptr::null_mut(),
                )
            };
            let written = room - avail_out;
            out.truncate(start + written);
            match result {
                br::BrotliDecoderResult::success => {
                    *ended = true;
                    if avail_in != 0 {
                        return Err(trailing_junk());
                    }
                    return Ok(Progress::Done);
                }
                br::BrotliDecoderResult::needs_more_input => {
                    // Brotli reports needs_more_input even with output left in its ring buffer.
                    // SAFETY: the decoder is live.
                    if written > 0 && br::BrotliDecoderHasMoreOutput(unsafe { &*p }) != 0 {
                        continue;
                    }
                    if finish {
                        return Err(web_error("unexpected end of file"));
                    }
                    return Ok(Progress::Done);
                }
                br::BrotliDecoderResult::needs_more_output => {}
                br::BrotliDecoderResult::err => {
                    // SAFETY: the decoder is live.
                    let code = br::BrotliDecoderGetErrorCode(unsafe { &*p });
                    if code.is_alloc_failure() {
                        return Err(out_of_memory());
                    }
                    // SAFETY: Brotli's error strings are static C strings.
                    let detail = unsafe { CStr::from_ptr(br::BrotliDecoderErrorString(code)) }
                        .to_string_lossy();
                    return Err(web_error("brotli decode failed")
                        .prop("code", format!("ERR_{detail}"))
                        .prop("detail", detail.into_owned()));
                }
            }
        }
    }

    fn zstd_error(result: usize, message: &str) -> NativeError {
        if zs::ZSTD_getErrorCode(result) == zs::ZSTD_error_memory_allocation {
            return out_of_memory();
        }
        web_error(message)
    }

    fn zstd_encode(
        p: *mut zs::ZSTD_CCtx,
        input: &[u8],
        finish: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        let end = if finish { 2 } else { 0 };
        let mut source = zs::ZSTD_inBuffer {
            src: input.as_ptr().cast(),
            size: input.len(),
            pos: 0,
        };
        loop {
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: source.pos,
                });
            }
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            let mut sink = zs::ZSTD_outBuffer {
                dst: out[start..].as_mut_ptr().cast(),
                size: room,
                pos: 0,
            };
            // SAFETY: the context is live; the buffers borrow `input`/`out`.
            let remaining = unsafe { zs::ZSTD_compressStream2(p, &mut sink, &mut source, end) };
            out.truncate(start + sink.pos);
            if zs::ZSTD_isError(remaining) != 0 {
                return Err(Self::zstd_error(remaining, "zstd encode failed"));
            }
            if source.pos == source.size && (!finish || remaining == 0) {
                return Ok(Progress::Done);
            }
        }
    }

    fn zstd_decode(
        p: *mut zs::ZSTD_DStream,
        ended: &mut bool,
        (zstd_head, zstd_head_len): (&mut [u8; 4], &mut u8),
        input: &[u8],
        finish: bool,
        cap: usize,
        out: &mut Vec<u8>,
    ) -> Result<Progress, NativeError> {
        let mut source = zs::ZSTD_inBuffer {
            src: input.as_ptr().cast(),
            size: input.len(),
            pos: 0,
        };
        loop {
            if *ended {
                let rest = &input[source.pos..];
                if rest.is_empty() {
                    return Ok(Progress::Done);
                }
                let head = &rest[..rest.len().min(4)];
                if !is_zstd_frame_prefix(head) {
                    return Err(trailing_junk());
                }
                if head.len() < 4 {
                    if finish {
                        return Err(trailing_junk());
                    }
                    zstd_head[..head.len()].copy_from_slice(head);
                    *zstd_head_len = head.len() as u8;
                    return Ok(Progress::Done);
                }
                // SAFETY: the context is live.
                unsafe { zs::ZSTD_DCtx_reset(p, zs::ZSTD_reset_session_and_parameters) };
                *ended = false;
            }
            if out.len() >= cap {
                return Ok(Progress::More {
                    consumed: source.pos,
                });
            }
            let start = web_spare(out, cap)?;
            let room = out.len() - start;
            let mut sink = zs::ZSTD_outBuffer {
                dst: out[start..].as_mut_ptr().cast(),
                size: room,
                pos: 0,
            };
            // SAFETY: the context is live; the buffers borrow `input`/`out`.
            let remaining = unsafe { zs::ZSTD_decompressStream(p, &mut sink, &mut source) };
            out.truncate(start + sink.pos);
            if zs::ZSTD_isError(remaining) != 0 {
                return Err(Self::zstd_error(remaining, "zstd decode failed"));
            }
            if remaining == 0 {
                *ended = true;
                continue;
            }
            if source.pos == source.size && sink.pos < sink.size {
                if finish {
                    return Err(web_error("unexpected end of file"));
                }
                return Ok(Progress::Done);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    thread_local! {
        // Only the measuring thread counts, so parallel tests do not interfere.
        static TRACK: Cell<bool> = const { Cell::new(false) };
    }
    static LARGEST: AtomicUsize = AtomicUsize::new(0);
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    static SERIAL: Mutex<()> = Mutex::new(());
    fn tracking() -> bool {
        TRACK.try_with(Cell::get).unwrap_or(false)
    }

    struct Allocator;
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator;
    fn record(size: usize) {
        if tracking() {
            LARGEST.fetch_max(size, Ordering::Relaxed);
            let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
    }
    fn forget(size: usize) {
        if tracking() {
            LIVE.store(
                LIVE.load(Ordering::Relaxed).saturating_sub(size),
                Ordering::Relaxed,
            );
        }
    }
    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
            forget(layout.size());
            unsafe { System.dealloc(p, layout) }
        }
        unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            forget(layout.size());
            record(size);
            unsafe { System.realloc(p, layout, size) }
        }
    }

    /// Runs `f` with Rust allocations tracked; returns (largest single, peak live).
    pub(crate) fn measure<T>(f: impl FnOnce() -> T) -> (T, usize, usize) {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        LARGEST.store(0, Ordering::Relaxed);
        LIVE.store(0, Ordering::Relaxed);
        PEAK.store(0, Ordering::Relaxed);
        TRACK.with(|track| track.set(true));
        let value = f();
        TRACK.with(|track| track.set(false));
        (
            value,
            LARGEST.load(Ordering::Relaxed),
            PEAK.load(Ordering::Relaxed),
        )
    }

    const EXPANDED: usize = 4 * 1024 * 1024;
    const MODES: [(Mode, Mode); 5] = [
        (Mode::Gzip, Mode::Gunzip),
        (Mode::Deflate, Mode::Inflate),
        (Mode::DeflateRaw, Mode::InflateRaw),
        (Mode::BrotliEncode, Mode::BrotliDecode),
        (Mode::ZstdCompress, Mode::ZstdDecompress),
    ];

    fn bomb(mode: Mode) -> Vec<u8> {
        convert(
            mode,
            &Options::default(),
            &vec![0; EXPANDED],
            mode.finish_flush(),
            16384,
            usize::MAX,
        )
        .unwrap()
    }

    #[test]
    fn sync_limit_stops_expansion_after_one_piece() {
        for (encode, decode) in MODES {
            let compressed = bomb(encode);
            let (result, largest, _) = measure(|| {
                convert(
                    decode,
                    &Options::default(),
                    &compressed,
                    decode.finish_flush(),
                    16384,
                    1024,
                )
            });
            let error = result.expect_err("limit");
            assert_eq!(
                error.message, "Cannot create a Buffer larger than 1024 bytes",
                "{decode:?}"
            );
            assert!(
                largest <= 64 * 1024 + 16384,
                "{decode:?} allocated {largest} bytes before the limit"
            );
        }
    }

    #[test]
    fn handle_writes_bounded_pieces() {
        for (encode, decode) in MODES {
            let compressed = bomb(encode);
            let mut handle = Handle::new(decode, &Options::default()).unwrap();
            let mut input = compressed.as_slice();
            let mut total = 0;
            let mut output = vec![0; 1024];
            let (_, largest, peak) = measure(|| {
                loop {
                    let (available_in, available_out) =
                        handle.write(input, 0, &mut output).unwrap();
                    total += 1024 - available_out;
                    input = &input[input.len() - available_in..];
                    if available_out != 0 {
                        break;
                    }
                }
            });
            assert_eq!(total, EXPANDED, "{decode:?}");
            // The decoder's own window is the only large allocation.
            assert!(
                largest <= 4 * 1024 * 1024 && peak <= 4 * 1024 * 1024,
                "{decode:?}: {largest} {peak}"
            );
        }
    }

    #[test]
    fn web_steps_are_capped_by_the_high_water_mark() {
        for (format, encode) in [
            (WebFormat::Gzip, Mode::Gzip),
            (WebFormat::Deflate, Mode::Deflate),
            (WebFormat::DeflateRaw, Mode::DeflateRaw),
            (WebFormat::Brotli, Mode::BrotliEncode),
            (WebFormat::Zstd, Mode::ZstdCompress),
        ] {
            let compressed = bomb(encode);
            let mut coder = WebCoder::new(format, true, 1024, None).unwrap();
            let (mut piece, mut more) = coder.step(&compressed, false).unwrap();
            let mut total = piece.len();
            let cap = 1024.max(compressed.len());
            while more {
                assert!(piece.len() <= cap && piece.capacity() <= cap + WEB_CHUNK);
                (piece, more) = coder.step(&[], false).unwrap();
                total += piece.len();
            }
            assert_eq!(total, EXPANDED);
            let (rest, more) = coder.step(&[], true).unwrap();
            assert!(rest.is_empty() && !more);
        }
    }

    #[test]
    fn corrupt_input_keeps_node_error_codes() {
        let code = |e: &NativeError| {
            e.props
                .iter()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| format!("{v:?}"))
        };
        for (decode, expected) in [
            (Mode::Gunzip, "Z_DATA_ERROR"),
            (Mode::Inflate, "Z_DATA_ERROR"),
            (Mode::InflateRaw, "Z_DATA_ERROR"),
            (Mode::BrotliDecode, "ERR__ERROR_FORMAT_PADDING_2"),
            (Mode::ZstdDecompress, "ZSTD_error_prefix_unknown"),
        ] {
            let error = convert(
                decode,
                &Options::default(),
                &[255; 5],
                decode.finish_flush(),
                64,
                usize::MAX,
            )
            .unwrap_err();
            assert!(
                code(&error).unwrap().contains(expected),
                "{decode:?}: {:?}",
                code(&error)
            );
            let error = convert(
                decode,
                &Options::default(),
                &[],
                decode.finish_flush(),
                64,
                usize::MAX,
            )
            .unwrap_err();
            assert_eq!(error.message, "unexpected end of file", "{decode:?}");
        }
    }
}
