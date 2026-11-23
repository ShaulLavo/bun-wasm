// Intrinsic BufferSource readers shared by TextDecoder, TextDecoderStream, and
// node:string_decoder. Captures prototype getters before user code can shadow
// `buffer`, `byteOffset`, or `byteLength` on a view or ArrayBuffer, and treats
// detached or out-of-bounds views as empty without copying nonempty Uint8Arrays.
(function () {
  "use strict";
  const empty = new Uint8Array(0);
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedTag = getter<string | undefined>(typedPrototype, Symbol.toStringTag);
  const typedReaders = viewReaders(typedPrototype);
  const dataReaders = viewReaders(DataView.prototype);
  const bufferLength = getter<number>(ArrayBuffer.prototype, "byteLength");
  const sharedLength = typeof SharedArrayBuffer === "undefined" ? undefined : getter<number>(SharedArrayBuffer.prototype, "byteLength");

  function getter<T>(prototype: object, name: PropertyKey): (this: unknown) => T {
    const read = Object.getOwnPropertyDescriptor(prototype, name)?.get;
    if (typeof read !== "function") throw new TypeError(`Missing ${String(name)} getter`);
    return read;
  }

  function viewReaders(prototype: object) {
    return {
      buffer: getter<ArrayBufferLike>(prototype, "buffer"),
      length: getter<number>(prototype, "byteLength"),
      offset: getter<number>(prototype, "byteOffset"),
    };
  }

  function isUint8Array(input: unknown): input is Uint8Array {
    return input instanceof Uint8Array && typedTag.call(input) === "Uint8Array";
  }

  function bufferSize(input: unknown): number {
    try { return bufferLength.call(input); } catch (error) {
      if (!sharedLength) throw error;
      return sharedLength.call(input);
    }
  }

  function isBuffer(input: unknown): input is ArrayBufferLike {
    try { bufferSize(input); return true; } catch { return false; }
  }

  function viewBytes(view: ArrayBufferView): Uint8Array {
    if (isUint8Array(view)) return typedReaders.length.call(view) === 0 ? empty : view;
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
    if (ArrayBuffer.isView(input)) return viewBytes(input);
    return bufferSize(input) === 0 ? empty : new Uint8Array(input);
  }

  function readBufferSource(input: unknown): Uint8Array {
    if (ArrayBuffer.isView(input) || isBuffer(input)) return inputBytes(input);
    throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
  }

  return { empty, isBuffer, viewBytes, inputBytes, readBufferSource };
})
