(function (internal: BunWasm.Internal) {
  "use strict";

  function getter(prototype: object, name: string) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.get) throw new TypeError(`Missing intrinsic getter: ${name}`);
    return descriptor.get;
  }
  function viewGetters(prototype: object) {
    return {
      buffer: getter(prototype, "buffer"),
      byteOffset: getter(prototype, "byteOffset"),
      byteLength: getter(prototype, "byteLength"),
    };
  }
  const typedArrayGetters = viewGetters(Object.getPrototypeOf(Uint8Array.prototype));
  const arrayBufferLength = getter(ArrayBuffer.prototype, "byteLength");
  const sharedBufferLength = typeof SharedArrayBuffer === "undefined" ? null : getter(SharedArrayBuffer.prototype, "byteLength");
  const dataViewGetters = viewGetters(DataView.prototype);

  function bufferLength(buffer: ArrayBufferLike): number {
    try { return arrayBufferLength.call(buffer); }
    catch (error) {
      if (sharedBufferLength === null) throw error;
      return sharedBufferLength.call(buffer);
    }
  }

  function viewBytes(data: ArrayBufferView): Uint8Array<ArrayBufferLike> {
    let getters = typedArrayGetters;
    let buffer: ArrayBufferLike;
    try { buffer = getters.buffer.call(data); }
    catch { getters = dataViewGetters; buffer = getters.buffer.call(data); }
    if (bufferLength(buffer) === 0) return new Uint8Array(0);
    return new Uint8Array(buffer, getters.byteOffset.call(data), getters.byteLength.call(data));
  }

  function startModes(options: unknown) {
    if (options === null || (typeof options !== "object" && typeof options !== "function")) return null;
    const asUint8Array = Object.prototype.hasOwnProperty.call(options, "asUint8Array") ? Reflect.get(options, "asUint8Array") : undefined;
    const stream = Reflect.get(options, "stream");
    const highWaterMark = Reflect.get(options, "highWaterMark");
    const specified = typeof asUint8Array === "boolean" || typeof stream === "boolean" || typeof highWaterMark === "number";
    return specified ? { asUint8Array: asUint8Array === true, stream: stream === true } : null;
  }

  function copyChunk(data: unknown): Uint8Array<ArrayBuffer> {
    const shared = typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer;
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !shared) {
      throw new TypeError("write() expects a string, ArrayBufferView, or ArrayBuffer");
    }
    if (ArrayBuffer.isView(data)) return new Uint8Array(viewBytes(data));
    if (bufferLength(data) === 0) return new Uint8Array(0);
    return new Uint8Array(new Uint8Array(data));
  }

  class Sink {
    #chunks: Uint8Array<ArrayBuffer>[] = [];
    #state: "open" | "ended" | "closed" = "open";
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

    start(options?: unknown) {
      const modes = startModes(options);
      this.#assertLive();
      this.#chunks = [];
      this.#state = "open";
      if (modes !== null) this.#modes = modes;
    }

    write(data: unknown) {
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
