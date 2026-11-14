(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native.streams;
  const finalizers = new FinalizationRegistry<number>(id => native.release(id));
  const empty = new Uint8Array(0);
  const typedReaders = viewReaders(Object.getPrototypeOf(Uint8Array.prototype));
  const dataReaders = viewReaders(DataView.prototype);
  const bufferLength = getter<number>(ArrayBuffer.prototype, "byteLength");
  const sharedLength = typeof SharedArrayBuffer === "undefined" ? undefined : getter<number>(SharedArrayBuffer.prototype, "byteLength");

  function getter<T>(prototype: object, name: string): (this: unknown) => T {
    const read = Object.getOwnPropertyDescriptor(prototype, name)?.get;
    if (typeof read !== "function") throw new TypeError(`Missing ${name} getter`);
    return read;
  }

  function viewReaders(prototype: object) {
    return {
      buffer: getter<ArrayBufferLike>(prototype, "buffer"),
      length: getter<number>(prototype, "byteLength"),
      offset: getter<number>(prototype, "byteOffset"),
    };
  }

  function viewBytes(view: ArrayBufferView): Uint8Array {
    let readers = typedReaders;
    let buffer: ArrayBufferLike;
    try { buffer = readers.buffer.call(view); } catch {
      readers = dataReaders;
      buffer = readers.buffer.call(view);
    }
    let length: number, offset: number;
    try {
      length = readers.length.call(view);
      offset = readers.offset.call(view);
    } catch { return empty; }
    return length === 0 ? empty : new Uint8Array(buffer, offset, length);
  }

  function inputBytes(input: ArrayBufferLike | ArrayBufferView): Uint8Array {
    if (input instanceof Uint8Array) return typedReaders.length.call(input) === 0 ? empty : input;
    if (ArrayBuffer.isView(input)) return viewBytes(input);
    const length = input instanceof ArrayBuffer ? bufferLength.call(input) : sharedLength?.call(input);
    return length === 0 ? empty : new Uint8Array(input);
  }

  function dictionary(value: unknown): { fatal?: unknown; ignoreBOM?: unknown; stream?: unknown } {
    if (value == null) return {};
    if (typeof value === "object" || typeof value === "function") return value;
    throw Object.assign(new TypeError("Expected an options dictionary"), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function validateInput(input: unknown) {
    if (input === undefined || ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return input;
    if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) return input;
    throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
  }

  return class TextDecoder {
    #encoding: string;
    #fatal: boolean;
    #ignoreBOM: boolean;
    #bomSeen = false;
    #id: number | null = null;

    constructor(label: unknown = "utf-8", options: unknown = {}) {
      if (typeof label === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
      const convertedLabel = String(label);
      const convertedOptions = dictionary(options);
      this.#fatal = Boolean(convertedOptions.fatal);
      this.#ignoreBOM = Boolean(convertedOptions.ignoreBOM);
      this.#encoding = this.#create(convertedLabel).encoding;
    }

    #create(label: string) {
      let decoder;
      try {
        // Serialize the BOM only after a whole native push succeeds. A fatal
        // chunk must not consume the stream's first output code point.
        decoder = native.decoder(label, this.#fatal, true);
      } catch (error) {
        if (error instanceof RangeError) Object.assign(error, { code: "ERR_ENCODING_NOT_SUPPORTED" });
        throw error;
      }
      this.#id = decoder.id;
      finalizers.register(this, decoder.id, this);
      return decoder;
    }

    #release() {
      if (this.#id === null) return;
      native.release(this.#id);
      finalizers.unregister(this);
      this.#id = null;
    }

    get encoding() { return this.#encoding; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    get [Symbol.toStringTag]() { return "TextDecoder"; }

    decode(input?: unknown, options: unknown = {}) {
      const source = validateInput(input);
      const stream = Boolean(dictionary(options).stream);
      const bytes = source === undefined ? empty : inputBytes(source);
      const id = this.#id ?? this.#create(this.#encoding).id;
      try {
        return this.#serialize(native.push(id, bytes, !stream));
      } catch (error) {
        this.#release();
        if (error instanceof TypeError) Object.assign(error, { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
        throw error;
      } finally {
        if (!stream) this.#end();
      }
    }

    #end() {
      this.#release();
      this.#bomSeen = false;
    }

    #serialize(text: string) {
      if (this.#bomSeen || text.length === 0 || this.#ignoreBOM) return text;
      if (this.#encoding !== "utf-8" && this.#encoding !== "utf-16le" && this.#encoding !== "utf-16be") return text;
      this.#bomSeen = true;
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
  };
})
