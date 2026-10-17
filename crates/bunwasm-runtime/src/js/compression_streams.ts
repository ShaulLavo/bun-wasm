(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native.streams;
  const finalizers = new FinalizationRegistry<number>(id => native.release(id));
  const empty = new Uint8Array();
  const typedArray = Object.getPrototypeOf(Uint8Array.prototype);

  function slot(prototype: object, key: string, value: unknown): unknown {
    const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
    if (!getter) throw new TypeError("Missing buffer getter");
    return Reflect.apply(getter, value, []);
  }

  function bufferView(value: unknown): [unknown, unknown, unknown] {
    try {
      return [slot(typedArray, "buffer", value), slot(typedArray, "byteOffset", value), slot(typedArray, "byteLength", value)];
    } catch {
      return [slot(DataView.prototype, "buffer", value), slot(DataView.prototype, "byteOffset", value), slot(DataView.prototype, "byteLength", value)];
    }
  }

  function isArrayBuffer(value: unknown): value is ArrayBuffer {
    try { slot(ArrayBuffer.prototype, "byteLength", value); return true; }
    catch { return false; }
  }

  function bytes(value: unknown): Uint8Array {
    if (typeof value === "string") return new TextEncoder().encode(value);
    let view: Uint8Array;
    try {
      const [buffer, offset, length] = ArrayBuffer.isView(value) ? bufferView(value) : [value, 0, slot(ArrayBuffer.prototype, "byteLength", value)];
      if (!isArrayBuffer(buffer) || typeof offset !== "number" || typeof length !== "number") throw new TypeError("Invalid buffer view");
      view = new Uint8Array(buffer, offset, length);
    } catch {
      if (value === null) throw Object.assign(new TypeError("May not write null values to stream"), { code: "ERR_STREAM_NULL_VALUES" });
      throw Object.assign(new TypeError(`The "chunk" argument must be of type BufferSource. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if ((view.buffer as ArrayBuffer & { detached?: boolean }).detached === true) throw new TypeError("Cannot transform a detached buffer");
    return view;
  }

  // Bun's parseCodecOptions (JSCompressionStreamShared.cpp): the second
  // argument is a queuing strategy whose highWaterMark bounds each step's
  // output, plus Bun's `level` for CompressionStream.
  const formats = ["deflate", "deflate-raw", "gzip", "brotli", "zstd"];
  const levels: Record<string, [number, number]> = { deflate: [0, 9], "deflate-raw": [0, 9], gzip: [0, 9], brotli: [0, 11], zstd: [1, 22] };
  function parseFormat(value: unknown): string {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    const name = String(value);
    if (formats.includes(name)) return name;
    const shown = typeof value === "string" ? `'${value}'` : String(value);
    throw Object.assign(new TypeError(`The argument 'format' must be one of: deflate, deflate-raw, gzip, brotli, zstd. Received ${shown}`), { code: "ERR_INVALID_ARG_VALUE" });
  }
  function parseOptions(strategy: unknown, levelFormat: string | undefined) {
    if (strategy != null && typeof strategy !== "object" && typeof strategy !== "function") throw new TypeError("The queuing strategy must be an object");
    const dictionary = (strategy ?? {}) as { highWaterMark?: unknown; level?: unknown };
    let highWaterMark = 64 * 1024;
    if (dictionary.highWaterMark !== undefined) {
      highWaterMark = Number(dictionary.highWaterMark);
      if (Number.isNaN(highWaterMark) || highWaterMark < 0) throw new RangeError("The queuing strategy's highWaterMark must be a non-negative, non-NaN number");
    }
    let level: number | undefined;
    if (levelFormat && strategy !== null && typeof strategy === "object" && dictionary.level !== undefined) {
      level = Number(dictionary.level);
      const [min, max] = levels[levelFormat];
      if (!(level >= min && level <= max) || level !== Math.trunc(level)) {
        throw new RangeError(`The compression level must be an integer between ${min} and ${max} for ${levelFormat}`);
      }
    }
    return { highWaterMark, level };
  }

  // Brotli decoder failures carry Node's code and the decoder's own detail as the cause.
  function codecError(error: unknown) {
    if (!(error instanceof Error) || !("detail" in error)) return error;
    const code = (error as { code?: unknown }).code;
    const cause = Object.assign(new Error(String(error.detail)), { code });
    return Object.assign(new TypeError(error.message), { code, cause });
  }

  function create(_Transform: typeof TransformStream, Readable = ReadableStream, Writable = WritableStream) {
    // Bun's native transform arms: a chunk runs through the coder in steps
    // (CompressionStreamCoder.rs); the write that carried it settles once its
    // whole expansion has been read, and the readable holds one piece at a time.
    function stream(format: unknown, decompress: boolean, strategy: unknown) {
      const name = parseFormat(format);
      const { highWaterMark, level } = parseOptions(strategy, decompress ? undefined : name);
      const id = native.webCodec(name, decompress, highWaterMark, level);
      const token = {};
      finalizers.register(token, id, token);
      let released = false;
      let cancelled = false;
      let closing = false;
      let readableController!: ReadableStreamDefaultController<Uint8Array>;
      let writableController!: WritableStreamDefaultController;
      // A chunk (or the flush) whose expansion waits for the reader to pull.
      let parked: { resume(): void; abandon(): void } | undefined;
      // A write that waits for room in the readable before its first step.
      let waiting: { go(): void; stop(reason: unknown): void } | undefined;
      function release() {
        if (released) return;
        released = true;
        native.release(id);
        finalizers.unregister(token);
      }
      function errorReadable(reason: unknown) {
        try { readableController.error(reason); } catch { /* already closed */ }
      }
      function settlePending(reason: unknown) {
        const active = parked;
        parked = undefined;
        active?.abandon();
        const queued = waiting;
        waiting = undefined;
        queued?.stop(reason);
      }
      const full = () => (readableController.desiredSize ?? 0) <= 0;
      function run(input: Uint8Array, finish: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
          let first = true;
          const step = () => {
            parked = undefined;
            for (;;) {
              let piece: { bytes: Uint8Array; more: boolean };
              try {
                if (released) throw new TypeError("Compression stream is closed");
                piece = native.webStep(id, first ? input : empty, finish);
              } catch (caught) {
                const error = codecError(caught);
                release();
                errorReadable(error);
                reject(error);
                return;
              }
              first = false;
              if (piece.bytes.byteLength) readableController.enqueue(piece.bytes);
              if (!piece.more) { resolve(); return; }
              if (full()) {
                parked = { resume: step, abandon: () => resolve() };
                return;
              }
            }
          };
          step();
        });
      }
      const readable = new Readable<Uint8Array>({
        start(controller) { readableController = controller; },
        pull() {
          if (parked) { parked.resume(); return; }
          const queued = waiting;
          waiting = undefined;
          queued?.go();
        },
        cancel(reason) {
          cancelled = true;
          settlePending(reason);
          release();
          try { writableController.error(reason); } catch { /* already closed */ }
        },
      }, { highWaterMark: 1 });
      const writable = new Writable<unknown>({
        start(controller) {
          writableController = controller;
          // An abort gives up the expansion in flight unless the close owns it.
          controller.signal?.addEventListener("abort", () => {
            if (closing) return;
            const reason = controller.signal.reason;
            settlePending(reason);
            release();
            errorReadable(reason);
          }, { once: true });
        },
        write(chunk) {
          let input: Uint8Array;
          try { input = bytes(chunk); }
          catch (error) { release(); errorReadable(error); throw error; }
          if (!full()) return run(input, false);
          return new Promise<void>((resolve, reject) => {
            waiting = { go: () => run(input, false).then(resolve, reject), stop: reject };
          });
        },
        close() {
          closing = true;
          return run(empty, true).then(() => {
            release();
            if (!cancelled) readableController.close();
          });
        },
        abort(reason) {
          settlePending(reason);
          release();
          errorReadable(reason);
        },
      }, { highWaterMark: 1 });
      return { readable, writable };
    }
    class CompressionStream {
      #stream: ReturnType<typeof stream>;
      constructor(format: unknown, options?: unknown) { this.#stream = stream(format, false, options); }
      get readable() { return this.#stream.readable; }
      get writable() { return this.#stream.writable; }
      get [Symbol.toStringTag]() { return "CompressionStream"; }
    }
    class DecompressionStream {
      #stream: ReturnType<typeof stream>;
      constructor(format: unknown, options?: unknown) { this.#stream = stream(format, true, options); }
      get readable() { return this.#stream.readable; }
      get writable() { return this.#stream.writable; }
      get [Symbol.toStringTag]() { return "DecompressionStream"; }
    }
    const adapters = { CompressionStream, DecompressionStream };
    for (const [name, constructor] of Object.entries(adapters)) {
      for (const key of ["readable", "writable"]) {
        const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, key);
        if (!descriptor) throw new TypeError("Missing compression stream getter");
        Object.defineProperty(constructor.prototype, key, { ...descriptor, enumerable: true });
      }
      Object.defineProperty(constructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    }
    return adapters;
  }
  let decoders: ReturnType<typeof create> | undefined;
  function decode(body: ReadableStream<Uint8Array>, encoding: string | null): ReadableStream<Uint8Array> {
    if (encoding === null) return body;
    const format = encoding === "br" ? "brotli" : encoding === "x-gzip" ? "gzip" : encoding;
    decoders ??= create(TransformStream, ReadableStream, WritableStream);
    return body.pipeThrough(new decoders.DecompressionStream(format));
  }
  return { create, decode };
})
