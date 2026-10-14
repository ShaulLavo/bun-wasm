// node:string_decoder polyfill. Multi-byte characters split across writes are
// buffered (up to 4 bytes) until complete; base64 keeps partial 3-byte groups.
(function (internal) {
  "use strict";

  function getBuffer() {
    return internal.require("buffer").Buffer;
  }

  function makeError(Ctor, code, message) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function normalizeEncoding(enc) {
    if (enc === undefined || enc === null || enc === "") return "utf8";
    switch (String(enc).toLowerCase()) {
      case "utf8":
      case "utf-8":
        return "utf8";
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return "utf16le";
      case "latin1":
      case "binary":
        return "latin1";
      case "base64":
        return "base64";
      case "base64url":
        return "base64url";
      case "hex":
        return "hex";
      case "ascii":
        return "ascii";
      default:
        return undefined;
    }
  }

  function describeReceived(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") {
      return value.constructor && value.constructor.name ? `an instance of ${value.constructor.name}` : "[Object: null prototype]";
    }
    if (typeof value === "string") return `type string ('${value}')`;
    return `type ${typeof value} (${String(value)})`;
  }

  function toBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    throw makeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "buf" argument must be of type Buffer, TypedArray, or DataView. Received ${describeReceived(buf)}`,
    );
  }

  // Port of Node's native decoder (src/string_decoder.cc), which Bun matches:
  // `missing` bytes still needed to finish the buffered character and
  // `buffered` bytes of it held in `lastChar`.

  function makeString(bytes, encoding) {
    if (bytes.length === 0) return "";
    return getBuffer().from(bytes.buffer, bytes.byteOffset, bytes.length).toString(encoding);
  }

  const kBufferedEncodings = ["utf8", "utf16le", "base64", "base64url"];

  // Consumes the start of `data` to finish a character from the previous chunk.
  function finishPending(self, data) {
    let offset = 0;
    if (self.encoding === "utf8") {
      for (let i = 0; i < data.length && i < self._missing; i++) {
        if ((data[i] & 0xc0) === 0x80) continue;
        // Not a continuation byte: give up on the pending character here.
        self._missing = 0;
        self.lastChar.set(data.subarray(0, i), self._buffered);
        self._buffered += i;
        offset = i;
        break;
      }
    }
    const found = Math.min(data.length - offset, self._missing);
    self.lastChar.set(data.subarray(offset, offset + found), self._buffered);
    self._missing -= found;
    self._buffered += found;
    offset += found;
    if (self._missing !== 0) return { prepend: "", offset };
    const prepend = makeString(self.lastChar.subarray(0, self._buffered), self.encoding);
    self._buffered = 0;
    return { prepend, offset };
  }

  // How many trailing UTF-8 bytes to hold back; sets `_missing`.
  function utf8Tail(self, data) {
    let buffered = 0;
    for (let i = data.length - 1; ; i--) {
      buffered++;
      const b = data[i];
      if ((b & 0xc0) === 0x80) {
        if (buffered >= 4 || i === 0) return 0;
        continue;
      }
      let total;
      if ((b & 0xe0) === 0xc0) total = 2;
      else if ((b & 0xf0) === 0xe0) total = 3;
      else if ((b & 0xf8) === 0xf0) total = 4;
      else return 0;
      if (buffered >= total) return 0;
      self._missing = total - buffered;
      return buffered;
    }
  }

  function tailLength(self, data) {
    const last = data[data.length - 1];
    switch (self.encoding) {
      case "utf8":
        return last & 0x80 ? utf8Tail(self, data) : 0;
      case "utf16le":
        if (data.length % 2 === 1) {
          self._missing = 1;
          return 1;
        }
        if ((last & 0xfc) === 0xd8) {
          self._missing = 2;
          return 2;
        }
        return 0;
      case "base64":
      case "base64url": {
        const rest = data.length % 3;
        if (rest > 0) self._missing = 3 - rest;
        return rest;
      }
      default:
        return 0;
    }
  }

  function decodeChunk(self, input) {
    let data = input;
    let prepend = "";
    if (kBufferedEncodings.includes(self.encoding) && self._missing > 0) {
      const done = finishPending(self, data);
      prepend = done.prepend;
      data = data.subarray(done.offset);
    }
    if (data.length === 0) return prepend;
    const tail = tailLength(self, data);
    self._buffered = tail;
    if (tail > 0) self.lastChar.set(data.subarray(data.length - tail), 0);
    return prepend + makeString(data.subarray(0, data.length - tail), self.encoding);
  }

  function flush(self) {
    if (self.encoding === "utf16le" && self._buffered % 2 === 1) {
      self._missing--;
      self._buffered--;
    }
    const out = makeString(self.lastChar.subarray(0, self._buffered), self.encoding);
    self._missing = 0;
    self._buffered = 0;
    return out;
  }

  class StringDecoder {
    constructor(encoding) {
      const normalized = normalizeEncoding(encoding);
      if (normalized === undefined) throw makeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`);
      this.encoding = normalized;
      this.lastChar = getBuffer().alloc(4);
      this._missing = 0;
      this._buffered = 0;
    }

    get lastNeed() {
      return this._missing;
    }

    get lastTotal() {
      return this._buffered + this._missing;
    }

    write(input) {
      if (typeof input === "string") return input;
      return decodeChunk(this, toBytes(input));
    }

    end(input) {
      let out = "";
      if (input !== undefined) out = this.write(input);
      return out + flush(this);
    }

    text(input, offset) {
      this._missing = 0;
      this._buffered = 0;
      return this.write(toBytes(input).subarray(offset));
    }
  }

  return { StringDecoder };
});
