// node:buffer polyfill. Evaluated as a classic script; the completion value is
// the module factory. `Buffer` instances are Uint8Arrays whose prototype is
// Buffer.prototype (Node's FastBuffer trick), so `Buffer(...)` stays callable.
(function (internal) {
  "use strict";

  const kMaxLength = 4294967296;
  const kStringMaxLength = 2147483647;
  const INSPECT_MAX_BYTES = 50;

  // ---------------------------------------------------------------------------
  // Errors (Node-style codes and messages)
  // ---------------------------------------------------------------------------

  function makeError(Ctor, code, message) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function lazyInspect(value) {
    try {
      return internal.require("inspect").nodeInspect(value, { depth: -1 });
    } catch (_) {
      return String(value);
    }
  }

  function describeReceived(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    switch (typeof value) {
      case "bigint":
        return `type bigint (${value}n)`;
      case "number":
        return `type number (${Object.is(value, -0) ? "-0" : String(value)})`;
      case "boolean":
        return `type boolean (${value})`;
      case "symbol":
        return `type symbol (${String(value)})`;
      case "function":
        return `function ${value.name}`;
      case "string": {
        const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
        return shown.indexOf("'") === -1 ? `type string ('${shown}')` : `type string (${JSON.stringify(shown)})`;
      }
    }
    if (value.constructor && "name" in value.constructor) return `an instance of ${value.constructor.name}`;
    return lazyInspect(value);
  }

  const kTypes = ["string", "function", "number", "object", "Function", "Object", "boolean", "bigint", "symbol"];

  function joinList(prefix, list) {
    if (list.length > 2) return `${prefix}${list.slice(0, -1).join(", ")}, or ${list[list.length - 1]}`;
    if (list.length === 2) return `${prefix}${list[0]} or ${list[1]}`;
    return `${prefix}${list[0]}`;
  }

  function invalidArgType(name, expected, actual) {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    let msg = "The ";
    if (name.endsWith(" argument")) msg += `${name} `;
    else msg += `"${name}" ${name.includes(".") ? "property" : "argument"} `;
    msg += "must be ";
    const types = [];
    const instances = [];
    const other = [];
    for (const value of expectedList) {
      if (kTypes.includes(value)) types.push(value.toLowerCase());
      else if (/^([A-Z][a-z0-9]*)+$/.test(value)) instances.push(value);
      else other.push(value);
    }
    if (instances.length > 0 && types.includes("object")) {
      types.splice(types.indexOf("object"), 1);
      instances.push("Object");
    }
    const parts = [];
    if (types.length > 0) parts.push(joinList(types.length > 1 ? "one of type " : "of type ", types));
    if (instances.length > 0) parts.push(joinList("an instance of ", instances));
    if (other.length > 0) {
      const article = other.length === 1 && other[0].toLowerCase() !== other[0] ? "an " : "";
      parts.push(joinList(other.length > 1 ? "one of " : article, other));
    }
    msg += parts.join(" or ");
    msg += `. Received ${describeReceived(actual)}`;
    return makeError(TypeError, "ERR_INVALID_ARG_TYPE", msg);
  }

  function addNumericalSeparator(val) {
    let res = "";
    let i = val.length;
    const start = val[0] === "-" ? 1 : 0;
    for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
    return `${val.slice(0, i)}${res}`;
  }

  function formatReceived(input) {
    if (typeof input === "number") {
      if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) return addNumericalSeparator(String(input));
      return Object.is(input, -0) ? "-0" : String(input);
    }
    if (typeof input === "bigint") {
      const s = String(input);
      return (input > 2n ** 32n || input < -(2n ** 32n) ? addNumericalSeparator(s) : s) + "n";
    }
    if (typeof input === "string") return `'${input}'`;
    return lazyInspect(input);
  }

  function outOfRange(name, range, received) {
    return makeError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be ${range}. Received ${formatReceived(received)}`,
    );
  }

  function bufferOutOfBounds(name) {
    const msg = name ? `"${name}" is outside of buffer bounds` : "Attempt to access memory outside buffer bounds";
    return makeError(RangeError, "ERR_BUFFER_OUT_OF_BOUNDS", msg);
  }

  function unknownEncoding(enc) {
    return makeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${enc}`);
  }

  function invalidArgValue(name, value) {
    return makeError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      `The argument '${name}' is invalid. Received ${formatReceived(value)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Encodings
  // ---------------------------------------------------------------------------

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

  function getEncoding(enc) {
    const normalized = normalizeEncoding(enc);
    if (normalized === undefined) throw unknownEncoding(enc);
    return normalized;
  }

  const utf8Encoder = new TextEncoder();
  const utf8Decoder = createUtf8Decoder();
  // Node keeps a leading BOM; detect whether `ignoreBOM` is honoured.
  const decoderKeepsBOM = utf8Decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf])) === "﻿";

  function createUtf8Decoder() {
    try {
      return new TextDecoder("utf-8", { ignoreBOM: true });
    } catch (_) {
      return new TextDecoder("utf-8");
    }
  }

  function utf8Slice(bytes) {
    if (bytes.length === 0) return "";
    const hasBOM = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (!hasBOM || decoderKeepsBOM) return utf8Decoder.decode(bytes);
    return "﻿" + utf8Decoder.decode(bytes.subarray(3));
  }

  const CHUNK = 0x1000;

  function charCodesToString(codes) {
    let out = "";
    for (let i = 0; i < codes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, codes.subarray(i, i + CHUNK));
    }
    return out;
  }

  function latin1Slice(bytes) {
    return charCodesToString(bytes);
  }

  function asciiSlice(bytes) {
    const masked = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) masked[i] = bytes[i] & 0x7f;
    return charCodesToString(masked);
  }

  function ucs2Slice(bytes) {
    const units = new Uint16Array(bytes.length >>> 1);
    for (let i = 0; i < units.length; i++) units[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    return charCodesToString(units);
  }

  const HEX_CHARS = "0123456789abcdef";
  const hexTable = Array.from({ length: 256 }, (_, i) => HEX_CHARS[i >> 4] + HEX_CHARS[i & 15]);

  function hexSlice(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += hexTable[bytes[i]];
    return out;
  }

  const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // Decoding accepts both alphabets, like Node.
  const b64Lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) {
    b64Lookup[B64_STD.charCodeAt(i)] = i;
    b64Lookup[B64_URL.charCodeAt(i)] = i;
  }

  function base64Slice(bytes, url) {
    const alphabet = url ? B64_URL : B64_STD;
    const parts = [];
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
      if (out.length >= 8192) {
        parts.push(out);
        out = "";
      }
    }
    const rest = bytes.length - i;
    if (rest === 1) {
      const n = bytes[i] << 16;
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (url ? "" : "==");
    } else if (rest === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (url ? "" : "=");
    }
    parts.push(out);
    return parts.join("");
  }

  // Lenient decoder: skips characters outside both alphabets, stops at '='.
  function base64ToBytes(str) {
    const out = new Uint8Array(Math.ceil((str.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      // Like Bun, each UTF-16 unit is first truncated to its low byte.
      const c = str.charCodeAt(i) & 0xff;
      if (c === 0x3d) break;
      const v = c < 128 ? b64Lookup[c] : -1;
      if (v === -1) continue;
      acc = ((acc << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (acc >> bits) & 0xff;
      }
    }
    return out.subarray(0, n);
  }

  function hexValue(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
  }

  // Parses hex pairs until the first invalid pair; an odd trailing nibble is dropped.
  function hexToBytes(str) {
    const out = new Uint8Array(str.length >>> 1);
    let n = 0;
    for (; n < out.length; n++) {
      // Like Bun, each UTF-16 unit is truncated to its low byte first.
      const hi = hexValue(str.charCodeAt(2 * n) & 0xff);
      const lo = hexValue(str.charCodeAt(2 * n + 1) & 0xff);
      if (hi < 0 || lo < 0) break;
      out[n] = (hi << 4) | lo;
    }
    return out.subarray(0, n);
  }

  function latin1ToBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
    return out;
  }

  function ucs2ToBytes(str) {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[2 * i] = c & 0xff;
      out[2 * i + 1] = c >>> 8;
    }
    return out;
  }

  function stringToBytes(str, enc) {
    switch (enc) {
      case "utf8":
        return utf8Encoder.encode(str);
      case "utf16le":
        return ucs2ToBytes(str);
      case "latin1":
      case "ascii":
        return latin1ToBytes(str);
      case "base64":
      case "base64url":
        return base64ToBytes(str);
      case "hex":
        return hexToBytes(str);
    }
    throw unknownEncoding(enc);
  }

  function bytesToString(bytes, enc) {
    switch (enc) {
      case "utf8":
        return utf8Slice(bytes);
      case "utf16le":
        return ucs2Slice(bytes);
      case "latin1":
        return latin1Slice(bytes);
      case "ascii":
        return asciiSlice(bytes);
      case "base64":
        return base64Slice(bytes, false);
      case "base64url":
        return base64Slice(bytes, true);
      case "hex":
        return hexSlice(bytes);
    }
    throw unknownEncoding(enc);
  }

  function utf8ByteLength(str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) len += 1;
      else if (c < 0x800) len += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) {
        len += 4;
        i++;
      } else len += 3;
    }
    return len;
  }

  function isLowSurrogate(c) {
    return c >= 0xdc00 && c <= 0xdfff;
  }

  function base64ByteLength(str) {
    let bytes = str.length;
    if (str.charCodeAt(bytes - 1) === 0x3d) bytes--;
    if (bytes > 1 && str.charCodeAt(bytes - 1) === 0x3d) bytes--;
    return (bytes * 3) >>> 2;
  }

  function stringByteLength(str, enc) {
    switch (enc) {
      case "utf8":
        return utf8ByteLength(str);
      case "utf16le":
        return str.length * 2;
      case "latin1":
      case "ascii":
        return str.length;
      case "base64":
      case "base64url":
        return base64ByteLength(str);
      case "hex":
        return str.length >>> 1;
    }
    return utf8ByteLength(str);
  }

  // Number of bytes of `bytes` that fit in `max` without splitting a character.
  function truncateForWrite(bytes, max, enc) {
    if (bytes.length <= max) return bytes.length;
    if (enc === "utf16le") return max & ~1;
    if (enc !== "utf8") return max;
    let n = max;
    while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Buffer construction
  // ---------------------------------------------------------------------------

  class FastBuffer extends Uint8Array {
    // Explicit constructor so `new FastBuffer(ab, offset, length)` shares memory.
    constructor(bufferOrLength, byteOffset, length) {
      super(bufferOrLength, byteOffset, length);
    }
  }

  // `Buffer(arg)` without `new` is deprecated in Node but still works.
  function Buffer(arg, encodingOrOffset, length) {
    if (typeof arg === "number") {
      if (typeof encodingOrOffset === "string") {
        throw invalidArgType("string", "string", arg);
      }
      return Buffer.alloc(arg);
    }
    return Buffer.from(arg, encodingOrOffset, length);
  }

  FastBuffer.prototype.constructor = Buffer;
  Buffer.prototype = FastBuffer.prototype;
  Object.setPrototypeOf(Buffer, Uint8Array);

  function isAnyArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return true;
    return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
  }

  function isUint8Array(value) {
    return value instanceof Uint8Array;
  }

  function wrapBytes(bytes) {
    return new FastBuffer(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  function fromString(str, encoding) {
    const enc = typeof encoding === "string" ? getEncoding(encoding) : "utf8";
    return wrapBytes(stringToBytes(str, enc));
  }

  function fromArrayBuffer(ab, byteOffset, length) {
    let offset = 0;
    if (byteOffset !== undefined) {
      offset = +byteOffset;
      if (offset !== offset) offset = 0;
    }
    const maxLength = ab.byteLength - offset;
    if (maxLength < 0) throw bufferOutOfBounds("offset");
    let len = maxLength;
    if (length !== undefined) {
      len = +length;
      if (len > 0) {
        if (len > maxLength) throw bufferOutOfBounds("length");
      } else {
        len = 0;
      }
    }
    return new FastBuffer(ab, offset, len);
  }

  function fromArrayLike(obj) {
    if (obj.length <= 0) return new FastBuffer(0);
    const buf = new FastBuffer(obj.length);
    buf.set(obj, 0);
    return buf;
  }

  function fromObject(obj) {
    if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
      if (typeof obj.length !== "number") return new FastBuffer(0);
      return fromArrayLike(obj);
    }
    if (obj.type === "Buffer" && Array.isArray(obj.data)) return fromArrayLike(obj.data);
    return undefined;
  }

  const kFromMessage = "first argument";
  const kFromTypes = ["string", "Buffer", "ArrayBuffer", "Array", "Array-like Object"];

  Buffer.from = function from(value, encodingOrOffset, length) {
    if (typeof value === "string") return fromString(value, encodingOrOffset);
    if (typeof value !== "object" || value === null) throw invalidArgType(kFromMessage, kFromTypes, value);
    if (isAnyArrayBuffer(value)) return fromArrayBuffer(value, encodingOrOffset, length);

    const valueOf = typeof value.valueOf === "function" ? value.valueOf() : undefined;
    if (valueOf != null && valueOf !== value && (typeof valueOf === "string" || typeof valueOf === "object")) {
      return Buffer.from(valueOf, encodingOrOffset, length);
    }
    const fromObj = fromObject(value);
    if (fromObj) return fromObj;
    if (typeof value[Symbol.toPrimitive] === "function") {
      const primitive = value[Symbol.toPrimitive]("string");
      if (typeof primitive === "string") return fromString(primitive, encodingOrOffset);
    }
    throw invalidArgType(kFromMessage, kFromTypes, value);
  };

  Buffer.copyBytesFrom = function copyBytesFrom(view, offset, length) {
    if (!ArrayBuffer.isView(view) || view instanceof DataView) {
      throw invalidArgType("view", ["TypedArray"], view);
    }
    if (view.length === 0) return new FastBuffer(0);
    const start = rangeArg(offset, "offset", 0, Number.MAX_SAFE_INTEGER, " &&");
    if (start >= view.length) return new FastBuffer(0);
    const count = rangeArg(length, "length", view.length, Number.MAX_SAFE_INTEGER, " &&");
    const end = start + count;
    const slice = view.subarray(Math.min(start, view.length), Math.min(end, view.length));
    const bytes = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
    return wrapBytes(bytes.slice());
  };

  function validateSize(size) {
    if (typeof size !== "number") throw invalidArgType("size", "number", size);
    if (!(size >= 0 && size <= kMaxLength)) throw outOfRange("size", `>= 0 && <= ${kMaxLength}`, size);
  }

  Buffer.alloc = function alloc(size, fill, encoding) {
    validateSize(size);
    const buf = new FastBuffer(size);
    if (fill !== undefined && fill !== 0 && size > 0) buf.fill(fill, 0, buf.length, encoding);
    return buf;
  };

  Buffer.allocUnsafe = function allocUnsafe(size) {
    validateSize(size);
    return new FastBuffer(size);
  };

  Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
    validateSize(size);
    return new FastBuffer(size);
  };

  Buffer.poolSize = 8192;

  Buffer.isBuffer = function isBuffer(b) {
    return b instanceof Buffer;
  };

  Buffer.isEncoding = function isEncoding(encoding) {
    return typeof encoding === "string" && encoding.length !== 0 && normalizeEncoding(encoding) !== undefined;
  };

  Buffer.byteLength = function byteLength(string, encoding) {
    if (typeof string !== "string") {
      if (ArrayBuffer.isView(string) || isAnyArrayBuffer(string)) return string.byteLength;
      throw invalidArgType("string", ["string", "Buffer", "ArrayBuffer"], string);
    }
    return stringByteLength(string, normalizeEncoding(encoding) || "utf8");
  };

  function compareBytes(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  }

  Buffer.compare = function compare(buf1, buf2) {
    if (!isUint8Array(buf1)) throw invalidArgType("buf1", ["Buffer", "Uint8Array"], buf1);
    if (!isUint8Array(buf2)) throw invalidArgType("buf2", ["Buffer", "Uint8Array"], buf2);
    if (buf1 === buf2) return 0;
    return compareBytes(buf1, buf2);
  };

  Buffer.concat = function concat(list, totalLength) {
    if (!Array.isArray(list)) throw invalidArgType("list", "Array", list);
    if (list.length === 0) return new FastBuffer(0);
    let length = totalLength;
    if (length === undefined) {
      length = 0;
      for (let i = 0; i < list.length; i++) {
        if (!isUint8Array(list[i])) throw invalidArgType(`list[${i}]`, ["Buffer", "Uint8Array"], list[i]);
        length += list[i].length;
      }
    } else {
      validateLengthArg(length);
    }
    const out = Buffer.allocUnsafe(length);
    let pos = 0;
    for (let i = 0; i < list.length && pos < length; i++) {
      const item = list[i];
      if (!isUint8Array(item)) throw invalidArgType(`list[${i}]`, ["Buffer", "Uint8Array"], item);
      const take = Math.min(item.length, length - pos);
      out.set(take === item.length ? item : item.subarray(0, take), pos);
      pos += take;
    }
    return out;
  };

  function validateLengthArg(length) {
    if (typeof length !== "number") throw invalidArgType("length", "number", length);
    if (!Number.isInteger(length)) throw outOfRange("length", "an integer", length);
    if (length < 0 || length > kMaxLength) throw outOfRange("length", `>= 0 && <= ${kMaxLength}`, length);
  }

  // ---------------------------------------------------------------------------
  // Prototype: strings, slicing, comparison
  // ---------------------------------------------------------------------------

  const proto = Buffer.prototype;

  function defineMethods(target, methods) {
    for (const key of Object.keys(methods)) {
      Object.defineProperty(target, key, {
        value: methods[key],
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }

  function adjustOffset(offset, length) {
    offset = Math.trunc(offset);
    if (offset === 0 || offset !== offset) return 0;
    if (offset < 0) {
      offset += length;
      return offset > 0 ? offset : 0;
    }
    return offset < length ? offset : length;
  }

  function sliceShared(buf, start, end) {
    const len = buf.length;
    const s = adjustOffset(start, len);
    const e = end !== undefined ? adjustOffset(end, len) : len;
    return new FastBuffer(buf.buffer, buf.byteOffset + s, e > s ? e - s : 0);
  }

  function toStringRange(buf, encoding, start, end) {
    const len = buf.length;
    let s = start === undefined || start <= 0 ? 0 : start >= len ? len : Math.trunc(start) || 0;
    let e = end === undefined || end > len ? len : Math.trunc(end) || 0;
    if (e <= s) return "";
    const enc = encoding === undefined ? "utf8" : getEncoding(String(encoding));
    return bytesToString(s === 0 && e === len ? buf : buf.subarray(s, e), enc);
  }

  function parseWriteArgs(buf, offset, length, encoding) {
    // write(string[, encoding]) / write(string, offset[, encoding]) / write(string, offset, length[, encoding])
    if (offset === undefined) return { offset: 0, length: buf.length, encoding: "utf8" };
    if (length === undefined && typeof offset === "string") return { offset: 0, length: buf.length, encoding: offset };
    const off = validateWriteOffset(offset, "offset", buf.length);
    const remaining = buf.length - off;
    if (length === undefined) return { offset: off, length: remaining, encoding: "utf8" };
    if (typeof length === "string") return { offset: off, length: remaining, encoding: length };
    const len = validateWriteOffset(length, "length", buf.length);
    return { offset: off, length: Math.min(len, remaining), encoding };
  }

  function validateWriteOffset(value, name, max) {
    if (typeof value !== "number") throw invalidArgType(name, "number", value);
    if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
    if (value < 0 || value > max) throw outOfRange(name, `>= 0 && <= ${max}`, value);
    return value;
  }

  function writeString(buf, string, offset, maxLength, enc) {
    const bytes = stringToBytes(string, enc);
    const n = truncateForWrite(bytes, Math.min(maxLength, buf.length - offset), enc);
    if (n > 0) buf.set(n === bytes.length ? bytes : bytes.subarray(0, n), offset);
    return n;
  }

  function validateBufferArg(value, name) {
    if (!isUint8Array(value)) throw invalidArgType(name, ["Buffer", "Uint8Array"], value);
  }

  function toIntegerOr(n, defaultVal) {
    n = +n;
    if (n !== n || n < Number.MIN_SAFE_INTEGER || n > Number.MAX_SAFE_INTEGER) return defaultVal;
    return n % 1 === 0 ? n : Math.floor(n);
  }

  function copyImpl(source, target, targetStart, sourceStart, sourceEnd) {
    validateBufferArg(source, "source");
    validateBufferArg(target, "target");
    let tStart = 0;
    if (targetStart !== undefined) {
      tStart = Number.isInteger(targetStart) ? targetStart : toIntegerOr(targetStart, 0);
      if (tStart < 0) throw outOfRange("targetStart", ">= 0", tStart);
    }
    let sStart = 0;
    if (sourceStart !== undefined) {
      sStart = Number.isInteger(sourceStart) ? sourceStart : toIntegerOr(sourceStart, 0);
      if (sStart < 0 || sStart > source.length) {
        throw outOfRange("sourceStart", `>= 0 && <= ${source.length}`, sStart);
      }
    }
    let sEnd = source.length;
    if (sourceEnd !== undefined) {
      sEnd = Number.isInteger(sourceEnd) ? sourceEnd : toIntegerOr(sourceEnd, 0);
      if (sEnd < 0) throw outOfRange("sourceEnd", ">= 0", sEnd);
    }
    if (tStart >= target.length || sStart >= sEnd) return 0;
    const n = Math.min(sEnd - sStart, target.length - tStart, source.length - sStart);
    if (n <= 0) return 0;
    target.set(source.subarray(sStart, sStart + n), tStart);
    return n;
  }

  // `joiner` is " and" or " &&": Bun words its range messages both ways.
  function rangeArg(value, name, defaultValue, max, joiner = " and") {
    if (value === undefined) return defaultValue;
    if (typeof value !== "number") throw invalidArgType(name, "number", value);
    if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
    if (value < 0 || value > max) throw outOfRange(name, `>= 0${joiner} <= ${max}`, value);
    return value;
  }

  function encodeFillValue(value, encoding) {
    if (typeof value === "string") {
      const enc = getEncoding(encoding);
      if (value.length === 0) return new Uint8Array([0]);
      const bytes = stringToBytes(value, enc);
      if (bytes.length === 0) throw invalidArgValue("value", value);
      return bytes;
    }
    if (isUint8Array(value)) {
      if (value.length === 0) throw invalidArgValue("value", value);
      return value;
    }
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return undefined;
  }

  function fillImpl(buf, value, offset, end, encoding) {
    let { start, stop, encoding: enc } = internal.require("buffer_fill_args")(getEncoding, value, buf.length, offset, end, encoding);
    start = start === undefined ? 0 : rangeArg(start, "offset", 0, kMaxLength, " &&");
    stop = stop === undefined ? buf.length : rangeArg(stop, "end", buf.length, buf.length, " &&");
    if (stop <= start) return buf;
    const bytes = encodeFillValue(value, enc);
    if (bytes === undefined) {
      Uint8Array.prototype.fill.call(buf, (typeof value === "boolean" ? Number(value) : value) & 255, start, stop);
      return buf;
    }
    if (bytes.length === 1) {
      Uint8Array.prototype.fill.call(buf, bytes[0], start, stop);
      return buf;
    }
    for (let pos = start; pos < stop; pos += bytes.length) {
      const take = Math.min(bytes.length, stop - pos);
      buf.set(take === bytes.length ? bytes : bytes.subarray(0, take), pos);
    }
    return buf;
  }

  // ---------------------------------------------------------------------------
  // indexOf / lastIndexOf / includes
  // ---------------------------------------------------------------------------

  function indexOfOffset(length, offset, needleLength, forward) {
    if (offset < 0) {
      if (offset + length >= 0) return length + offset;
      if (forward || needleLength === 0) return 0;
      return -1;
    }
    if (offset + needleLength <= length) return offset;
    if (needleLength === 0) return length;
    return forward ? -1 : length - 1;
  }

  function matchesAt(haystack, needle, pos) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[pos + j] !== needle[j]) return false;
    }
    return true;
  }

  function searchBytes(haystack, needle, byteOffset, forward) {
    const start = indexOfOffset(haystack.length, byteOffset, needle.length, forward);
    if (needle.length === 0) return start;
    if (haystack.length === 0 || start <= -1) return -1;
    if (forward) {
      for (let i = start; i <= haystack.length - needle.length; i++) {
        if (matchesAt(haystack, needle, i)) return i;
      }
      return -1;
    }
    for (let i = Math.min(start, haystack.length - needle.length); i >= 0; i--) {
      if (matchesAt(haystack, needle, i)) return i;
    }
    return -1;
  }

  function bidirectionalIndexOf(buf, val, byteOffset, encoding, forward) {
    let enc = encoding;
    let offset = byteOffset;
    if (typeof offset === "string") {
      enc = offset;
      offset = undefined;
    } else if (offset > 0x7fffffff) {
      offset = 0x7fffffff;
    } else if (offset < -0x80000000) {
      offset = -0x80000000;
    }
    offset = +offset;
    if (offset !== offset) offset = forward ? 0 : buf.length;
    offset = Math.trunc(offset) || 0;

    if (typeof val === "number") return searchBytes(buf, [val >>> 0 & 255], offset, forward);
    if (typeof val === "string") {
      const normalized = enc === undefined ? "utf8" : getEncoding(enc);
      return searchBytes(buf, stringToBytes(val, normalized), offset, forward);
    }
    if (isUint8Array(val)) return searchBytes(buf, val, offset, forward);
    throw invalidArgType("value", ["number", "string", "Buffer", "Uint8Array"], val);
  }

  // ---------------------------------------------------------------------------
  // Numeric reads/writes
  // ---------------------------------------------------------------------------

  function checkReadOffset(buf, offset, byteLength) {
    if (offset === undefined) offset = 0;
    if (typeof offset !== "number") throw invalidArgType("offset", "number", offset);
    if (!Number.isInteger(offset)) throw outOfRange("offset", "an integer", offset);
    const max = buf.length - byteLength;
    if (max < 0) throw bufferOutOfBounds();
    if (offset < 0 || offset > max) throw outOfRange("offset", `>= 0 and <= ${max}`, offset);
    return offset;
  }

  function checkByteLength(byteLength) {
    if (typeof byteLength !== "number") throw invalidArgType("byteLength", "number", byteLength);
    if (!Number.isInteger(byteLength)) throw outOfRange("byteLength", "an integer", byteLength);
    if (byteLength < 1 || byteLength > 6) throw outOfRange("byteLength", ">= 1 and <= 6", byteLength);
  }

  function readUnsigned(buf, offset, n, little) {
    let val = 0;
    let mul = 1;
    for (let i = 0; i < n; i++) {
      val += buf[little ? offset + i : offset + n - 1 - i] * mul;
      mul *= 256;
    }
    return val;
  }

  function readSigned(buf, offset, n, little) {
    const val = readUnsigned(buf, offset, n, little);
    const limit = 2 ** (8 * n - 1);
    return val >= limit ? val - limit * 2 : val;
  }

  function writeBytes(buf, value, offset, n, little) {
    const lo = value;
    const hi = Math.floor(value * 2 ** -32);
    for (let i = 0; i < n; i++) {
      const byte = i < 4 ? (lo >>> (8 * i)) & 0xff : (hi >>> (8 * (i - 4))) & 0xff;
      buf[little ? offset + i : offset + n - 1 - i] = byte;
    }
    return offset + n;
  }

  function intRange(n, signed, powerForm) {
    if (!powerForm) {
      const min = signed ? -(2 ** (8 * n - 1)) : 0;
      const max = signed ? 2 ** (8 * n - 1) - 1 : 2 ** (8 * n) - 1;
      return { min, max, text: `>= ${min} and <= ${max}` };
    }
    const bits = 8 * n;
    if (!signed) return { min: 0, max: 2 ** bits - 1, text: `>= 0 and < 2 ** ${bits}` };
    return {
      min: -(2 ** (bits - 1)),
      max: 2 ** (bits - 1) - 1,
      text: `>= -(2 ** ${bits - 1}) and < 2 ** ${bits - 1}`,
    };
  }

  function writeInt(buf, value, offset, n, little, signed, powerForm) {
    const v = +value;
    const range = intRange(n, signed, powerForm);
    if (v > range.max || v < range.min) throw outOfRange("value", range.text, v);
    const off = checkReadOffset(buf, offset, n);
    return writeBytes(buf, v, off, n, little);
  }

  const float32 = new Float32Array(1);
  const float32Bytes = new Uint8Array(float32.buffer);
  const float64 = new Float64Array(1);
  const float64Bytes = new Uint8Array(float64.buffer);
  const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function copyScratch(scratch, buf, offset, little, toScratch) {
    const n = scratch.length;
    const reverse = little !== hostLittleEndian;
    for (let i = 0; i < n; i++) {
      const j = reverse ? n - 1 - i : i;
      if (toScratch) scratch[j] = buf[offset + i];
      else buf[offset + i] = scratch[j];
    }
  }

  function readFloat(buf, offset, little, double) {
    const off = checkReadOffset(buf, offset, double ? 8 : 4);
    copyScratch(double ? float64Bytes : float32Bytes, buf, off, little, true);
    return double ? float64[0] : float32[0];
  }

  function writeFloat(buf, value, offset, little, double) {
    const v = +value;
    const off = checkReadOffset(buf, offset, double ? 8 : 4);
    if (double) float64[0] = v;
    else float32[0] = v;
    copyScratch(double ? float64Bytes : float32Bytes, buf, off, little, false);
    return off + (double ? 8 : 4);
  }

  function readBig(buf, offset, little, signed) {
    const off = checkReadOffset(buf, offset, 8);
    const lo = readUnsigned(buf, little ? off : off + 4, 4, little);
    const hi = readUnsigned(buf, little ? off + 4 : off, 4, little);
    const value = (BigInt(hi) << 32n) | BigInt(lo);
    return signed ? BigInt.asIntN(64, value) : value;
  }

  function writeBig(buf, value, offset, little, signed) {
    if (typeof value !== "bigint") throw invalidArgType("value", "bigint", value);
    const min = signed ? -(2n ** 63n) : 0n;
    const max = signed ? 2n ** 63n - 1n : 2n ** 64n - 1n;
    if (value < min || value > max) {
      throw outOfRange("value", signed ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n", value);
    }
    const off = checkReadOffset(buf, offset, 8);
    const lo = Number(value & 0xffffffffn);
    const hi = Number((value >> 32n) & 0xffffffffn);
    writeBytes(buf, lo, little ? off : off + 4, 4, little);
    writeBytes(buf, hi, little ? off + 4 : off, 4, little);
    return off + 8;
  }

  function swapBytes(buf, size) {
    if (buf.length % size !== 0) {
      throw makeError(RangeError, "ERR_INVALID_BUFFER_SIZE", `Buffer size must be a multiple of ${size * 8}-bits`);
    }
    for (let i = 0; i < buf.length; i += size) {
      for (let a = i, b = i + size - 1; a < b; a++, b--) {
        const t = buf[a];
        buf[a] = buf[b];
        buf[b] = t;
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------------------
  // Prototype methods
  // ---------------------------------------------------------------------------

  defineMethods(proto, {
    toString(encoding, start, end) {
      if (arguments.length === 0) return utf8Slice(this);
      return toStringRange(this, encoding, start, end);
    },
    toLocaleString(encoding, start, end) {
      if (arguments.length === 0) return utf8Slice(this);
      return toStringRange(this, encoding, start, end);
    },
    write(string, offset, length, encoding) {
      if (typeof string !== "string") throw invalidArgType("string", "string", string);
      const args = parseWriteArgs(this, offset, length, encoding);
      if (args.length <= 0) return 0;
      const enc = args.encoding === undefined ? "utf8" : getEncoding(args.encoding);
      return writeString(this, string, args.offset, args.length, enc);
    },
    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    },
    equals(otherBuffer) {
      validateBufferArg(otherBuffer, "otherBuffer");
      if (this === otherBuffer) return true;
      if (this.length !== otherBuffer.length) return false;
      return compareBytes(this, otherBuffer) === 0;
    },
    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
      validateBufferArg(target, "target");
      const tStart = rangeArg(targetStart, "targetStart", 0, kMaxLength, " &&");
      const tEnd = rangeArg(targetEnd, "targetEnd", target.length, target.length);
      const sStart = rangeArg(sourceStart, "sourceStart", 0, kMaxLength, " &&");
      const sEnd = rangeArg(sourceEnd, "sourceEnd", this.length, this.length);
      if (sStart >= sEnd) return tStart >= tEnd ? 0 : -1;
      if (tStart >= tEnd) return 1;
      return compareBytes(this.subarray(sStart, sEnd), target.subarray(tStart, tEnd));
    },
    copy(target, targetStart, sourceStart, sourceEnd) {
      return copyImpl(this, target, targetStart, sourceStart, sourceEnd);
    },
    slice(start, end) {
      return sliceShared(this, start, end);
    },
    subarray(start, end) {
      return sliceShared(this, start, end);
    },
    fill(value, offset, end, encoding) {
      return fillImpl(this, value, offset, end, encoding);
    },
    indexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    },
    lastIndexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    },
    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    },
    swap16() {
      return swapBytes(this, 2);
    },
    swap32() {
      return swapBytes(this, 4);
    },
    swap64() {
      return swapBytes(this, 8);
    },
    readUIntLE(offset, byteLength) {
      if (offset === undefined) throw invalidArgType("offset", "number", offset);
      checkByteLength(byteLength);
      return readUnsigned(this, checkReadOffset(this, offset, byteLength), byteLength, true);
    },
    readUIntBE(offset, byteLength) {
      if (offset === undefined) throw invalidArgType("offset", "number", offset);
      checkByteLength(byteLength);
      return readUnsigned(this, checkReadOffset(this, offset, byteLength), byteLength, false);
    },
    readIntLE(offset, byteLength) {
      if (offset === undefined) throw invalidArgType("offset", "number", offset);
      checkByteLength(byteLength);
      return readSigned(this, checkReadOffset(this, offset, byteLength), byteLength, true);
    },
    readIntBE(offset, byteLength) {
      if (offset === undefined) throw invalidArgType("offset", "number", offset);
      checkByteLength(byteLength);
      return readSigned(this, checkReadOffset(this, offset, byteLength), byteLength, false);
    },
    writeUIntLE(value, offset, byteLength) {
      checkByteLength(byteLength);
      return writeInt(this, value, offset, byteLength, true, false, byteLength > 4);
    },
    writeUIntBE(value, offset, byteLength) {
      checkByteLength(byteLength);
      return writeInt(this, value, offset, byteLength, false, false, byteLength > 4);
    },
    writeIntLE(value, offset, byteLength) {
      checkByteLength(byteLength);
      return writeInt(this, value, offset, byteLength, true, true, byteLength > 4);
    },
    writeIntBE(value, offset, byteLength) {
      checkByteLength(byteLength);
      return writeInt(this, value, offset, byteLength, false, true, byteLength > 4);
    },
    readFloatLE(offset) {
      return readFloat(this, offset, true, false);
    },
    readFloatBE(offset) {
      return readFloat(this, offset, false, false);
    },
    readDoubleLE(offset) {
      return readFloat(this, offset, true, true);
    },
    readDoubleBE(offset) {
      return readFloat(this, offset, false, true);
    },
    writeFloatLE(value, offset) {
      return writeFloat(this, value, offset, true, false);
    },
    writeFloatBE(value, offset) {
      return writeFloat(this, value, offset, false, false);
    },
    writeDoubleLE(value, offset) {
      return writeFloat(this, value, offset, true, true);
    },
    writeDoubleBE(value, offset) {
      return writeFloat(this, value, offset, false, true);
    },
    readBigInt64LE(offset) {
      return readBig(this, offset, true, true);
    },
    readBigInt64BE(offset) {
      return readBig(this, offset, false, true);
    },
    readBigUInt64LE(offset) {
      return readBig(this, offset, true, false);
    },
    readBigUInt64BE(offset) {
      return readBig(this, offset, false, false);
    },
    writeBigInt64LE(value, offset) {
      return writeBig(this, value, offset, true, true);
    },
    writeBigInt64BE(value, offset) {
      return writeBig(this, value, offset, false, true);
    },
    writeBigUInt64LE(value, offset) {
      return writeBig(this, value, offset, true, false);
    },
    writeBigUInt64BE(value, offset) {
      return writeBig(this, value, offset, false, false);
    },
  });

  // Fixed-width integer accessors: readUInt8, readInt16LE, writeUInt32BE, ...
  function defineFixedInt(bytes, signed, endian) {
    const little = endian !== "BE";
    const name = `${signed ? "Int" : "UInt"}${bytes * 8}${endian}`;
    const methods = {};
    methods[`read${name}`] = function (offset) {
      const off = checkReadOffset(this, offset, bytes);
      return signed ? readSigned(this, off, bytes, little) : readUnsigned(this, off, bytes, little);
    };
    methods[`write${name}`] = function (value, offset) {
      return writeInt(this, value, offset, bytes, little, signed, false);
    };
    defineMethods(proto, methods);
  }

  for (const signed of [false, true]) {
    defineFixedInt(1, signed, "");
    for (const bytes of [2, 4]) {
      defineFixedInt(bytes, signed, "LE");
      defineFixedInt(bytes, signed, "BE");
    }
  }

  // Lowercase `Uint` aliases (readUint8, writeBigUint64LE, ...).
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!/^(read|write)(Big)?UInt/.test(key)) continue;
    defineMethods(proto, { [key.replace("UInt", "Uint")]: proto[key] });
  }

  // Node's internal per-encoding helpers (used by some libraries directly).
  const sliceEncodings = {
    utf8: "utf8",
    latin1: "latin1",
    ascii: "ascii",
    hex: "hex",
    base64: "base64",
    base64url: "base64url",
    ucs2: "utf16le",
  };
  for (const prefix of Object.keys(sliceEncodings)) {
    const enc = sliceEncodings[prefix];
    defineMethods(proto, {
      [`${prefix}Slice`](start, end) {
        return toStringRange(this, enc, start, end);
      },
      [`${prefix}Write`](string, offset, length) {
        const off = offset === undefined ? 0 : offset;
        const len = length === undefined ? this.length - off : length;
        return writeString(this, string, off, len, enc);
      },
    });
  }

  Object.defineProperty(proto, "parent", {
    configurable: true,
    enumerable: true,
    get() {
      return this instanceof Buffer ? this.buffer : undefined;
    },
  });
  Object.defineProperty(proto, "offset", {
    configurable: true,
    enumerable: true,
    get() {
      return this instanceof Buffer ? this.byteOffset : undefined;
    },
  });

  // ---------------------------------------------------------------------------
  // Module-level helpers
  // ---------------------------------------------------------------------------

  function SlowBuffer(size) {
    return Buffer.allocUnsafeSlow(size);
  }
  SlowBuffer.prototype = Buffer.prototype;
  Object.setPrototypeOf(SlowBuffer, Uint8Array);

  function toBytesView(input) {
    if (isUint8Array(input)) return input;
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (isAnyArrayBuffer(input)) return new Uint8Array(input);
    throw makeError(TypeError, "ERR_INVALID_ARG_TYPE", "First argument must be an ArrayBufferView");
  }

  function isAscii(input) {
    const bytes = toBytesView(input);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) return false;
    }
    return true;
  }

  // Length of a valid UTF-8 sequence starting at `i`, or 0 if invalid.
  function utf8SequenceLength(bytes, i) {
    const b0 = bytes[i];
    if (b0 < 0x80) return 1;
    let need;
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) need = 1;
    else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      if (b0 === 0xe0) lower = 0xa0;
      if (b0 === 0xed) upper = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      if (b0 === 0xf0) lower = 0x90;
      if (b0 === 0xf4) upper = 0x8f;
    } else return 0;
    if (i + need >= bytes.length) return 0;
    const b1 = bytes[i + 1];
    if (b1 < lower || b1 > upper) return 0;
    for (let k = 2; k <= need; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return 0;
    }
    return need + 1;
  }

  function isUtf8(input) {
    const bytes = toBytesView(input);
    let i = 0;
    while (i < bytes.length) {
      const n = utf8SequenceLength(bytes, i);
      if (n === 0) return false;
      i += n;
    }
    return true;
  }

  const globalAtob = typeof atob === "function" ? atob : undefined;
  const globalBtoa = typeof btoa === "function" ? btoa : undefined;

  function atobExport(data) {
    if (arguments.length === 0) throw invalidArgType("input", "string", undefined);
    if (globalAtob) return globalAtob(data);
    return latin1Slice(base64ToBytes(String(data)));
  }

  function btoaExport(data) {
    if (arguments.length === 0) throw invalidArgType("input", "string", undefined);
    if (globalBtoa) return globalBtoa(data);
    return base64Slice(latin1ToBytes(String(data)), false);
  }

  return {
    Buffer,
    SlowBuffer,
    Blob: internal.web && internal.web.Blob,
    File: internal.web && internal.web.File,
    INSPECT_MAX_BYTES,
    kMaxLength,
    kStringMaxLength,
    constants: { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength },
    atob: atobExport,
    btoa: btoaExport,
    isAscii,
    isUtf8,
  };
});
