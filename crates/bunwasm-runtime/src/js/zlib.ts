(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const { Buffer, kMaxLength = 0x7fffffff } = internal.require("buffer");
  type Format = "gzip" | "deflate" | "deflate-raw" | "brotli" | "zstd" | "unzip";
  type Options = {
    level?: number; params?: Record<string, number>; maxOutputLength?: number;
    chunkSize?: number; windowBits?: number; memLevel?: number; strategy?: number;
    flush?: number; finishFlush?: number; info?: boolean;
  };
  type Callback = (error: unknown, result?: unknown) => void;
  type Spec = { name: string; format: Format; decompress: boolean };
  const specs: Spec[] = [
    { name: "Deflate", format: "deflate", decompress: false },
    { name: "Inflate", format: "deflate", decompress: true },
    { name: "DeflateRaw", format: "deflate-raw", decompress: false },
    { name: "InflateRaw", format: "deflate-raw", decompress: true },
    { name: "Gzip", format: "gzip", decompress: false },
    { name: "Gunzip", format: "gzip", decompress: true },
    { name: "Unzip", format: "unzip", decompress: true },
    { name: "BrotliCompress", format: "brotli", decompress: false },
    { name: "BrotliDecompress", format: "brotli", decompress: true },
    { name: "ZstdCompress", format: "zstd", decompress: false },
    { name: "ZstdDecompress", format: "zstd", decompress: true },
  ];
  const constants = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    Z_MIN_CHUNK: 64, Z_DEFAULT_CHUNK: 16384, Z_MAX_CHUNK: Infinity,
    Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
    Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1,
    BROTLI_PARAM_LGWIN: 2, BROTLI_PARAM_LGBLOCK: 3, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
    BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7,
    BROTLI_PARAM_NDIRECT: 8, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2,
    BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11,
    BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_DEFAULT_WINDOW: 22,
    ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_c_compressionLevel: 100,
    ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103, ZSTD_c_searchLog: 104,
    ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107,
    ZSTD_c_contentSizeFlag: 200, ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202,
    ZSTD_d_windowLogMax: 100, ZSTD_defaultCLevel: 3, ZSTD_minCLevel: -131072, ZSTD_maxCLevel: 22,
  };

  function input(data: unknown): Uint8Array {
    if (typeof data === "string") return Buffer.from(data);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return internal.toUint8(data);
    throw Object.assign(new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer'), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function range(name: string, value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || Number.isNaN(value)) return fallback;
    if (typeof value !== "number") throw Object.assign(new TypeError(`The "options.${name}" property must be of type number`), { code: "ERR_INVALID_ARG_TYPE" });
    if (value < min || value > max) throw Object.assign(new RangeError(`The value of "options.${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`), { code: "ERR_OUT_OF_RANGE" });
    return value;
  }

  function optionsFor(spec: Spec, options: Options = {}) {
    if (options === null || typeof options !== "object") throw Object.assign(new TypeError('The "options" argument must be of type object'), { code: "ERR_INVALID_ARG_TYPE" });
    range("chunkSize", options.chunkSize, 64, Infinity, 16384);
    range("windowBits", options.windowBits, 8, 15, 15);
    range("memLevel", options.memLevel, 1, 9, 8);
    range("strategy", options.strategy, 0, 4, 0);
    const maxOutputLength = range("maxOutputLength", options.maxOutputLength, 1, kMaxLength, kMaxLength);
    let level = range("level", options.level, -1, 9, -1);
    if (spec.format === "brotli") {
      for (const key of Object.keys(options.params ?? {})) {
        if (!Number.isInteger(+key) || +key < 0 || +key > 8) throw Object.assign(new RangeError(`${key} is not a valid Brotli parameter`), { code: "ERR_BROTLI_INVALID_PARAM" });
      }
      level = range("params.BROTLI_PARAM_QUALITY", options.params?.[1], 0, 11, 11);
    }
    if (spec.format === "zstd") {
      const known = new Set([100, 101, 102, 103, 104, 105, 106, 107, 200, 201, 202, 400]);
      for (const key of Object.keys(options.params ?? {})) {
        if (!known.has(+key)) throw Object.assign(new RangeError(`${key} is not a valid zstd parameter`), { code: "ERR_ZSTD_INVALID_PARAM" });
      }
      level = range("params.ZSTD_c_compressionLevel", options.params?.[100], -131072, 22, 3);
    }
    return { level, maxOutputLength, params: JSON.stringify(options.params ?? {}) };
  }

  function checked(bytes: Uint8Array, limit: number) {
    if (bytes.length > limit) throw Object.assign(new RangeError(`Cannot create a Buffer larger than ${limit} bytes`), { code: "ERR_BUFFER_TOO_LARGE" });
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function formatFor(spec: Spec, bytes: Uint8Array): Exclude<Format, "unzip"> {
    if (spec.format !== "unzip") return spec.format;
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate";
  }

  function sync(spec: Spec, data: unknown, options: Options = {}) {
    const bytes = input(data);
    const config = optionsFor(spec, options);
    const format = formatFor(spec, bytes);
    const wrapper = format === "deflate" ? "zlib" : format === "deflate-raw" ? "raw" : format;
    const output = spec.decompress ? native.decompress(bytes, wrapper, config.maxOutputLength) : native.compress(bytes, config.level, wrapper, config.params);
    return checked(output, config.maxOutputLength);
  }

  let classes: Record<string, BunWasm.CompressionConstructor> | undefined;
  const finalizers = new FinalizationRegistry<number>(id => native.streams.release(id));
  function streamClasses() {
    if (classes) return classes;
    const { Transform } = internal.builtin("node:stream");
    class CodecStream extends Transform {
      #spec: Spec;
      #options: Options;
      #state: { kind: "active"; handle: number } | { kind: "sniff"; chunks: Uint8Array[] } | { kind: "closed" } = { kind: "sniff", chunks: [] };
      #limit: number;
      #output = 0;
      #pending = false;
      bytesWritten = 0;
      constructor(spec: Spec, options: Options = {}) {
        const config = optionsFor(spec, options);
        super(options);
        this.#spec = spec;
        this.#options = { ...options, params: { ...options.params } };
        this.#limit = config.maxOutputLength;
        if (spec.format !== "unzip") this.#open(spec.format, spec.decompress, config.level, config.params);
      }
      #open(format: string, decompress: boolean, level?: number, params?: string) {
        const handle = native.streams.codec(format, decompress, level, params);
        this.#state = { kind: "active", handle };
        finalizers.register(this, handle, this);
      }
      #push(chunk: Uint8Array, last: boolean) {
        if (this.#state.kind === "closed") throw Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
        if (this.#state.kind === "sniff") {
          this.#state.chunks.push(chunk);
          chunk = internal.concatBytes(this.#state.chunks);
          if (chunk.length < 2 && !last) return Buffer.from([]);
          const format = formatFor(this.#spec, chunk);
          this.#open(format, true);
        }
        const state = this.#state;
        if (state.kind !== "active") throw new Error("Compression stream was not initialized");
        const bytes = native.streams.push(state.handle, chunk, last);
        this.#output += bytes.length;
        return checked(bytes, this.#limit - this.#output + bytes.length);
      }
      _transform(chunk: unknown, _encoding: string, callback: Callback) {
        this.#pending = true;
        let output: Uint8Array | undefined;
        let error: unknown;
        try {
          const bytes = input(chunk);
          this.bytesWritten += bytes.length;
          output = this.#push(bytes, false);
        } catch (caught) { error = caught; }
        setImmediate(() => {
          this.#pending = false;
          callback(error, output);
        });
      }
      _flush(callback: Callback) {
        try {
          const output = this.#push(new Uint8Array(), true);
          this.close();
          callback(null, output);
        } catch (error) { callback(error); }
      }
      _destroy(error: unknown, callback: Callback) {
        this.close();
        callback(error);
      }
      flush(kind?: number | (() => void), callback?: () => void) {
        const cb = typeof kind === "function" ? kind : callback;
        this.write(Buffer.from([]), cb);
      }
      close(callback?: () => void) {
        if (this.#state.kind === "active") native.streams.release(this.#state.handle);
        finalizers.unregister(this);
        this.#state = { kind: "closed" };
        if (callback) setImmediate(callback);
      }
      reset() {
        if (this.#pending) throw new Error("Cannot reset zlib stream while a write is in progress");
        this.close();
        const config = optionsFor(this.#spec, this.#options);
        this.#state = { kind: "sniff", chunks: [] };
        if (this.#spec.format !== "unzip") this.#open(this.#spec.format, this.#spec.decompress, config.level, config.params);
        this.#output = 0;
      }
      _processChunk(chunk: unknown, flush: number, callback?: Callback): Uint8Array | undefined {
        if (callback) { this._transform(chunk, "buffer", callback); return; }
        const bytes = input(chunk);
        this.bytesWritten += bytes.length;
        return this.#push(bytes, flush === 4 || (this.#spec.format === "brotli" || this.#spec.format === "zstd") && flush === 2);
      }
    }
    class Zlib extends CodecStream {}
    class Brotli extends CodecStream {}
    class Zstd extends CodecStream {}
    classes = {};
    for (const spec of specs) {
      const Base = spec.format === "brotli" ? Brotli : spec.format === "zstd" ? Zstd : Zlib;
      classes[spec.name] = { [spec.name]: class extends Base {
        constructor(options?: Options) { super(spec, options); }
      } }[spec.name];
    }
    return classes;
  }

  function module() {
    const exports: Record<string, unknown> = { ...constants, constants };
    for (const spec of specs) {
      const name = spec.name[0].toLowerCase() + spec.name.slice(1);
      exports[name + "Sync"] = (data: unknown, options?: Options) => sync(spec, data, options);
      exports[name] = (data: unknown, options: Options | Callback, callback?: Callback) => {
        const cb = typeof options === "function" ? options : callback;
        if (typeof cb !== "function") throw Object.assign(new TypeError('The "callback" argument must be of type function'), { code: "ERR_INVALID_ARG_TYPE" });
        const bytes = input(data);
        const opts = typeof options === "function" ? undefined : options;
        optionsFor(spec, opts);
        setImmediate(() => {
          let result: unknown;
          let error: unknown = null;
          try { result = sync(spec, bytes, opts); } catch (caught) { error = caught; }
          cb(error, result);
        });
      };
      exports["create" + spec.name] = (options?: Options) => new (streamClasses()[spec.name])(options);
      Object.defineProperty(exports, spec.name, { enumerable: true, get: () => streamClasses()[spec.name] });
    }
    exports.crc32 = (data: unknown, value = 0) => native.crc32(input(data), value >>> 0);
    const codes: Record<string, string | number> = {};
    for (const name of ["Z_OK", "Z_STREAM_END", "Z_NEED_DICT", "Z_ERRNO", "Z_STREAM_ERROR", "Z_DATA_ERROR", "Z_MEM_ERROR", "Z_BUF_ERROR", "Z_VERSION_ERROR"] as const) {
      codes[name] = constants[name];
      codes[constants[name]] = name;
    }
    exports.codes = codes;
    return exports;
  }

  function bunCompress(data: unknown, options: { level?: number } = {}) {
    const level = options.level ?? 3;
    if (!Number.isInteger(level) || level < 1 || level > 22) throw new RangeError("Compression level must be between 1 and 22");
    return checked(native.compress(input(data), level, "zstd"), kMaxLength);
  }
  function bunDecompress(data: unknown) { return checked(native.decompress(input(data), "zstd"), kMaxLength); }
  return { module, bunCompress, bunDecompress };
})
