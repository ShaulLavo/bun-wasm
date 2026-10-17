// Web platform globals: encoding, URL, events, abort, Blob, fetch types,
// performance, crypto, atob/btoa. Returns an installer.
(function (internal) {
  "use strict";
  const native = internal.native;

  // --- DOMException -----------------------------------------------------------

  const DOM_CODES = {
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
    NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11,
    SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15,
    TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
  };

  class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      Object.defineProperty(this, "name", { value: String(name), configurable: true, writable: true });
      Object.defineProperty(this, "code", { value: DOM_CODES[name] || 0, configurable: true, writable: true });
    }
  }
  internal.DOMException = DOMException;

  // --- encoding ---------------------------------------------------------------

  function toUint8(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) {
      return new Uint8Array(data);
    }
    throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
  }
  internal.toUint8 = toUint8;

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      return native.utf8Encode(String(input));
    }
    encodeInto(source, destination) {
      const str = String(source);
      let read = 0;
      let written = 0;
      // Copy whole code points while they fit.
      for (const ch of str) {
        const bytes = native.utf8Encode(ch);
        if (written + bytes.length > destination.length) break;
        destination.set(bytes, written);
        written += bytes.length;
        read += ch.length;
      }
      return { read, written };
    }
  }

  const DECODER_LABELS = {
    "utf-8": "utf-8", utf8: "utf-8", "unicode-1-1-utf-8": "utf-8",
    "utf-16le": "utf-16le", "utf-16": "utf-16le", ucs2: "utf-16le", "ucs-2": "utf-16le",
    latin1: "windows-1252", "iso-8859-1": "windows-1252", ascii: "windows-1252",
    "us-ascii": "windows-1252", "windows-1252": "windows-1252",
  };

  // Length of an incomplete UTF-8 sequence at the end of `bytes` (0 if none).
  function incompleteUtf8Tail(bytes) {
    const n = bytes.length;
    for (let back = 1; back <= Math.min(3, n); back++) {
      const b = bytes[n - back];
      if ((b & 0xc0) === 0x80) continue;
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return need > back ? back : 0;
    }
    return 0;
  }

  class TextDecoder {
    #encoding;
    #fatal;
    #ignoreBOM;
    #pending = null;
    constructor(label = "utf-8", options = {}) {
      const encoding = DECODER_LABELS[String(label).trim().toLowerCase()];
      if (!encoding) {
        const err = new RangeError(`Unsupported encoding label "${label}"`);
        err.code = "ERR_ENCODING_NOT_SUPPORTED";
        throw err;
      }
      this.#encoding = encoding;
      this.#fatal = Boolean(options.fatal);
      this.#ignoreBOM = Boolean(options.ignoreBOM);
    }
    get encoding() {
      return this.#encoding;
    }
    get fatal() {
      return this.#fatal;
    }
    get ignoreBOM() {
      return this.#ignoreBOM;
    }
    decode(input, options = {}) {
      let bytes = input === undefined ? new Uint8Array(0) : toUint8(input);
      if (this.#pending) {
        const joined = new Uint8Array(this.#pending.length + bytes.length);
        joined.set(this.#pending);
        joined.set(bytes, this.#pending.length);
        bytes = joined;
        this.#pending = null;
      }
      if (options.stream && this.#encoding === "utf-8") {
        const tail = incompleteUtf8Tail(bytes);
        if (tail > 0) {
          this.#pending = bytes.slice(bytes.length - tail);
          bytes = bytes.subarray(0, bytes.length - tail);
        }
      }
      return this.#decodeBytes(bytes);
    }
    #decodeBytes(bytes) {
      if (this.#encoding === "utf-16le") return native.utf16leDecode(bytes.slice());
      if (this.#encoding === "windows-1252") return native.latin1Decode(bytes.slice());
      let text = native.utf8Decode(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice(), this.#fatal);
      if (!this.#ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    }
  }

  // --- base64 -----------------------------------------------------------------

  function btoa(data) {
    if (arguments.length === 0) throw new TypeError("btoa requires 1 argument (a string)");
    const str = String(data);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 0xff) throw new DOMException("The string contains invalid characters.", "InvalidCharacterError");
      bytes[i] = code;
    }
    return native.base64Encode(bytes, false);
  }

  function atob(data) {
    if (arguments.length === 0) throw new TypeError("atob requires 1 argument (a string)");
    let str = String(data).replace(/[\t\n\f\r ]/g, "");
    if (str.length % 4 === 0) str = str.replace(/==?$/, "");
    if (str.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(str)) {
      throw new DOMException("The string contains invalid characters.", "InvalidCharacterError");
    }
    return native.latin1Decode(native.base64Decode(str));
  }

  // --- URLSearchParams / URL --------------------------------------------------

  // application/x-www-form-urlencoded byte serializer.
  function formEncode(str) {
    return encodeURIComponent(str)
      .replace(/%20/g, "+")
      .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }

  function formDecode(str) {
    const spaced = str.replace(/\+/g, " ");
    try {
      return decodeURIComponent(spaced);
    } catch {
      // Malformed escapes are kept literally, byte-wise.
      return spaced.replace(/%([0-9a-fA-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
  }

  function parseQuery(query) {
    const list = [];
    for (const piece of query.split("&")) {
      if (piece === "") continue;
      const eq = piece.indexOf("=");
      const name = eq < 0 ? piece : piece.slice(0, eq);
      const value = eq < 0 ? "" : piece.slice(eq + 1);
      list.push([formDecode(name), formDecode(value)]);
    }
    return list;
  }

  class URLSearchParams {
    #list = [];
    #url = null;
    constructor(init = "") {
      if (init instanceof URLSearchParams) {
        this.#list = init.#list.map(([k, v]) => [k, v]);
        return;
      }
      if (init !== null && typeof init === "object") {
        this.#list = initFromObject(init);
        return;
      }
      const str = String(init);
      this.#list = parseQuery(str.startsWith("?") ? str.slice(1) : str);
    }
    static _attach(params, url) {
      params.#url = url;
    }
    static _reset(params, search) {
      params.#list = parseQuery(search.startsWith("?") ? search.slice(1) : search);
    }
    #update() {
      if (this.#url) internal.urlSetSearchFromParams(this.#url, this.toString());
    }
    get size() {
      return this.#list.length;
    }
    append(name, value) {
      this.#list.push([String(name), String(value)]);
      this.#update();
    }
    delete(name, value) {
      const n = String(name);
      this.#list = this.#list.filter(([k, v]) => k !== n || (value !== undefined && v !== String(value)));
      this.#update();
    }
    get(name) {
      const hit = this.#list.find(([k]) => k === String(name));
      return hit ? hit[1] : null;
    }
    getAll(name) {
      return this.#list.filter(([k]) => k === String(name)).map(([, v]) => v);
    }
    has(name, value) {
      const n = String(name);
      return this.#list.some(([k, v]) => k === n && (value === undefined || v === String(value)));
    }
    set(name, value) {
      const n = String(name);
      const i = this.#list.findIndex(([k]) => k === n);
      if (i < 0) {
        this.#list.push([n, String(value)]);
      } else {
        this.#list[i][1] = String(value);
        this.#list = this.#list.filter(([k], j) => k !== n || j <= i);
      }
      this.#update();
    }
    sort() {
      // Stable sort by UTF-16 code units, as the spec says.
      this.#list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.#update();
    }
    forEach(callback, thisArg) {
      for (const [k, v] of this.#list) callback.call(thisArg, v, k, this);
    }
    *entries() {
      for (const [k, v] of this.#list) yield [k, v];
    }
    *keys() {
      for (const [k] of this.#list) yield k;
    }
    *values() {
      for (const [, v] of this.#list) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this.#list.map(([k, v]) => formEncode(k) + "=" + formEncode(v)).join("&");
    }
    get [Symbol.toStringTag]() {
      return "URLSearchParams";
    }
  }

  function initFromObject(init) {
    if (typeof init[Symbol.iterator] === "function") {
      return Array.from(init, (pair) => {
        const entry = Array.from(pair);
        if (entry.length !== 2) throw new TypeError("Each query pair must be an iterable [name, value] tuple");
        return [String(entry[0]), String(entry[1])];
      });
    }
    return Object.keys(init).map((k) => [k, String(init[k])]);
  }

  // Component array, or undefined when the input doesn't parse.
  function parseUrl(input, base) {
    if (base === undefined) return native.urlParse(String(input));
    return native.urlParse(String(input), String(base));
  }

  const URL_FIELDS = ["href", "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash", "origin"];

  class URL {
    #parts;
    #searchParams = null;
    constructor(input, base) {
      if (arguments.length === 0) throw new TypeError("URL constructor requires at least 1 argument");
      const parts = parseUrl(input, base);
      if (!parts) {
        const err = new TypeError(`"${input}" cannot be parsed as a URL.`);
        err.code = "ERR_INVALID_URL";
        err.input = String(input);
        throw err;
      }
      this.#parts = parts;
    }
    static canParse(input, base) {
      return parseUrl(input, base) != null;
    }
    static parse(input, base) {
      try {
        return new URL(input, base);
      } catch {
        return null;
      }
    }
    static _setSearch(url, query) {
      url.#set("search", query);
    }
    #set(field, value) {
      const parts = native.urlSet(this.#parts[0], field, String(value));
      if (!parts) return;
      this.#parts = parts;
      if (this.#searchParams && field !== "search-from-params") URLSearchParams._reset(this.#searchParams, this.#parts[7]);
    }
    get href() {
      return this.#parts[0];
    }
    set href(value) {
      const parts = native.urlParse(String(value));
      if (!parts) throw new TypeError(`"${value}" cannot be parsed as a URL.`);
      this.#parts = parts;
      if (this.#searchParams) URLSearchParams._reset(this.#searchParams, this.#parts[7]);
    }
    get protocol() {
      return this.#parts[1];
    }
    set protocol(v) {
      this.#set("protocol", v);
    }
    get username() {
      return this.#parts[2];
    }
    set username(v) {
      this.#set("username", v);
    }
    get password() {
      return this.#parts[3];
    }
    set password(v) {
      this.#set("password", v);
    }
    get host() {
      return this.#parts[5] ? `${this.#parts[4]}:${this.#parts[5]}` : this.#parts[4];
    }
    set host(v) {
      this.#set("host", v);
    }
    get hostname() {
      return this.#parts[4];
    }
    set hostname(v) {
      this.#set("hostname", v);
    }
    get port() {
      return this.#parts[5];
    }
    set port(v) {
      this.#set("port", v);
    }
    get pathname() {
      return this.#parts[6];
    }
    set pathname(v) {
      this.#set("pathname", v);
    }
    get search() {
      return this.#parts[7];
    }
    set search(v) {
      this.#set("search", v);
    }
    get hash() {
      return this.#parts[8];
    }
    set hash(v) {
      this.#set("hash", v);
    }
    get origin() {
      return this.#parts[9];
    }
    get searchParams() {
      if (!this.#searchParams) {
        this.#searchParams = new URLSearchParams(this.#parts[7]);
        URLSearchParams._attach(this.#searchParams, this);
      }
      return this.#searchParams;
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
    get [Symbol.toStringTag]() {
      return "URL";
    }
    [Symbol.for("nodejs.util.inspect.custom")](depth, options, inspect) {
      const view = {};
      for (const field of ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "searchParams", "hash"]) {
        view[field] = this[field];
      }
      const fn = typeof inspect === "function" ? inspect : internal.require("inspect").bunInspect;
      return "URL " + fn(view, options);
    }
  }
  void URL_FIELDS;

  internal.urlSetSearchFromParams = function (url, query) {
    const parts = native.urlSet(url.href, "search", query);
    if (parts) URL._setSearch(url, query);
  };

  // --- events -----------------------------------------------------------------

  const kStop = Symbol("stop");
  const kImmediateStop = Symbol("immediateStop");

  class Event {
    #type;
    #bubbles;
    #cancelable;
    #composed;
    #defaultPrevented = false;
    #timeStamp;
    target = null;
    currentTarget = null;
    eventPhase = 0;
    constructor(type, init = {}) {
      if (arguments.length === 0) throw new TypeError("Event constructor requires 1 argument");
      this.#type = String(type);
      this.#bubbles = Boolean(init.bubbles);
      this.#cancelable = Boolean(init.cancelable);
      this.#composed = Boolean(init.composed);
      this.#timeStamp = native.now();
      this[kStop] = false;
      this[kImmediateStop] = false;
    }
    get type() {
      return this.#type;
    }
    get bubbles() {
      return this.#bubbles;
    }
    get cancelable() {
      return this.#cancelable;
    }
    get composed() {
      return this.#composed;
    }
    get defaultPrevented() {
      return this.#defaultPrevented;
    }
    get timeStamp() {
      return this.#timeStamp;
    }
    get isTrusted() {
      return false;
    }
    get returnValue() {
      return !this.#defaultPrevented;
    }
    get cancelBubble() {
      return this[kStop];
    }
    get srcElement() {
      return this.target;
    }
    composedPath() {
      return this.currentTarget ? [this.currentTarget] : [];
    }
    preventDefault() {
      if (this.#cancelable) this.#defaultPrevented = true;
    }
    stopPropagation() {
      this[kStop] = true;
    }
    stopImmediatePropagation() {
      this[kStop] = true;
      this[kImmediateStop] = true;
    }
    initEvent(type, bubbles = false, cancelable = false) {
      this.#type = String(type);
      this.#bubbles = Boolean(bubbles);
      this.#cancelable = Boolean(cancelable);
    }
  }
  Object.assign(Event, { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });

  class CustomEvent extends Event {
    #detail;
    constructor(type, init = {}) {
      super(type, init);
      this.#detail = init.detail === undefined ? null : init.detail;
    }
    get detail() {
      return this.#detail;
    }
  }

  class ErrorEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.message = init.message || "";
      this.filename = init.filename || "";
      this.lineno = init.lineno || 0;
      this.colno = init.colno || 0;
      this.error = init.error;
    }
  }

  class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.code = init.code || 0;
      this.reason = init.reason || "";
      this.wasClean = Boolean(init.wasClean);
    }
  }

  class MessageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.data = init.data === undefined ? null : init.data;
      this.origin = init.origin || "";
      this.lastEventId = init.lastEventId || "";
      this.source = init.source || null;
      this.ports = init.ports || [];
    }
  }

  class EventTarget {
    #listeners = new Map();
    addEventListener(type, listener, options) {
      if (!listener) return;
      const opts = typeof options === "boolean" ? { capture: options } : options || {};
      const list = this.#listeners.get(type) || [];
      if (list.some((l) => l.listener === listener && l.capture === Boolean(opts.capture))) return;
      const entry = { listener, capture: Boolean(opts.capture), once: Boolean(opts.once) };
      list.push(entry);
      this.#listeners.set(type, list);
      if (opts.signal) opts.signal.addEventListener("abort", () => this.removeEventListener(type, listener, opts));
    }
    removeEventListener(type, listener, options) {
      const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
      const list = this.#listeners.get(type);
      if (!list) return;
      const i = list.findIndex((l) => l.listener === listener && l.capture === capture);
      if (i >= 0) list.splice(i, 1);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError("Argument 1 ('event') to EventTarget.dispatchEvent must be an instance of Event");
      event.target = this;
      event.currentTarget = this;
      event.eventPhase = 2;
      const handlerName = "on" + event.type;
      const list = (this.#listeners.get(event.type) || []).slice();
      if (typeof this[handlerName] === "function") list.push({ listener: this[handlerName], once: false, capture: false });
      for (const entry of list) {
        if (entry.once) this.removeEventListener(event.type, entry.listener, entry);
        invokeListener(this, entry.listener, event);
        if (event[kImmediateStop]) break;
      }
      event.currentTarget = null;
      event.eventPhase = 0;
      return !event.defaultPrevented;
    }
  }

  function invokeListener(target, listener, event) {
    try {
      if (typeof listener === "function") listener.call(target, event);
      else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
    } catch (err) {
      // Listener errors are reported, not propagated, like in browsers.
      internal.nextTick(() => {
        throw err;
      });
    }
  }

  // --- abort ------------------------------------------------------------------

  class AbortSignal extends EventTarget {
    #aborted = false;
    #reason = undefined;
    onabort = null;
    constructor(key) {
      super();
      if (key !== internal) throw new TypeError("Illegal constructor");
    }
    get aborted() {
      return this.#aborted;
    }
    get reason() {
      return this.#reason;
    }
    throwIfAborted() {
      if (this.#aborted) throw this.#reason;
    }
    static _abort(signal, reason) {
      if (signal.#aborted) return;
      signal.#aborted = true;
      signal.#reason = reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason;
      signal.dispatchEvent(new Event("abort"));
    }
    static abort(reason) {
      const signal = new AbortSignal(internal);
      AbortSignal._abort(signal, reason);
      return signal;
    }
    static timeout(ms) {
      const signal = new AbortSignal(internal);
      const timer = setTimeout(() => {
        AbortSignal._abort(signal, new DOMException("The operation timed out.", "TimeoutError"));
      }, ms);
      // A pending timeout signal doesn't keep the process alive.
      timer.unref();
      return signal;
    }
    static any(signals) {
      const signal = new AbortSignal(internal);
      for (const source of signals) {
        if (source.aborted) {
          AbortSignal._abort(signal, source.reason);
          return signal;
        }
        source.addEventListener("abort", () => AbortSignal._abort(signal, source.reason), { once: true });
      }
      return signal;
    }
  }

  class AbortController {
    #signal = new AbortSignal(internal);
    get signal() {
      return this.#signal;
    }
    abort(reason) {
      AbortSignal._abort(this.#signal, reason);
    }
  }

  // --- Blob / File ------------------------------------------------------------

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
  internal.concatBytes = concatBytes;

  function partBytes(part) {
    if (part instanceof Blob) return part._bytes();
    if (typeof part === "string") return native.utf8Encode(part);
    if (ArrayBuffer.isView(part) || part instanceof ArrayBuffer) return toUint8(part).slice();
    return native.utf8Encode(String(part));
  }

  // Bun adds the charset to text types: "text/plain" -> "text/plain;charset=utf-8".
  function normalizeBlobType(type) {
    if (!type) return "";
    const lower = String(type).toLowerCase();
    if (lower.startsWith("text/") && !lower.includes("charset")) return lower + ";charset=utf-8";
    return lower;
  }

  class Blob {
    #bytes;
    #type;
    constructor(parts = [], options = {}) {
      if (parts !== null && typeof parts === "object" && typeof parts[Symbol.iterator] !== "function") {
        throw new TypeError("new Blob() expects an Array");
      }
      this.#bytes = concatBytes(Array.from(parts || [], partBytes));
      this.#type = normalizeBlobType(options.type);
    }
    // Subclasses (BunFile) read lazily.
    _bytes() {
      return this.#bytes;
    }
    get size() {
      return this._bytes().length;
    }
    get type() {
      return this.#type;
    }
    _setType(type) {
      this.#type = type;
    }
    async text() {
      return native.utf8Decode(this._bytes());
    }
    async json() {
      return JSON.parse(await this.text());
    }
    async arrayBuffer() {
      const bytes = this._bytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    async bytes() {
      return this._bytes().slice();
    }
    async formData() {
      throw new TypeError("Blob.formData() is not supported in bun-wasm");
    }
    slice(start = 0, end = undefined, type = "") {
      const bytes = this._bytes();
      const blob = new Blob([bytes.slice(start, end)], { type });
      return blob;
    }
    stream() {
      return internal.makeByteStream(this._bytes());
    }
    get [Symbol.toStringTag]() {
      return "Blob";
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return `Blob (${formatBytes(this.size)})`;
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} bytes`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(2).replace(/\.?0+$/, "")} KB`;
    return `${(n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "")} MB`;
  }
  internal.formatBytes = formatBytes;

  class File extends Blob {
    #name;
    #lastModified;
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.#name = String(name);
      this.#lastModified = options.lastModified === undefined ? Date.now() : Number(options.lastModified);
    }
    get name() {
      return this.#name;
    }
    get lastModified() {
      return this.#lastModified;
    }
    get [Symbol.toStringTag]() {
      return "File";
    }
  }

  const streamWeb = internal.require("streams");
  const { ReadableStream } = streamWeb;

  internal.makeByteStream = function makeByteStream(bytes) {
    return new ReadableStream({
      type: "bytes",
      start(controller) {
        if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  };

  // --- Headers / Request / Response -------------------------------------------

  function normalizeHeaderName(name) {
    const n = String(name);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(n)) throw new TypeError(`Invalid header name: '${n}'`);
    return n.toLowerCase();
  }

  class Headers {
    #map = new Map();
    #cookies = [];
    constructor(init) {
      if (init === undefined || init === null) return;
      if (init instanceof Headers) {
        for (const [k, v] of init) this.append(k, v);
        for (const c of init.getSetCookie()) this.#cookies.push(c);
        return;
      }
      if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          const entry = Array.from(pair);
          if (entry.length !== 2) throw new TypeError("Header pairs must contain exactly two items");
          this.append(entry[0], entry[1]);
        }
        return;
      }
      for (const key of Object.keys(init)) this.append(key, init[key]);
    }
    append(name, value) {
      const key = normalizeHeaderName(name);
      const v = String(value).trim();
      if (key === "set-cookie") {
        this.#cookies.push(v);
        return;
      }
      const prev = this.#map.get(key);
      this.#map.set(key, prev === undefined ? v : `${prev}, ${v}`);
    }
    set(name, value) {
      const key = normalizeHeaderName(name);
      if (key === "set-cookie") {
        this.#cookies = [String(value).trim()];
        return;
      }
      this.#map.set(key, String(value).trim());
    }
    get(name) {
      const key = normalizeHeaderName(name);
      if (key === "set-cookie") return this.#cookies.length ? this.#cookies.join(", ") : null;
      const v = this.#map.get(key);
      return v === undefined ? null : v;
    }
    getAll(name) {
      return normalizeHeaderName(name) === "set-cookie" ? this.#cookies.slice() : [this.get(name)].filter((v) => v !== null);
    }
    getSetCookie() {
      return this.#cookies.slice();
    }
    has(name) {
      const key = normalizeHeaderName(name);
      return key === "set-cookie" ? this.#cookies.length > 0 : this.#map.has(key);
    }
    delete(name) {
      const key = normalizeHeaderName(name);
      if (key === "set-cookie") this.#cookies = [];
      else this.#map.delete(key);
    }
    get count() {
      return this.#map.size + this.#cookies.length;
    }
    forEach(callback, thisArg) {
      for (const [k, v] of this) callback.call(thisArg, v, k, this);
    }
    *entries() {
      const names = Array.from(this.#map.keys()).concat(this.#cookies.length ? ["set-cookie"] : []).sort();
      for (const name of names) {
        if (name === "set-cookie") {
          for (const c of this.#cookies) yield [name, c];
          continue;
        }
        yield [name, this.#map.get(name)];
      }
    }
    *keys() {
      for (const [k] of this.entries()) yield k;
    }
    *values() {
      for (const [, v] of this.entries()) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toJSON() {
      const out = {};
      for (const [k, v] of this) out[k] = v;
      return out;
    }
    get [Symbol.toStringTag]() {
      return "Headers";
    }
  }

  // Body helpers shared by Request and Response.
  function extractBody(body) {
    if (body === undefined || body === null) return { bytes: null, type: null };
    if (typeof body === "string") return { bytes: native.utf8Encode(body), type: "text/plain;charset=utf-8" };
    if (body instanceof URLSearchParams) {
      return { bytes: native.utf8Encode(body.toString()), type: "application/x-www-form-urlencoded;charset=UTF-8" };
    }
    if (body instanceof Blob) return { bytes: body._bytes(), type: body.type || null };
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return { bytes: new Uint8Array(toUint8(body)), type: null };
    if (body instanceof ReadableStream) return { stream: body, bytes: null, type: null };
    return { bytes: native.utf8Encode(String(body)), type: "text/plain;charset=utf-8" };
  }

  async function streamBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(typeof chunk === "string" ? native.utf8Encode(chunk) : toUint8(chunk));
    return concatBytes(chunks);
  }

  const BodyMixin = {
    async _consume() {
      if (this.bodyUsed) throw new TypeError("Body already used");
      this._bodyUsed = true;
      if (this._stream) return streamBytes(this._stream);
      return this._body || new Uint8Array(0);
    },
    async text() {
      return native.utf8Decode(await this._consume());
    },
    async json() {
      return JSON.parse(await this.text());
    },
    async arrayBuffer() {
      const bytes = await this._consume();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async bytes() {
      return (await this._consume()).slice();
    },
    async blob() {
      const type = this.headers.get("content-type") || "";
      return new Blob([await this._consume()], { type });
    },
    async formData() {
      throw new TypeError("formData() is not supported in bun-wasm");
    },
  };

  function initBody(target, body, headers) {
    const extracted = extractBody(body);
    target._body = extracted.bytes;
    target._stream = extracted.stream || null;
    target._bodyUsed = false;
    if (extracted.type && !headers.has("content-type")) headers.set("content-type", extracted.type);
  }

  const STATUS_TEXT = { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error" };

  class Response {
    #status;
    #statusText;
    #headers;
    #type = "default";
    #url = "";
    #redirected = false;
    constructor(body = null, init = {}) {
      const status = init.status === undefined ? 200 : Number(init.status);
      if (!(status >= 200 && status <= 599)) {
        throw new RangeError(`The status provided (${status}) must be 200 or between 201 and 599`);
      }
      this.#status = status;
      this.#statusText = init.statusText === undefined ? "" : String(init.statusText);
      this.#headers = new Headers(init.headers);
      defineInternalBody(this);
      initBody(this, body, this.#headers);
    }
    static json(data, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json;charset=utf-8");
      return new Response(JSON.stringify(data), Object.assign({}, init, { headers }));
    }
    static redirect(url, status = 302) {
      const res = new Response(null, { status, headers: { location: String(url) } });
      return res;
    }
    static error() {
      const res = new Response(null, { status: 200 });
      res.#type = "error";
      res.#status = 0;
      return res;
    }
    static _setUrl(res, url) {
      res.#url = url;
    }
    // A response that came over the network (see net.js).
    static _setNetwork(res, url, redirected) {
      res.#url = url;
      res.#redirected = redirected;
      res.#type = "basic";
    }
    get status() {
      return this.#status;
    }
    get statusText() {
      return this.#statusText;
    }
    get ok() {
      return this.#status >= 200 && this.#status < 300;
    }
    get headers() {
      return this.#headers;
    }
    get type() {
      return this.#type;
    }
    get url() {
      return this.#url;
    }
    get redirected() {
      return this.#redirected;
    }
    get bodyUsed() {
      return this._bodyUsed || Boolean(this._stream && this._stream._disturbed);
    }
    get body() {
      if (this._stream) return this._stream;
      if (this._body === null) return null;
      this._stream = internal.makeByteStream(this._body);
      return this._stream;
    }
    clone() {
      if (this.bodyUsed || this._stream?.locked) throw new TypeError("Body already used");
      let body = this._body;
      if (this._stream) [this._stream, body] = this._stream.tee();
      const copy = new Response(body, { status: this.#status, statusText: this.#statusText, headers: this.#headers });
      copy.#url = this.#url;
      return copy;
    }
    get [Symbol.toStringTag]() {
      return "Response";
    }
  }
  Object.assign(Response.prototype, BodyMixin);

  function defineInternalBody(target) {
    for (const key of ["_body", "_stream", "_bodyUsed"]) {
      Object.defineProperty(target, key, { value: null, writable: true, enumerable: false, configurable: true });
    }
  }

  class Request {
    #url;
    #method;
    #headers;
    #signal;
    #redirect;
    constructor(input, init = {}) {
      const source = input instanceof Request ? input : null;
      const url = source ? source.url : String(input);
      if (!URL.canParse(url)) throw new TypeError(`Invalid URL: "${url}"`);
      this.#url = new URL(url).href;
      this.#method = String(init.method || (source && source.method) || "GET").toUpperCase();
      this.#headers = new Headers(init.headers || (source && source.headers));
      this.#signal = init.signal || (source && source.signal) || new AbortController().signal;
      this.#redirect = init.redirect || "follow";
      defineInternalBody(this);
      const body = init.body !== undefined ? init.body : source ? source._body : null;
      if (body !== null && body !== undefined && (this.#method === "GET" || this.#method === "HEAD")) {
        throw new TypeError("Request with a GET or HEAD method cannot have a body.");
      }
      initBody(this, body, this.#headers);
    }
    get url() {
      return this.#url;
    }
    get method() {
      return this.#method;
    }
    get headers() {
      return this.#headers;
    }
    get signal() {
      return this.#signal;
    }
    get redirect() {
      return this.#redirect;
    }
    get bodyUsed() {
      return this._bodyUsed || Boolean(this._stream && this._stream._disturbed);
    }
    get body() {
      if (this._stream) return this._stream;
      if (this._body === null) return null;
      this._stream = internal.makeByteStream(this._body);
      return this._stream;
    }
    clone() {
      if (this.bodyUsed || this._stream?.locked) throw new TypeError("Body already used");
      let body = this._body;
      if (this._stream) [this._stream, body] = this._stream.tee();
      return new Request(this, { body });
    }
    get [Symbol.toStringTag]() {
      return "Request";
    }
  }
  Object.assign(Request.prototype, BodyMixin);

  // No sockets under WASI. file: URLs still work, like in Bun.
  async function fetch(input, init = {}) {
    const url = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input);
    if (url.startsWith("file:")) {
      const path = decodeURIComponent(new URL(url).pathname);
      const res = new Response(native.readFile(path), { headers: { "content-type": internal.mimeType(path) } });
      Response._setUrl(res, url);
      return res;
    }
    if (url.startsWith("data:")) return fetchDataUrl(url);
    // Hosts implementing the bun_wasm ABI (docs/host-abi.md) do real HTTP.
    if (native.hostCaps.fetch) return internal.require("net").fetch(input, init);
    const err = new TypeError(`fetch() is not available in bun-wasm: WASI has no network access (${url})`);
    err.code = "ERR_NO_NETWORK";
    throw err;
  }

  function fetchDataUrl(url) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);
    const isBase64 = meta.endsWith(";base64");
    const type = (isBase64 ? meta.slice(0, -7) : meta) || "text/plain;charset=US-ASCII";
    const bytes = isBase64 ? native.base64Decode(data) : native.utf8Encode(decodeURIComponent(data));
    return new Response(bytes, { headers: { "content-type": type } });
  }

  const MIME = {
    txt: "text/plain;charset=utf-8", md: "text/markdown;charset=utf-8", html: "text/html;charset=utf-8",
    htm: "text/html;charset=utf-8", css: "text/css;charset=utf-8", js: "text/javascript;charset=utf-8",
    mjs: "text/javascript;charset=utf-8", cjs: "text/javascript;charset=utf-8", ts: "text/javascript;charset=utf-8",
    tsx: "text/javascript;charset=utf-8", jsx: "text/javascript;charset=utf-8", json: "application/json;charset=utf-8",
    toml: "application/toml", xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", wasm: "application/wasm",
    pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", csv: "text/csv;charset=utf-8",
    mp3: "audio/mpeg", mp4: "video/mp4", woff: "font/woff", woff2: "font/woff2",
  };
  internal.mimeType = function mimeType(path) {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
    return MIME[ext] || "application/octet-stream";
  };

  // --- performance ------------------------------------------------------------

  const timeOrigin = native.timeOrigin();
  const perfEntries = [];

  class PerformanceEntry {
    constructor(name, entryType, startTime, duration, detail) {
      this.name = name;
      this.entryType = entryType;
      this.startTime = startTime;
      this.duration = duration;
      this.detail = detail === undefined ? null : detail;
    }
    toJSON() {
      return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration, detail: this.detail };
    }
  }

  function markTime(name) {
    if (name === undefined) return native.now();
    if (typeof name === "number") return name;
    const mark = perfEntries.findLast((e) => e.entryType === "mark" && e.name === name);
    if (!mark) throw new DOMException(`The mark '${name}' does not exist.`, "SyntaxError");
    return mark.startTime;
  }

  const performance = {
    now: () => native.now(),
    timeOrigin,
    mark(name, options = {}) {
      const entry = new PerformanceEntry(String(name), "mark", options.startTime ?? native.now(), 0, options.detail);
      perfEntries.push(entry);
      return entry;
    },
    measure(name, start, end) {
      const opts = start !== null && typeof start === "object" ? start : null;
      const startTime = markTime(opts ? opts.start : start) || 0;
      const endTime = markTime(opts ? opts.end : end);
      const entry = new PerformanceEntry(String(name), "measure", startTime, endTime - startTime, opts && opts.detail);
      perfEntries.push(entry);
      return entry;
    },
    getEntries: () => perfEntries.slice(),
    getEntriesByName: (name, type) => perfEntries.filter((e) => e.name === name && (!type || e.entryType === type)),
    getEntriesByType: (type) => perfEntries.filter((e) => e.entryType === type),
    clearMarks(name) {
      removeEntries("mark", name);
    },
    clearMeasures(name) {
      removeEntries("measure", name);
    },
    toJSON: () => ({ timeOrigin }),
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    timerify: (fn) => fn,
  };

  function removeEntries(type, name) {
    for (let i = perfEntries.length - 1; i >= 0; i--) {
      const e = perfEntries[i];
      if (e.entryType === type && (name === undefined || e.name === name)) perfEntries.splice(i, 1);
    }
  }

  // --- crypto -----------------------------------------------------------------

  function getRandomValues(array) {
    if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array || array instanceof DataView) {
      throw new DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError");
    }
    if (array.byteLength > 65536) {
      throw new DOMException(`The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (65536)`, "QuotaExceededError");
    }
    toUint8(array).set(native.randomBytes(array.byteLength));
    return array;
  }

  function hex(bytes) {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }
  internal.hex = hex;

  function randomUUID() {
    const b = native.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  internal.randomUUID = randomUUID;

  const subtle = {
    async digest(algorithm, data) {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      const digest = native.hash(String(name), toUint8(data).slice());
      return digest.buffer;
    },
  };
  for (const op of ["encrypt", "decrypt", "sign", "verify", "generateKey", "deriveKey", "deriveBits", "importKey", "exportKey", "wrapKey", "unwrapKey"]) {
    subtle[op] = () => Promise.reject(new DOMException(`crypto.subtle.${op} is not supported in bun-wasm`, "NotSupportedError"));
  }

  const crypto = { getRandomValues, randomUUID, subtle };

  // --- FormData / MessageChannel / navigator ----------------------------------

  class FormData {
    #entries = [];
    append(name, value, filename) {
      this.#entries.push([String(name), toFormValue(value, filename)]);
    }
    set(name, value, filename) {
      const n = String(name);
      this.#entries = this.#entries.filter(([k]) => k !== n);
      this.#entries.push([n, toFormValue(value, filename)]);
    }
    get(name) {
      const hit = this.#entries.find(([k]) => k === String(name));
      return hit ? hit[1] : null;
    }
    getAll(name) {
      return this.#entries.filter(([k]) => k === String(name)).map(([, v]) => v);
    }
    has(name) {
      return this.#entries.some(([k]) => k === String(name));
    }
    delete(name) {
      this.#entries = this.#entries.filter(([k]) => k !== String(name));
    }
    forEach(callback, thisArg) {
      for (const [k, v] of this.#entries) callback.call(thisArg, v, k, this);
    }
    *entries() {
      yield* this.#entries.map(([k, v]) => [k, v]);
    }
    *keys() {
      for (const [k] of this.#entries) yield k;
    }
    *values() {
      for (const [, v] of this.#entries) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get [Symbol.toStringTag]() {
      return "FormData";
    }
  }

  function toFormValue(value, filename) {
    if (value instanceof Blob) {
      if (value instanceof File && filename === undefined) return value;
      return new File([value._bytes()], filename === undefined ? "blob" : String(filename), { type: value.type });
    }
    return String(value);
  }

  const navigator = {
    userAgent: `Bun/${native.platformInfo.version}`,
    hardwareConcurrency: 1,
    platform: `Linux ${native.platformInfo.arch}`,
    language: "en-US",
    languages: ["en-US"],
    onLine: false,
  };

  // --- install ----------------------------------------------------------------

  internal.web = { Blob, File, Headers, Request, Response, URL, URLSearchParams, Event, EventTarget, DOMException, AbortController, AbortSignal, TextEncoder, TextDecoder, ReadableStream, performance, crypto, fetch };

  return function install(defineGlobal, defineLazyGlobal) {
    const globals = {
      DOMException, TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, Event, CustomEvent,
      ErrorEvent, MessageEvent, CloseEvent, EventTarget, AbortController, AbortSignal, Blob, File, Headers,
      Request, Response, fetch, ReadableStream, performance, crypto, FormData, navigator,
    };
    Object.assign(globals, streamWeb);
    for (const name of Object.keys(globals)) defineGlobal(name, globals[name]);
    for (const name of ["MessageChannel", "MessagePort", "BroadcastChannel"]) {
      defineLazyGlobal(name, () => internal.require("worker_threads")[name]);
    }
    defineLazyGlobal("WebSocket", () => internal.require("net").WebSocket);
  };
})
