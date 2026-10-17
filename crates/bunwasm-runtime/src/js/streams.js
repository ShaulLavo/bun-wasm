(function (internal) {
  "use strict";
  const names = ["ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableByteStreamController", "ReadableStreamDefaultController", "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "TransformStream", "TransformStreamDefaultController", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream"];
  if (internal.native.engine === "host") {
    return Object.assign(Object.fromEntries(names.map(name => [name, globalThis[name]])),
      internal.require("compression_streams").create(globalThis.TransformStream, globalThis.ReadableStream, globalThis.WritableStream));
  }
  const streams = internal.require("streams_polyfill");
  const native = internal.native.streams;
  const finalizers = new FinalizationRegistry(id => native.release(id));
  const empty = new Uint8Array(0);

  function domString(value) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }

  function dictionary(value) {
    if (value == null) return {};
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Expected an options dictionary");
    return value;
  }

  function codecTransformer(id, convert = internal.toUint8) {
    const token = {};
    finalizers.register(token, id, token);
    function release() {
      native.release(id);
      finalizers.unregister(token);
    }
    function push(bytes, last, controller) {
      try {
        const output = native.push(id, bytes, last);
        if (output.length) controller.enqueue(output);
      } catch (error) {
        release();
        throw error;
      }
    }
    return {
      transform(chunk, controller) {
        try { push(convert(chunk), false, controller); }
        catch (error) { release(); throw error; }
      },
      flush(controller) {
        try { push(empty, true, controller); }
        finally { release(); }
      },
      cancel() { release(); },
    };
  }

  class TextEncoderStream {
    #stream;
    constructor() {
      let pending = "";
      function encode(input, controller, last) {
        let text = pending + input;
        pending = "";
        const tail = text.charCodeAt(text.length - 1);
        if (!last && tail >= 0xd800 && tail <= 0xdbff) {
          pending = text.slice(-1);
          text = text.slice(0, -1);
        }
        if (text.length) controller.enqueue(internal.native.utf8Encode(text.toWellFormed()));
      }
      this.#stream = new streams.TransformStream({
        transform(chunk, controller) {
          encode(domString(chunk), controller, false);
        },
        flush(controller) { encode("", controller, true); },
      });
    }
    get encoding() { void this.#stream; return "utf-8"; }
    get readable() { return this.#stream.readable; }
    get writable() { return this.#stream.writable; }
    get [Symbol.toStringTag]() { return "TextEncoderStream"; }
  }

  class TextDecoderStream {
    #stream;
    #encoding;
    #fatal;
    #ignoreBOM;
    constructor(label = "utf-8", options = {}) {
      label = domString(label);
      options = dictionary(options);
      this.#fatal = Boolean(options.fatal);
      this.#ignoreBOM = Boolean(options.ignoreBOM);
      const decoder = native.decoder(label.toWellFormed(), this.#fatal, this.#ignoreBOM);
      this.#encoding = decoder.encoding;
      this.#stream = new streams.TransformStream(codecTransformer(decoder.id));
    }
    get encoding() { return this.#encoding; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    get readable() { return this.#stream.readable; }
    get writable() { return this.#stream.writable; }
    get [Symbol.toStringTag]() { return "TextDecoderStream"; }
  }

  const adapters = Object.assign({ TextEncoderStream, TextDecoderStream },
    internal.require("compression_streams").create(streams.TransformStream, streams.ReadableStream, streams.WritableStream));
  for (const [name, constructor] of Object.entries(adapters)) {
    for (const key of Object.getOwnPropertyNames(constructor.prototype)) {
      if (key === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, key);
      Object.defineProperty(constructor.prototype, key, Object.assign(descriptor, { enumerable: true }));
    }
    Object.defineProperty(constructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  }
  return Object.assign(streams, adapters);
})
