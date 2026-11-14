(function () {
  "use strict";

  type Encoding = "utf8" | "latin1" | "ascii" | "utf16le" | "base64" | "base64url" | "hex";
  type Bindings = {
    proto: object;
    defineMethods(target: object, methods: Record<string, unknown>): void;
    bytesToString(bytes: Uint8Array, encoding: Encoding): string;
    writeString(bytes: Uint8Array, text: string, offset: number, length: number, encoding: Encoding): number;
    makeError(ctor: typeof RangeError | typeof TypeError, code: string, message: string): Error;
    bufferOutOfBounds(name?: string): Error;
  };

  return function installEncodingBindings(bindings: Bindings) {
    const { proto, defineMethods, bytesToString, writeString, makeError, bufferOutOfBounds } = bindings;
    const isView = ArrayBuffer.isView;
    const typedLength = lengthGetter(Object.getPrototypeOf(Uint8Array.prototype));
    const dataLength = lengthGetter(DataView.prototype);

    function lengthGetter(prototype: object): (this: ArrayBufferView) => number {
      const getter = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
      if (typeof getter !== "function") throw new TypeError("Missing ArrayBufferView byteLength getter");
      return getter;
    }

    function dataViewLength(view: ArrayBufferView): number {
      try { return dataLength.call(view); } catch { return 0; }
    }

    function viewLength(view: ArrayBufferView): number {
      try { return typedLength.call(view); } catch { return dataViewLength(view); }
    }

    function receiver(value: unknown): ArrayBufferView {
      if (!isView(value)) throw new TypeError("Expected ArrayBufferView");
      return value;
    }

    function index(value: number | undefined, fallback: number): number {
      if (value === undefined) return fallback;
      const number = Math.trunc(+value) || 0;
      if (number < 0) throw makeError(RangeError, "ERR_OUT_OF_RANGE", "Index out of range");
      return Math.min(number, 2 ** 63 - 1);
    }

    function stringArgument(value: unknown): string {
      if (typeof value !== "string") throw makeError(TypeError, "ERR_INVALID_ARG_TYPE", "argument must be a string");
      return value;
    }

    function checkDetached(view: ArrayBufferView, argument: unknown): void {
      if (typeof argument !== "object" && typeof argument !== "function" || argument === null) return;
      // Constructing even a zero-length view distinguishes detached from empty storage.
      new Uint8Array(view.buffer, 0, 0);
    }

    function write(view: ArrayBufferView, text: string, offset: number, length: number, encoding: Encoding): number {
      if (length === 0) return 0;
      return writeString(new Uint8Array(view.buffer, view.byteOffset, viewLength(view)), text, offset, length, encoding);
    }

    function strictWrite(value: unknown, text: unknown, offset: number | undefined, length: number | undefined, encoding: Encoding): number {
      const view = receiver(value);
      const off = offset === undefined ? 0 : +offset;
      const requested = length === undefined ? undefined : +length;
      const size = viewLength(view);
      if (off < 0 || off > size) throw bufferOutOfBounds("offset");
      if (!Number.isNaN(off) && requested !== undefined && (requested < 0 || requested > size - off)) {
        throw bufferOutOfBounds("length");
      }
      const str = stringArgument(text);
      const start = Math.trunc(off) || 0;
      const count = requested === undefined ? (Number.isNaN(off) ? 0 : size - start) : Math.max(0, Math.trunc(requested) || 0);
      return write(view, str, start, Math.min(count, size - start), encoding);
    }

    function clampingWrite(value: unknown, text: unknown, offset: number | undefined, length: number | undefined, encoding: Encoding): number {
      const view = receiver(value);
      const str = stringArgument(text);
      const start = index(offset, 0);
      checkDetached(view, offset);
      const size = viewLength(view);
      if (start > size) throw bufferOutOfBounds("offset");
      const count = index(length, size - start);
      checkDetached(view, length);
      const remaining = Math.max(0, viewLength(view) - start);
      return write(view, str, start, Math.min(count, remaining), encoding);
    }

    function slice(value: unknown, start: number | undefined, end: number | undefined, encoding: Encoding): string {
      const view = receiver(value);
      const size = viewLength(view);
      if (size === 0) return "";
      const from = index(start, 0), to = index(end, size);
      if (from >= to) return "";
      if (to > size) throw makeError(RangeError, "ERR_OUT_OF_RANGE", "Index out of range");
      const currentSize = viewLength(view);
      if (from >= currentSize) return "";
      return bytesToString(new Uint8Array(view.buffer, view.byteOffset + from, Math.min(to, currentSize) - from), encoding);
    }

    const encodings: Record<string, Encoding> = {
      utf8: "utf8", latin1: "latin1", ascii: "ascii", ucs2: "utf16le",
      utf16le: "utf16le", base64: "base64", base64url: "base64url", hex: "hex",
    };
    function install(prefix: string, encoding: Encoding): void {
      const writeEncoding = prefix === "utf8" || prefix === "latin1" || prefix === "ascii" ? strictWrite : clampingWrite;
      defineMethods(proto, {
        [`${prefix}Slice`](this: unknown, start?: number, end?: number) { return slice(this, start, end, encoding); },
        [`${prefix}Write`](this: unknown, text: unknown, offset?: number, length?: number) { return writeEncoding(this, text, offset, length, encoding); },
      });
    }
    for (const prefix of Object.keys(encodings)) install(prefix, encodings[prefix]);
  };
});
