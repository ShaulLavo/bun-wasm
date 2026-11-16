(function () {
  "use strict";

  type Encoding = "utf8" | "utf16le" | "latin1" | "ascii";
  type Bindings = {
    normalizeEncoding(value: unknown): string | undefined;
    invalidArgType(name: string, expected: string[], actual: unknown): Error;
    bytesToString(bytes: Uint8Array, encoding: Encoding): string;
    fromString(text: string, encoding: Encoding): Uint8Array;
    allocate(size: number): Uint8Array;
  };

  return function createTranscode(bindings: Bindings) {
    const { normalizeEncoding, invalidArgType, bytesToString, fromString, allocate } = bindings;
    const decoders: (TextDecoder | undefined)[] = [];
    const tag = tagGetter();

    function tagGetter() {
      const read = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
      if (typeof read !== "function") throw new TypeError("Missing TypedArray tag getter");
      return read;
    }

    function isSource(value: unknown): value is Uint8Array {
      return ArrayBuffer.isView(value) && tag.call(value) === "Uint8Array";
    }

    function encoding(value: unknown): Encoding {
      const normalized = normalizeEncoding(value);
      if (normalized === "utf8" || normalized === "utf16le" || normalized === "latin1" || normalized === "ascii") return normalized;
      throw failure("U_ILLEGAL_ARGUMENT_ERROR", 1);
    }

    function failure(code: string, errno: number): Error {
      return Object.assign(new Error(`Unable to transcode Buffer [${code}]`), { code, errno });
    }

    function unicode(source: Uint8Array, from: "utf8" | "utf16le", fatal: boolean): string {
      const index = (from === "utf8" ? 0 : 2) + Number(fatal);
      let decoder = decoders[index];
      if (!decoder) {
        decoder = new TextDecoder(from === "utf8" ? "utf-8" : "utf-16le", { ignoreBOM: true, fatal });
        decoders[index] = decoder;
      }
      try { return decoder.decode(source); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw failure("U_INVALID_CHAR_FOUND", 10);
      }
    }

    function decode(source: Uint8Array, from: Encoding, to: Encoding): string {
      if (from === "latin1" || from === "ascii") {
        const text = bytesToString(source, "latin1");
        return from === "ascii" && to !== "utf16le" ? text.replace(/[\x80-\xff]/g, "\ufffd") : text;
      }
      const fatal = from !== to && (to === "utf8" || to === "utf16le");
      const truncate = from === "utf16le" && to !== "utf16le" && source.length > 1;
      const bytes = truncate ? source.subarray(0, source.length - source.length % 2) : source;
      if (from === "utf16le" && to !== "utf8" && to !== "utf16le" && source.length === 1) return "";
      return unicode(bytes, from, fatal);
    }

    function narrow(text: string, to: "ascii" | "latin1"): Uint8Array {
      let size = 0;
      for (const _character of text) size++;
      const output = allocate(size);
      const max = to === "ascii" ? 0x7f : 0xff;
      let index = 0;
      for (const character of text) {
        const code = character.charCodeAt(0);
        output[index++] = code <= max ? code : 0x3f;
      }
      return output;
    }

    return function transcode(source: unknown, fromEncoding?: unknown, toEncoding?: unknown): Uint8Array {
      if (!isSource(source)) throw invalidArgType("source", ["Buffer", "Uint8Array"], source);
      if (source.length === 0) return allocate(0);
      const from = encoding(fromEncoding), to = encoding(toEncoding);
      const text = decode(source, from, to);
      return to === "ascii" || to === "latin1" ? narrow(text, to) : fromString(text, to);
    };
  };
});
