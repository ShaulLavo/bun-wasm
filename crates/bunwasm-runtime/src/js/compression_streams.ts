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
    try {
      const [buffer, offset, length] = ArrayBuffer.isView(value) ? bufferView(value) : [value, 0, slot(ArrayBuffer.prototype, "byteLength", value)];
      if (!isArrayBuffer(buffer) || typeof offset !== "number" || typeof length !== "number") throw new TypeError("Invalid buffer view");
      return new Uint8Array(buffer, offset, length);
    } catch {
      throw Object.assign(new TypeError("Expected a non-shared ArrayBuffer or ArrayBufferView"), {
        code: value === null ? "ERR_STREAM_NULL_VALUES" : "ERR_INVALID_ARG_TYPE",
      });
    }
  }

  function create(Transform: typeof TransformStream) {
    function stream(format: unknown, decompress: boolean): TransformStream<unknown, Uint8Array> {
      if (typeof format === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
      const id = native.codec(String(format), decompress);
      const token = {};
      finalizers.register(token, id, token);
      function release() { native.release(id); finalizers.unregister(token); }
      function push(chunk: Uint8Array, last: boolean, controller: TransformStreamDefaultController<Uint8Array>) {
        const output = native.push(id, chunk, last);
        if (output.length) controller.enqueue(output);
      }
      const transformer: Transformer<unknown, Uint8Array> & { cancel(): void } = {
        transform(chunk, controller) {
          try { push(bytes(chunk), false, controller); }
          catch (error) { release(); throw error; }
        },
        flush(controller) {
          try { push(empty, true, controller); }
          finally { release(); }
        },
        cancel() { release(); },
      };
      return new Transform<unknown, Uint8Array>(transformer, undefined, { highWaterMark: 16384, size: chunk => chunk.byteLength });
    }
    class CompressionStream {
      #stream: TransformStream<unknown, Uint8Array>;
      constructor(format: unknown) { this.#stream = stream(format, false); }
      get readable() { return this.#stream.readable; }
      get writable() { return this.#stream.writable; }
      get [Symbol.toStringTag]() { return "CompressionStream"; }
    }
    class DecompressionStream {
      #stream: TransformStream<unknown, Uint8Array>;
      constructor(format: unknown) { this.#stream = stream(format, true); }
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
    decoders ??= create(TransformStream);
    return body.pipeThrough(new decoders.DecompressionStream(format));
  }
  return { create, decode };
})
