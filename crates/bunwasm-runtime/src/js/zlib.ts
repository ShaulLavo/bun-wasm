(function (internal: BunWasm.Internal) {
  "use strict";
  // node:zlib, ported from Node's lib/zlib.js (the same code Bun's
  // src/js/node/zlib.ts uses). The native handle (compression.rs) makes one
  // codec call per write into a chunkSize buffer; this file decides when to call
  // again, exactly as Node does: on read demand for streams, and with a
  // maxOutputLength check after every piece for the convenience functions.
  const native = internal.native;
  const { Buffer, kMaxLength = 0x7fffffff } = internal.require("buffer");

  type Callback = (error?: unknown, result?: unknown) => void;
  type ZlibOptions = {
    flush?: number; finishFlush?: number; chunkSize?: number; windowBits?: number; level?: number;
    memLevel?: number; strategy?: number; dictionary?: unknown; info?: boolean; maxOutputLength?: number;
    params?: Record<string, unknown>; rejectGarbageAfterEnd?: boolean; encoding?: unknown; objectMode?: unknown;
    writableObjectMode?: unknown;
  };

  const constants = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3,
    Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, ZLIB_VERNUM: 4880, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4,
    DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_DECOMPRESS: 11,
    ZSTD_COMPRESS: 10, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
    Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1,
    BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0,
    BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2, BROTLI_MIN_WINDOW_BITS: 10,
    BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30, BROTLI_DEFAULT_WINDOW: 22,
    BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24,
    BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6,
    BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0,
    BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
    BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1,
    BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1, BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5, BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
    BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7, BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
    BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11, BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
    BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13, BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15, BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
    BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19, BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21, BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27, BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
    BROTLI_DECODER_ERROR_UNREACHABLE: -31, ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_fast: 1,
    ZSTD_dfast: 2, ZSTD_greedy: 3, ZSTD_lazy: 4, ZSTD_lazy2: 5, ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8,
    ZSTD_btultra2: 9, ZSTD_c_compressionLevel: 100, ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102,
    ZSTD_c_chainLog: 103, ZSTD_c_searchLog: 104, ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106,
    ZSTD_c_strategy: 107, ZSTD_c_enableLongDistanceMatching: 160, ZSTD_c_ldmHashLog: 161,
    ZSTD_c_ldmMinMatch: 162, ZSTD_c_ldmBucketSizeLog: 163, ZSTD_c_ldmHashRateLog: 164,
    ZSTD_c_contentSizeFlag: 200, ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202, ZSTD_c_nbWorkers: 400,
    ZSTD_c_jobSize: 401, ZSTD_c_overlapLog: 402, ZSTD_d_windowLogMax: 100, ZSTD_CLEVEL_DEFAULT: 3,
    ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1, ZSTD_error_prefix_unknown: 10,
    ZSTD_error_version_unsupported: 12, ZSTD_error_frameParameter_unsupported: 14,
    ZSTD_error_frameParameter_windowTooLarge: 16, ZSTD_error_corruption_detected: 20,
    ZSTD_error_checksum_wrong: 22, ZSTD_error_literals_headerWrong: 24, ZSTD_error_dictionary_corrupted: 30,
    ZSTD_error_dictionary_wrong: 32, ZSTD_error_dictionaryCreation_failed: 34,
    ZSTD_error_parameter_unsupported: 40, ZSTD_error_parameter_combination_unsupported: 41,
    ZSTD_error_parameter_outOfBound: 42, ZSTD_error_tableLog_tooLarge: 44,
    ZSTD_error_maxSymbolValue_tooLarge: 46, ZSTD_error_maxSymbolValue_tooSmall: 48,
    ZSTD_error_stabilityCondition_notRespected: 50, ZSTD_error_stage_wrong: 60, ZSTD_error_init_missing: 62,
    ZSTD_error_memory_allocation: 64, ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70,
    ZSTD_error_srcSize_wrong: 72, ZSTD_error_dstBuffer_null: 74, ZSTD_error_noForwardProgress_destFull: 80,
    ZSTD_error_noForwardProgress_inputEmpty: 82,
  } as const;
  Object.freeze(constants);
  const {
    Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH, Z_MIN_CHUNK, Z_MIN_WINDOWBITS,
    Z_MAX_WINDOWBITS, Z_MIN_LEVEL, Z_MAX_LEVEL, Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_CHUNK,
    Z_DEFAULT_COMPRESSION, Z_DEFAULT_STRATEGY, Z_DEFAULT_WINDOWBITS, Z_DEFAULT_MEMLEVEL, Z_FIXED, DEFLATE,
    DEFLATERAW, INFLATE, INFLATERAW, GZIP, GUNZIP, UNZIP, BROTLI_DECODE, BROTLI_ENCODE, ZSTD_COMPRESS,
    ZSTD_DECOMPRESS, BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_FLUSH, BROTLI_OPERATION_FINISH,
    BROTLI_OPERATION_EMIT_METADATA, ZSTD_e_continue, ZSTD_e_flush, ZSTD_e_end,
  } = constants;
  const modeNames: Record<number, string> = {
    [DEFLATE]: "deflate", [INFLATE]: "inflate", [GZIP]: "gzip", [GUNZIP]: "gunzip", [DEFLATERAW]: "deflateRaw",
    [INFLATERAW]: "inflateRaw", [UNZIP]: "unzip", [BROTLI_DECODE]: "brotliDecode", [BROTLI_ENCODE]: "brotliEncode",
    [ZSTD_COMPRESS]: "zstdCompress", [ZSTD_DECOMPRESS]: "zstdDecompress",
  };

  const codes: Record<string | number, string | number> = {
    Z_OK: constants.Z_OK, Z_STREAM_END: constants.Z_STREAM_END, Z_NEED_DICT: constants.Z_NEED_DICT,
    Z_ERRNO: constants.Z_ERRNO, Z_STREAM_ERROR: constants.Z_STREAM_ERROR, Z_DATA_ERROR: constants.Z_DATA_ERROR,
    Z_MEM_ERROR: constants.Z_MEM_ERROR, Z_BUF_ERROR: constants.Z_BUF_ERROR, Z_VERSION_ERROR: constants.Z_VERSION_ERROR,
  };
  for (const key of Object.keys(codes)) codes[codes[key]] = key;

  function nodeError<T extends Error>(error: T, code: string): T {
    return Object.assign(error, { code });
  }
  function invalidArgType(name: string, expected: string, value: unknown) {
    const kind = name.includes(".") || name.includes("[") ? "property" : "argument";
    return nodeError(new TypeError(`The "${name}" ${kind} must be ${expected}. Received ${internal.describe(value)}`), "ERR_INVALID_ARG_TYPE");
  }
  function received(value: number) {
    if (!Number.isInteger(value) || Math.abs(value) <= 2 ** 32) return String(value);
    let text = String(value);
    let grouped = "";
    let end = text.length;
    const start = text[0] === "-" ? 1 : 0;
    for (; end >= start + 4; end -= 3) grouped = `_${text.slice(end - 3, end)}${grouped}`;
    return `${text.slice(0, end)}${grouped}`;
  }
  function outOfRange(name: string, range: string, value: number) {
    return nodeError(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${received(value)}`), "ERR_OUT_OF_RANGE");
  }
  function bufferTooLarge(limit: number) {
    return nodeError(new RangeError(`Cannot create a Buffer larger than ${limit} bytes`), "ERR_BUFFER_TOO_LARGE");
  }
  function trailingJunk() {
    return nodeError(new Error("Trailing junk found after the end of the compressed stream"), "ERR_TRAILING_JUNK_AFTER_STREAM_END");
  }

  // internal/validators
  function validateFiniteNumber(number: unknown, name: string): number is number {
    if (number === undefined) return false;
    if (Number.isFinite(number)) return true;
    if (Number.isNaN(number)) return false;
    if (typeof number !== "number") throw invalidArgType(name, "of type number", number);
    throw outOfRange(name, "a finite number", number);
  }
  function checkRangesOrGetDefault(number: unknown, name: string, lower: number, upper: number, fallback: number): number {
    if (!validateFiniteNumber(number, name)) return fallback;
    if (number < lower || number > upper) throw outOfRange(name, `>= ${lower} and <= ${upper}`, number);
    return number;
  }

  const isArrayBufferView = ArrayBuffer.isView;
  function isAnyArrayBuffer(value: unknown): value is ArrayBuffer {
    return value instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer);
  }
  function bytesOf(view: ArrayBufferView | ArrayBuffer): Uint8Array {
    return internal.toUint8(view);
  }
  function toBuffer(bytes: Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // The native handle: Node's binding.Zlib / BrotliEncoder / ZstdCompress shape.
  type WriteState = Uint32Array;
  class Handle {
    id: number | undefined;
    owner!: ZlibBase;
    buffer: Uint8Array | null = null;
    cb: Callback | null = null;
    availOutBefore = 0;
    availInBefore = 0;
    inOff = 0;
    flushFlag = 0;
    output: Uint8Array | null = null;
    #mode: number;
    #options: object;
    #dictionary: Uint8Array | undefined;
    #state: WriteState;
    constructor(mode: number, options: object, dictionary: Uint8Array | undefined, state: WriteState) {
      this.#mode = mode;
      this.#options = options;
      this.#dictionary = dictionary;
      this.#state = state;
      this.id = native.streams.codec(modeNames[mode], JSON.stringify(options), dictionary);
      finalizers.register(this, this.id, this);
    }
    #run(flush: number, input: Uint8Array, inOff: number, inLen: number, outLen: number) {
      if (this.id === undefined) throw new Error("zlib binding closed");
      const { bytes, availIn } = native.streams.write(this.id, input.subarray(inOff, inOff + inLen), flush, outLen);
      this.output = bytes;
      this.#state[0] = outLen - bytes.byteLength;
      this.#state[1] = availIn;
    }
    // A failed codec call ends the stream like Node's zlibOnError.
    #fail(error: unknown) {
      const owner = this.owner;
      const failure = error instanceof Error && "errno" in error
        ? Object.assign(new Error(error.message), { errno: (error as { errno: unknown }).errno, code: (error as { code?: unknown }).code })
        : error;
      owner.destroy(failure);
      owner[kError] = failure;
    }
    writeSync(flush: number, input: Uint8Array, inOff: number, inLen: number, outLen: number) {
      try { this.#run(flush, input, inOff, inLen, outLen); }
      catch (error) { this.#fail(error); }
    }
    write(flush: number, input: Uint8Array, inOff: number, inLen: number, outLen: number) {
      setImmediate(() => {
        if (this.id === undefined) { processCallback.call(this); return; }
        try { this.#run(flush, input, inOff, inLen, outLen); }
        catch (error) { this.#fail(error); return; }
        processCallback.call(this);
      });
    }
    params(level: number, strategy: number) {
      if (this.id !== undefined) native.streams.params(this.id, level, strategy);
    }
    reset() {
      if (this.id === undefined) throw new Error("zlib binding closed");
      this.close();
      // Node's ResetStream keeps a zlib dictionary; Brotli and Zstd start over.
      const keep = this.#mode !== BROTLI_DECODE && this.#mode !== BROTLI_ENCODE && this.#mode !== ZSTD_COMPRESS && this.#mode !== ZSTD_DECOMPRESS;
      this.id = native.streams.codec(modeNames[this.#mode], JSON.stringify(keep ? this.#options : {}), keep ? this.#dictionary : undefined);
      finalizers.register(this, this.id, this);
    }
    close() {
      if (this.id === undefined) return;
      native.streams.release(this.id);
      finalizers.unregister(this);
      this.id = undefined;
    }
  }
  const finalizers = new FinalizationRegistry<number>(id => native.streams.release(id));

  const kFlushFlag = Symbol("kFlushFlag");
  const kError = Symbol("kError");

  function zlibBuffer(engine: ZlibBase, buffer: unknown, callback: unknown) {
    if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    if (isArrayBufferView(buffer) && !(buffer instanceof Uint8Array)) buffer = toBuffer(bytesOf(buffer));
    else if (isAnyArrayBuffer(buffer)) buffer = Buffer.from(buffer);
    const state = { buffers: null as Uint8Array[] | null, nread: 0 };
    engine.on("data", function (this: ZlibBase, chunk: unknown) {
      const bytes = chunk as Uint8Array;
      if (!state.buffers) state.buffers = [bytes];
      else state.buffers.push(bytes);
      state.nread += bytes.length;
      if (state.nread > this._maxOutputLength) {
        this.close();
        this.removeAllListeners("end");
        (callback as Callback)(bufferTooLarge(this._maxOutputLength));
      }
    });
    engine.on("error", function (this: ZlibBase, error: unknown) {
      this.removeAllListeners("end");
      (callback as Callback)(error);
    });
    engine.on("end", function (this: ZlibBase) {
      const bufs = state.buffers;
      const buf = state.nread === 0 || !bufs ? Buffer.from([]) : bufs.length === 1 ? bufs[0] : toBuffer(internal.concatBytes(bufs));
      this.close();
      if (this._info) (callback as Callback)(null, { buffer: buf, engine: this });
      else (callback as Callback)(null, buf);
    });
    engine.end(buffer);
  }

  function syncInput(buffer: unknown): Uint8Array {
    if (typeof buffer === "string") return Buffer.from(buffer);
    if (isArrayBufferView(buffer)) return bytesOf(buffer);
    if (isAnyArrayBuffer(buffer)) return Buffer.from(buffer);
    throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", buffer);
  }

  function zlibBufferSync(engine: ZlibBase, buffer: unknown) {
    const bytes = syncInput(buffer);
    const output = processChunkSync(engine, bytes, engine._finishFlushFlag);
    if (engine._info) return { buffer: output, engine };
    return output;
  }

  const FLUSH_BOUND = [[Z_NO_FLUSH, Z_BLOCK], [BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_EMIT_METADATA], [ZSTD_e_continue, ZSTD_e_end]];
  type FlushDefaults = { flush: number; finishFlush: number; fullFlush: number };

  // ZlibBase's option handling, shared by the constructors and the one-shot
  // sync functions.
  function baseOptions(opts: ZlibOptions | undefined, mode: number, defaults: FlushDefaults) {
    let chunkSize: number = Z_DEFAULT_CHUNK;
    let maxOutputLength = kMaxLength;
    let { flush, finishFlush } = defaults;
    const flushBoundIdx = mode === BROTLI_ENCODE || mode === BROTLI_DECODE ? 1 : mode === ZSTD_COMPRESS || mode === ZSTD_DECOMPRESS ? 2 : 0;
    if (opts) {
      chunkSize = opts.chunkSize as number;
      if (!validateFiniteNumber(chunkSize, "options.chunkSize")) chunkSize = Z_DEFAULT_CHUNK;
      else if (chunkSize < Z_MIN_CHUNK) throw outOfRange("options.chunkSize", `>= ${Z_MIN_CHUNK}`, chunkSize);
      const [lower, upper] = FLUSH_BOUND[flushBoundIdx];
      flush = checkRangesOrGetDefault(opts.flush, "options.flush", lower, upper, flush);
      finishFlush = checkRangesOrGetDefault(opts.finishFlush, "options.finishFlush", lower, upper, finishFlush);
      maxOutputLength = checkRangesOrGetDefault(opts.maxOutputLength, "options.maxOutputLength", 1, kMaxLength, kMaxLength);
      if (opts.rejectGarbageAfterEnd !== undefined && typeof opts.rejectGarbageAfterEnd !== "boolean") {
        throw invalidArgType("options.rejectGarbageAfterEnd", "of type boolean", opts.rejectGarbageAfterEnd);
      }
    }
    return { chunkSize, maxOutputLength, flush, finishFlush, fullFlush: defaults.fullFlush, flushBoundIdx };
  }

  function zlibDictionary(dictionary: unknown) {
    if (dictionary === undefined) return undefined;
    if (isArrayBufferView(dictionary)) return bytesOf(dictionary).slice();
    if (isAnyArrayBuffer(dictionary)) return new Uint8Array(dictionary).slice();
    throw invalidArgType("options.dictionary", "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", dictionary);
  }

  // Node's Zlib(): validated init arguments.
  function zlibInit(opts: ZlibOptions | undefined, mode: number) {
    let windowBits: number = Z_DEFAULT_WINDOWBITS;
    let level: number = Z_DEFAULT_COMPRESSION;
    let memLevel: number = Z_DEFAULT_MEMLEVEL;
    let strategy: number = Z_DEFAULT_STRATEGY;
    let dictionary: Uint8Array | undefined;
    if (opts) {
      // windowBits 0 asks inflate to use the window size in the stream header.
      if ((opts.windowBits == null || opts.windowBits === 0) && (mode === INFLATE || mode === GUNZIP || mode === UNZIP)) {
        windowBits = 0;
      } else {
        const min = Z_MIN_WINDOWBITS + (mode === GZIP ? 1 : 0);
        windowBits = checkRangesOrGetDefault(opts.windowBits, "options.windowBits", min, Z_MAX_WINDOWBITS, Z_DEFAULT_WINDOWBITS);
      }
      level = checkRangesOrGetDefault(opts.level, "options.level", Z_MIN_LEVEL, Z_MAX_LEVEL, Z_DEFAULT_COMPRESSION);
      memLevel = checkRangesOrGetDefault(opts.memLevel, "options.memLevel", Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_MEMLEVEL);
      strategy = checkRangesOrGetDefault(opts.strategy, "options.strategy", Z_DEFAULT_STRATEGY, Z_FIXED, Z_DEFAULT_STRATEGY);
      dictionary = zlibDictionary(opts.dictionary);
    }
    return { options: { level, windowBits, memLevel, strategy }, dictionary, level, strategy };
  }

  const kMaxBrotliParam = 8;
  const kMaxZstdCParam = 402;
  const kMaxZstdDParam = 100;

  // Node's Brotli()/Zstd() parameter tables: Uint32Array slots, -1 unset.
  function codecParams(opts: ZlibOptions | undefined, maxParam: number, invalid: (key: string) => Error) {
    const slots = new Uint32Array(maxParam + 1).fill(-1 >>> 0);
    if (opts?.params) {
      for (const origKey of Object.keys(opts.params)) {
        const key = +origKey;
        if (Number.isNaN(key) || key < 0 || key > maxParam || (slots[key] | 0) !== -1) throw invalid(origKey);
        const value = opts.params[origKey];
        if (typeof value !== "number" && typeof value !== "boolean") throw invalidArgType("options.params[key]", "of type number", value);
        slots[key] = Number(value);
      }
    }
    const params: Record<number, number> = {};
    slots.forEach((value, key) => { if (value !== 0xffffffff) params[key] = value; });
    return params;
  }

  function brotliInit(opts: ZlibOptions | undefined) {
    const params = codecParams(opts, kMaxBrotliParam, key => nodeError(new RangeError(`${key} is not a valid Brotli parameter`), "ERR_BROTLI_INVALID_PARAM"));
    return { options: { params }, dictionary: zlibDictionary(opts?.dictionary) };
  }

  function zstdInit(opts: ZlibOptions | undefined, mode: number) {
    const max = mode === ZSTD_COMPRESS ? kMaxZstdCParam : kMaxZstdDParam;
    const params = codecParams(opts, max, key => nodeError(new RangeError(`${key} is not a valid zstd parameter`), "ERR_ZSTD_INVALID_PARAM"));
    let dictionary: Uint8Array | undefined;
    const value = opts?.dictionary;
    if (isArrayBufferView(value)) dictionary = bytesOf(value).slice();
    else if (isAnyArrayBuffer(value)) dictionary = new Uint8Array(value).slice();
    return { options: { params }, dictionary };
  }

  const zlibDefaultOpts = { flush: Z_NO_FLUSH, finishFlush: Z_FINISH, fullFlush: Z_FULL_FLUSH };
  const brotliDefaultOpts = { flush: BROTLI_OPERATION_PROCESS, finishFlush: BROTLI_OPERATION_FINISH, fullFlush: BROTLI_OPERATION_FLUSH };
  const zstdDefaultOpts = { flush: ZSTD_e_continue, finishFlush: ZSTD_e_end, fullFlush: ZSTD_e_flush };

  function initFor(mode: number, opts: ZlibOptions | undefined) {
    if (mode === BROTLI_ENCODE || mode === BROTLI_DECODE) return { ...brotliInit(opts), defaults: brotliDefaultOpts, level: undefined, strategy: undefined };
    if (mode === ZSTD_COMPRESS || mode === ZSTD_DECOMPRESS) return { ...zstdInit(opts, mode), defaults: zstdDefaultOpts, level: undefined, strategy: undefined };
    return { ...zlibInit(opts, mode), defaults: zlibDefaultOpts };
  }

  // Set up 'special' zero-length buffers that .flush() writes to carry its flush
  // kind through the write queue.
  const flushiness: number[] = [];
  const kFlushFlagList = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];
  kFlushFlagList.forEach((flag, index) => { flushiness[flag] = index; });
  function maxFlush(a: number, b: number) {
    return flushiness[a] > flushiness[b] ? a : b;
  }
  const kFlushBuffers: Uint8Array[] = [];
  for (const flag of kFlushFlagList) {
    kFlushBuffers[flag] = Object.assign(Buffer.from(new ArrayBuffer(0)), { [kFlushFlag]: flag });
  }

  function processChunkSync(self: ZlibBase, chunk: Uint8Array, flushFlag: number) {
    let availInBefore = chunk.byteLength;
    let availOutBefore = self._chunkSize - self._outOffset;
    let inOff = 0;
    let availOutAfter: number;
    let availInAfter: number;
    const buffers: Uint8Array[] = [];
    let nread = 0;
    let inputRead = 0;
    const state = self._writeState;
    const handle = self._handle;
    let offset = self._outOffset;
    const chunkSize = self._chunkSize;
    let error: unknown;
    self.on("error", (er: unknown) => { error = er; });
    if (!handle) throw new TypeError("Cannot read properties of null (reading 'writeSync')");
    for (;;) {
      handle.writeSync(flushFlag, chunk, inOff, availInBefore, availOutBefore);
      if (error) throw error;
      else if (self[kError]) throw self[kError];
      availOutAfter = state[0];
      availInAfter = state[1];
      const inDelta = availInBefore - availInAfter;
      inputRead += inDelta;
      const have = availOutBefore - availOutAfter;
      if (have > 0) {
        const out = toBuffer(handle.output!);
        offset += have;
        buffers.push(out);
        nread += out.byteLength;
        if (nread > self._maxOutputLength) {
          closeEngine(self);
          throw bufferTooLarge(self._maxOutputLength);
        }
      }
      // Exhausted the output buffer, or used all the input: start a new one.
      if (availOutAfter === 0 || offset >= chunkSize) {
        availOutBefore = chunkSize;
        offset = 0;
      }
      if (availOutAfter === 0) {
        // Not actually done. Reprocess with the input left over.
        inOff += inDelta;
        availInBefore = availInAfter;
      } else {
        break;
      }
    }
    if (availInAfter > 0 && self._rejectGarbageAfterEnd) {
      closeEngine(self);
      throw trailingJunk();
    }
    self.bytesWritten = inputRead;
    closeEngine(self);
    if (nread === 0) return Buffer.from([]);
    return buffers.length === 1 ? buffers[0] : toBuffer(internal.concatBytes(buffers));
  }

  function processChunk(self: ZlibBase, chunk: Uint8Array, flushFlag: number, cb: Callback) {
    const handle = self._handle;
    if (!handle) { internal.nextTick(cb); return; }
    handle.buffer = chunk;
    handle.cb = cb;
    handle.availOutBefore = self._chunkSize - self._outOffset;
    handle.availInBefore = chunk.byteLength;
    handle.inOff = 0;
    handle.flushFlag = flushFlag;
    handle.write(flushFlag, chunk, 0, handle.availInBefore, handle.availOutBefore);
  }

  function processCallback(this: Handle) {
    const handle = this;
    const self = this.owner;
    const state = self._writeState;
    const cb = handle.cb!;
    if (self.destroyed || handle.id === undefined) {
      handle.buffer = null;
      cb();
      return;
    }
    const availOutAfter = state[0];
    const availInAfter = state[1];
    const inDelta = handle.availInBefore - availInAfter;
    self.bytesWritten += inDelta;
    const have = handle.availOutBefore - availOutAfter;
    let streamBufferIsFull = false;
    if (have > 0) {
      const out = toBuffer(handle.output!);
      self._outOffset += have;
      streamBufferIsFull = !self.push(out);
    }
    if (self.destroyed) {
      cb();
      return;
    }
    // Exhausted the output buffer, or used all the input: start a new one.
    if (availOutAfter === 0 || self._outOffset >= self._chunkSize) {
      handle.availOutBefore = self._chunkSize;
      self._outOffset = 0;
    }
    if (availOutAfter === 0) {
      // Not actually done. Reprocess the rest once the consumer has room.
      handle.inOff += inDelta;
      handle.availInBefore = availInAfter;
      const again = () => handle.write(handle.flushFlag, handle.buffer!, handle.inOff, handle.availInBefore, self._chunkSize);
      if (!streamBufferIsFull) {
        again();
      } else {
        const oldRead = self._read;
        self._read = (n: number) => {
          self._read = oldRead;
          again();
          self._read(n);
        };
      }
      return;
    }
    if (availInAfter > 0) {
      // Output space is left but the codec wants no more input: the
      // compressed stream ended early.
      if (self._rejectGarbageAfterEnd) {
        const err = trailingJunk();
        self.destroy(err);
        cb(err);
        return;
      }
      self.push(null);
    }
    // Finished with the chunk.
    handle.buffer = null;
    cb();
  }

  function closeEngine(engine: ZlibBase) {
    engine._handle?.close();
    engine._handle = null;
  }

  let streamClasses: ReturnType<typeof createClasses> | undefined;
  type ZlibBase = InstanceType<ReturnType<typeof createClasses>["ZlibBase"]>;

  function createClasses() {
    const stream = internal.builtin("node:stream") as unknown as {
      Transform: new (options?: object) => BunWasm.CompressionTransform;
      finished(stream: unknown, callback: () => void): void;
    };
    const { Transform, finished } = stream;

    class ZlibBase extends Transform {
      [kError]: unknown = null;
      bytesWritten = 0;
      _handle: Handle | null;
      _outOffset = 0;
      _chunkSize: number;
      _defaultFlushFlag: number;
      _finishFlushFlag: number;
      _defaultFullFlushFlag: number;
      _flushBoundIdx: number;
      _info: boolean | undefined;
      _maxOutputLength: number;
      _rejectGarbageAfterEnd: boolean;
      _writeState = new Uint32Array(2);
      _level: number | undefined;
      _strategy: number | undefined;
      _mode: number;
      constructor(opts: ZlibOptions | undefined, mode: number) {
        const init = initFor(mode, opts);
        const base = baseOptions(opts, mode, init.defaults);
        let streamOptions = opts;
        if (opts && (opts.encoding || opts.objectMode || opts.writableObjectMode)) {
          streamOptions = { ...opts, encoding: null, objectMode: false, writableObjectMode: false };
        }
        super({ autoDestroy: true, ...streamOptions });
        const handle = new Handle(mode, init.options, init.dictionary, this._writeState);
        handle.owner = this;
        this._handle = handle;
        this._chunkSize = base.chunkSize;
        this._defaultFlushFlag = base.flush;
        this._finishFlushFlag = base.finishFlush;
        this._defaultFullFlushFlag = base.fullFlush;
        this._flushBoundIdx = base.flushBoundIdx;
        this._info = opts?.info;
        this._maxOutputLength = base.maxOutputLength;
        this._rejectGarbageAfterEnd = opts?.rejectGarbageAfterEnd === true;
        this._level = init.level;
        this._strategy = init.strategy;
        this._mode = mode;
      }
      get _closed() { return !this._handle; }
      reset() {
        if (!this._handle) throw new Error("zlib binding closed");
        return this._handle.reset();
      }
      _flush(callback: Callback) {
        this._transform(Buffer.from([]), "", callback);
      }
      _final(callback: Callback) {
        callback();
      }
      flush(kind?: number | Callback, callback?: Callback) {
        if (typeof kind === "function" || (kind === undefined && !callback)) {
          callback = kind as Callback | undefined;
          kind = this._defaultFullFlushFlag;
        }
        const [lower, upper] = FLUSH_BOUND[this._flushBoundIdx];
        const flag = checkRangesOrGetDefault(kind, "kind", lower, upper, this._defaultFullFlushFlag);
        if (this.writableFinished) {
          if (callback) internal.nextTick(callback);
        } else if (this.writableEnded) {
          if (callback) this.once("end", callback);
        } else {
          this.write(kFlushBuffers[flag], "", callback);
        }
      }
      close(callback?: Callback) {
        if (callback) finished(this, callback);
        this.destroy();
      }
      _destroy(err: unknown, callback: Callback) {
        closeEngine(this);
        callback(err);
      }
      _transform(chunk: unknown, _encoding: string, cb: Callback) {
        const bytes = chunk as Uint8Array & { [kFlushFlag]?: number };
        let flushFlag = this._defaultFlushFlag;
        // A zero-length flush buffer carries the flush kind from flush().
        if (typeof bytes[kFlushFlag] === "number") flushFlag = bytes[kFlushFlag];
        // The last chunk also gets the finish flush.
        if (this.writableEnded && this.writableLength === bytes.byteLength) {
          flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
        }
        processChunk(this, bytes, flushFlag, cb);
      }
      _processChunk(chunk: Uint8Array, flushFlag: number, cb?: Callback) {
        if (typeof cb === "function") processChunk(this, chunk, flushFlag, cb);
        else return processChunkSync(this, chunk, flushFlag);
      }
    }

    class Zlib extends ZlibBase {
      params(level: number, strategy: number, callback?: Callback) {
        checkRangesOrGetDefault(level, "level", Z_MIN_LEVEL, Z_MAX_LEVEL, Z_DEFAULT_COMPRESSION);
        checkRangesOrGetDefault(strategy, "strategy", Z_DEFAULT_STRATEGY, Z_FIXED, Z_DEFAULT_STRATEGY);
        if (this._level !== level || this._strategy !== strategy) {
          this.flush(Z_SYNC_FLUSH, () => {
            if (!this._handle) throw new Error("zlib binding closed");
            this._handle.params(level, strategy);
            if (!this.destroyed) {
              this._level = level;
              this._strategy = strategy;
              if (callback) callback();
            }
          });
        } else if (callback) {
          internal.nextTick(callback);
        }
      }
    }
    class Deflate extends Zlib { constructor(opts?: ZlibOptions) { super(opts, DEFLATE); } }
    class Inflate extends Zlib { constructor(opts?: ZlibOptions) { super(opts, INFLATE); } }
    class Gzip extends Zlib { constructor(opts?: ZlibOptions) { super(opts, GZIP); } }
    class Gunzip extends Zlib { constructor(opts?: ZlibOptions) { super(opts, GUNZIP); } }
    class DeflateRaw extends Zlib {
      constructor(opts?: ZlibOptions) {
        if (opts && opts.windowBits === 8) opts.windowBits = 9;
        super(opts, DEFLATERAW);
      }
    }
    class InflateRaw extends Zlib { constructor(opts?: ZlibOptions) { super(opts, INFLATERAW); } }
    class Unzip extends Zlib { constructor(opts?: ZlibOptions) { super(opts, UNZIP); } }
    class Brotli extends Zlib {}
    class BrotliCompress extends Brotli { constructor(opts?: ZlibOptions) { super(opts, BROTLI_ENCODE); } }
    class BrotliDecompress extends Brotli { constructor(opts?: ZlibOptions) { super(opts, BROTLI_DECODE); } }
    class Zstd extends ZlibBase {}
    class ZstdCompress extends Zstd { constructor(opts?: ZlibOptions) { super(opts, ZSTD_COMPRESS); } }
    class ZstdDecompress extends Zstd { constructor(opts?: ZlibOptions) { super(opts, ZSTD_DECOMPRESS); } }
    return { ZlibBase, Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip, BrotliCompress, BrotliDecompress, ZstdCompress, ZstdDecompress };
  }
  function classes() {
    return streamClasses ??= createClasses();
  }

  type Ctor = new (opts?: ZlibOptions) => ZlibBase;
  const names = ["Deflate", "Inflate", "Gzip", "Gunzip", "DeflateRaw", "InflateRaw", "Unzip", "BrotliCompress", "BrotliDecompress", "ZstdCompress", "ZstdDecompress"] as const;
  const modes: Record<(typeof names)[number], number> = {
    Deflate: DEFLATE, Inflate: INFLATE, Gzip: GZIP, Gunzip: GUNZIP, DeflateRaw: DEFLATERAW, InflateRaw: INFLATERAW,
    Unzip: UNZIP, BrotliCompress: BROTLI_ENCODE, BrotliDecompress: BROTLI_DECODE, ZstdCompress: ZSTD_COMPRESS,
    ZstdDecompress: ZSTD_DECOMPRESS,
  };

  // zlibBufferSync without a stream object: the same validation, then Node's
  // processChunkSync loop in native code.
  function convertSync(name: (typeof names)[number], buffer: unknown, opts: ZlibOptions | undefined) {
    const mode = modes[name];
    if (opts?.info) return zlibBufferSync(new (classes()[name] as Ctor)(opts), buffer);
    if (name === "DeflateRaw" && opts && opts.windowBits === 8) opts.windowBits = 9;
    const init = initFor(mode, opts);
    const base = baseOptions(opts, mode, init.defaults);
    const bytes = syncInput(buffer);
    const output = native.zlibConvert(bytes, modeNames[mode], JSON.stringify(init.options), init.dictionary, base.finishFlush, base.chunkSize, base.maxOutputLength);
    return toBuffer(output);
  }

  function crc32(data: unknown, value: unknown = 0) {
    if (typeof data !== "string" && !isArrayBufferView(data)) {
      throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
    }
    if (typeof value !== "number") throw invalidArgType("value", "of type number", value);
    if (!Number.isInteger(value)) throw outOfRange("value", "an integer", value);
    if (value < 0 || value > 0xffffffff) throw outOfRange("value", ">= 0 && <= 4294967295", value);
    const bytes = typeof data === "string" ? Buffer.from(data) : bytesOf(data);
    return native.crc32(bytes, value + 0);
  }

  function module() {
    const exports: Record<string, unknown> = { crc32 };
    for (const name of names) {
      Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: () => classes()[name] });
    }
    for (const name of names) {
      const lower = name[0].toLowerCase() + name.slice(1);
      exports[lower] = (buffer: unknown, opts?: ZlibOptions | Callback, callback?: Callback) => {
        if (typeof opts === "function") { callback = opts; opts = {}; }
        return zlibBuffer(new (classes()[name] as Ctor)(opts), buffer, callback);
      };
      exports[lower + "Sync"] = (buffer: unknown, opts?: ZlibOptions) => convertSync(name, buffer, opts);
    }
    for (const name of names) {
      Object.defineProperty(exports, "create" + name, {
        configurable: true, enumerable: true,
        value: { ["create" + name]: (options?: ZlibOptions) => new (classes()[name] as Ctor)(options) }["create" + name],
      });
    }
    Object.defineProperty(exports, "constants", { configurable: false, enumerable: true, value: constants });
    Object.defineProperty(exports, "codes", { enumerable: true, writable: false, value: Object.freeze(codes) });
    // Deprecated top-level copies of the non-Brotli constants.
    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith("BROTLI")) continue;
      Object.defineProperty(exports, key, { enumerable: false, value, writable: false });
    }
    return exports;
  }

  // Bun.zstdCompressSync / zstdDecompressSync (BunObject.rs JSZstd): Bun's
  // one-shot Zstd calls, `level` 1..22, other options ignored.
  function bunInput(data: unknown): Uint8Array {
    if (typeof data === "string") return Buffer.from(data);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return internal.toUint8(data);
    throw nodeError(new TypeError("Expected buffer to be a string or buffer"), "ERR_INVALID_ARG_TYPE");
  }
  function bunCompress(data: unknown, options?: { level?: unknown }) {
    let level = 3;
    if (options && typeof options === "object" && options.level !== undefined) {
      level = Number(options.level) | 0;
      if (level < 1 || level > 22) throw nodeError(new TypeError("Compression level must be between 1 and 22"), "ERR_INVALID_ARG_TYPE");
    }
    return toBuffer(native.zstdCompress(bunInput(data), level));
  }
  function bunDecompress(data: unknown) {
    return toBuffer(native.zstdDecompress(bunInput(data)));
  }
  return { module, bunCompress, bunDecompress };
})
