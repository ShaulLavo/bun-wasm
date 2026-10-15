(function (internal) {
  "use strict";

  function startModes(options) {
    const type = typeof options;
    if (options === null || (type !== "object" && type !== "function")) return null;
    const asUint8Array = Object.prototype.hasOwnProperty.call(options, "asUint8Array") ? options.asUint8Array : undefined;
    const stream = options.stream;
    const highWaterMark = options.highWaterMark;
    const specified = typeof asUint8Array === "boolean" || typeof stream === "boolean" || typeof highWaterMark === "number";
    return specified ? { asUint8Array: asUint8Array === true, stream: stream === true } : null;
  }

  function copyChunk(data) {
    const shared = typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer;
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !shared) {
      throw new TypeError("write() expects a string, ArrayBufferView, or ArrayBuffer");
    }
    return new Uint8Array(internal.toUint8(data));
  }

  class Sink {
    #chunks = [];
    #state = "open";
    #modes = { stream: false, asUint8Array: false };

    #assertLive() {
      if (this.#state !== "closed") return;
      throw new Error('This ArrayBufferSink has already been closed. A "direct" ReadableStream terminates its underlying socket once `async pull()` returns.');
    }

    #drain() {
      const bytes = internal.concatBytes(this.#chunks);
      this.#chunks = [];
      return this.#modes.asUint8Array ? bytes : bytes.buffer;
    }

    start(options) {
      const modes = startModes(options);
      this.#assertLive();
      this.#chunks = [];
      this.#state = "open";
      if (modes !== null) this.#modes = modes;
    }

    write(data) {
      this.#assertLive();
      const bytes = typeof data === "string" ? internal.native.utf8Encode(data) : copyChunk(data);
      if (bytes.byteLength > 0) this.#chunks.push(bytes);
      return bytes.byteLength;
    }

    flush() {
      this.#assertLive();
      return this.#modes.stream ? this.#drain() : 0;
    }

    end() {
      this.#assertLive();
      if (this.#state === "ended") return new ArrayBuffer(0);
      this.#state = "ended";
      return this.#drain();
    }

    close() {
      if (this.#state === "closed") return;
      this.#state = "closed";
      this.#chunks = [];
    }
  }

  function ArrayBufferSink() {
    return new Sink();
  }

  ArrayBufferSink.prototype = undefined;
  Object.defineProperty(Sink.prototype, "constructor", { value: ArrayBufferSink, writable: true, configurable: true });
  Object.defineProperty(Sink.prototype, Symbol.toStringTag, { value: "ArrayBufferSink", configurable: true });
  return { ArrayBufferSink };
})
