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

  const DOMException = native.DOMException || class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      Object.defineProperty(this, "name", { value: String(name), configurable: true, writable: true });
      Object.defineProperty(this, "code", { value: DOM_CODES[name] || 0, configurable: true, writable: true });
    }
  };
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

  const TextDecoder = internal.require("text_decoder");

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

  const { toUSVString, initFromObject, convertMethodArgs, inspectParams, urlContext } = internal.require("url_search_params");
  const removeQueryPairs = internal.require("url_pairs");

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
      const str = toUSVString(init);
      this.#list = parseQuery(str.startsWith("?") ? str.slice(1) : str);
    }
    static _attach(params, url) {
      params.#url = url;
    }
    static _reset(params, search) {
      const list = parseQuery(search.startsWith("?") ? search.slice(1) : search);
      params.#list.length = 0;
      for (const pair of list) params.#list.push(pair);
    }
    #update() {
      if (this.#url) internal.urlSetSearchFromParams(this.#url);
    }
    get size() {
      return this.#list.length;
    }
    append(name, value) {
      const [n, val] = convertMethodArgs(() => this.#list, name, value, true);
      this.#list.push([n, val]);
      this.#update();
    }
    delete(name, value) {
      const [n, val] = convertMethodArgs(() => this.#list, name, value);
      removeQueryPairs(this.#list, n, val);
      this.#update();
    }
    get(name) {
      const [n] = convertMethodArgs(() => this.#list, name);
      const hit = this.#list.find(([k]) => k === n);
      return hit ? hit[1] : null;
    }
    getAll(name) {
      const [n] = convertMethodArgs(() => this.#list, name);
      return this.#list.filter(([k]) => k === n).map(([, v]) => v);
    }
    has(name, value) {
      const [n, val] = convertMethodArgs(() => this.#list, name, value);
      return this.#list.some(([k, v]) => k === n && (val === undefined || v === val));
    }
    set(name, value) {
      const [n, val] = convertMethodArgs(() => this.#list, name, value, true);
      const i = this.#list.findIndex(([k]) => k === n);
      if (i < 0) {
        this.#list.push([n, val]);
      } else {
        this.#list[i][1] = val;
        removeQueryPairs(this.#list, n, undefined, i + 1);
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
    [Symbol.for("nodejs.util.inspect.custom")](depth, options, inspect) {
      const fn = typeof inspect === "function" ? inspect : internal.require("inspect").nodeInspect;
      return inspectParams(this.constructor?.name || "URLSearchParams", this.#list, depth ?? null, options, fn);
    }
  }

  // Component array, or undefined when the input doesn't parse.
  const stringifyParams = URLSearchParams.prototype.toString;
  const urlErrors = internal.require("url_errors");
  function parseUrl(input, base) {
    if (base === undefined) return native.urlParse(urlErrors.toString(input));
    return native.urlParse(urlErrors.toString(input), urlErrors.toString(base));
  }

  const URL_FIELDS = ["href", "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash", "origin"];

  class URL {
    #parts;
    #searchParams = null;
    #searchDirty = false;
    constructor(input, base) {
      if (arguments.length === 0) throw urlErrors.missingArguments();
      input = urlErrors.toString(input);
      if (base !== undefined) base = urlErrors.toString(base);
      const parts = parseUrl(input, base);
      if (!parts) throw urlErrors.invalidURL(input, base);
      this.#parts = parts;
    }
    static canParse(input, base = undefined) {
      if (arguments.length === 0) throw urlErrors.missingArguments();
      return parseUrl(input, base) != null;
    }
    static parse(input, base = undefined) {
      if (arguments.length === 0) throw urlErrors.missingArguments();
      input = urlErrors.toString(input);
      if (base !== undefined) base = urlErrors.toString(base);
      try {
        return new URL(input, base);
      } catch {
        return null;
      }
    }
    static _setSearch(url) {
      url.#searchDirty = true;
    }
    #syncSearch() {
      if (!this.#searchDirty) return;
      const parts = native.urlSet(this.#parts[0], "search", stringifyParams.call(this.#searchParams));
      if (!parts) return;
      this.#parts = parts;
      this.#searchDirty = false;
    }
    #set(field, value) {
      value = urlErrors.toString(value);
      if (field !== "search") this.#syncSearch();
      const parts = native.urlSet(this.#parts[0], field, value);
      if (!parts) return;
      this.#parts = parts;
      this.#searchDirty = false;
      if (this.#searchParams && field === "search") URLSearchParams._reset(this.#searchParams, this.#parts[7]);
    }
    get href() {
      this.#syncSearch();
      return this.#parts[0];
    }
    set href(value) {
      value = urlErrors.toString(value);
      const parts = native.urlParse(value);
      if (!parts) throw urlErrors.invalidURL(value);
      this.#parts = parts;
      this.#searchDirty = false;
      if (this.#searchParams) URLSearchParams._reset(this.#searchParams, this.#parts[7]);
    }
    get protocol() {
      this.#syncSearch();
      return this.#parts[1];
    }
    set protocol(v) {
      this.#set("protocol", v);
    }
    get username() {
      this.#syncSearch();
      return this.#parts[2];
    }
    set username(v) {
      this.#set("username", v);
    }
    get password() {
      this.#syncSearch();
      return this.#parts[3];
    }
    set password(v) {
      this.#set("password", v);
    }
    get host() {
      this.#syncSearch();
      return this.#parts[5] ? `${this.#parts[4]}:${this.#parts[5]}` : this.#parts[4];
    }
    set host(v) {
      this.#set("host", v);
    }
    get hostname() {
      this.#syncSearch();
      return this.#parts[4];
    }
    set hostname(v) {
      this.#set("hostname", v);
    }
    get port() {
      this.#syncSearch();
      return this.#parts[5];
    }
    set port(v) {
      this.#set("port", v);
    }
    get pathname() {
      this.#syncSearch();
      return this.#parts[6];
    }
    set pathname(v) {
      this.#set("pathname", v);
    }
    get search() {
      this.#syncSearch();
      return this.#parts[7];
    }
    set search(v) {
      this.#set("search", v);
    }
    get hash() {
      this.#syncSearch();
      return this.#parts[8];
    }
    set hash(v) {
      this.#set("hash", v);
    }
    get origin() {
      this.#syncSearch();
      if (this.#parts[1] === "blob:") {
        const inner = native.urlParse(this.#parts[6]);
        if (inner && inner[1] === "file:") return "file://" + inner[4];
      }
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
      if (options?.showHidden) view[Symbol("context")] = urlContext(this);
      const fn = typeof inspect === "function" ? inspect : internal.require("inspect").bunInspect;
      return "URL " + fn(view, options);
    }
  }
  void URL_FIELDS;

  internal.urlSetSearchFromParams = function (url) {
    URL._setSearch(url);
  };

  // --- events -----------------------------------------------------------------

  const kStop = Symbol("stop");
  const kImmediateStop = Symbol("immediateStop");
  let beginEvent, endEvent, passiveEvent;

  class Event {
    #type;
    #bubbles;
    #cancelable;
    #composed;
    #defaultPrevented = false;
    #timeStamp;
    #dispatching = false;
    #passive = false;
    static {
      beginEvent = event => {
        if (event.#dispatching) {
          const error = new Error(`The event "${event.#type}" is already being dispatched`);
          error.code = "ERR_EVENT_RECURSION";
          throw error;
        }
        event.#dispatching = true;
      };
      endEvent = event => {
        event.#dispatching = false;
        event.#passive = false;
        event[kStop] = false;
        event[kImmediateStop] = false;
      };
      passiveEvent = (event, value) => { event.#passive = value; };
    }
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
      if (this.#cancelable && !this.#passive) this.#defaultPrevented = true;
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

  let targetListeners, targetObserver, observeTarget, isTarget, isSignal, signalAborted, signalReason, addAbortAlgorithm, abortSignal;
  const callListener = Function.prototype.call.bind(Function.prototype.call);
  const protectedListeners = new WeakMap();
  const protectedListener = protectedListeners.get.bind(protectedListeners);
  const protectListener = protectedListeners.set.bind(protectedListeners);

  function eventName(type) {
    return `${type}`;
  }
  function checkEventListener(listener) {
    if (listener == null || typeof listener === "object" || typeof listener === "function") return;
    throw new TypeError("Event listener must be a function or an object");
  }
  function notifyTarget(target, type) {
    const record = targetObserver(target);
    if (!record || !record.callback) return;
    try { callListener(record.callback, undefined, type); }
    catch (error) { internal.nextTick(() => { throw error; }); }
  }
  function removeTargetEntry(target, table, type, entry, notify = true) {
    if (entry.removed) return;
    entry.removed = true;
    const list = table.get(type);
    const index = list ? list.indexOf(entry) : -1;
    if (index >= 0) removeListenerIndex(list, index);
    if (list && list.length === 0) table.delete(type);
    const cleanup = entry.signalCleanup;
    entry.signalCleanup = null;
    if (cleanup) cleanup();
    if (notify) notifyTarget(target, type);
  }
  function removeListenerIndex(list, index) {
    for (let i = index; i + 1 < list.length; i++) list[i] = list[i + 1];
    list.length--;
  }
  function addTargetEntry(table, type, listener, options, protect = false) {
    const list = table.get(type) || [];
    const existing = list.find(entry => entry.kind === "listener" && entry.listener === listener && entry.capture === options.capture);
    if (existing) return existing;
    const entry = { kind: "listener", listener, capture: options.capture, once: options.once, passive: options.passive, removed: false, signalCleanup: null };
    if (protect) protectListener(entry, listener);
    list.push(entry);
    table.set(type, list);
    return entry;
  }
  function setAbortAttribute(target, entry, value) {
    const table = targetListeners(target);
    if (value === null || typeof value !== "object" && typeof value !== "function") {
      if (entry) removeTargetEntry(target, table, "abort", entry, false);
      return null;
    }
    if (entry) { entry.listener = value; return entry; }
    const list = table.get("abort") || [];
    const attribute = { kind: "attribute", listener: value, capture: false, once: false, passive: false, removed: false, signalCleanup: null };
    list.push(attribute);
    table.set("abort", list);
    return attribute;
  }
  function deliverTargetEntry(target, entry, event, listener) {
    if (entry.kind === "attribute" && typeof listener !== "function") return;
    passiveEvent(event, entry.passive);
    try {
      const callback = typeof listener === "function" ? listener : listener.handleEvent;
      if (typeof callback !== "function") throw new TypeError("Event listener handleEvent is not a function");
      callListener(callback, typeof listener === "function" ? target : listener, event);
    } catch (error) {
      internal.nextTick(() => { throw error; });
    } finally {
      passiveEvent(event, false);
    }
  }
  function dispatchTargetEntries(target, table, type, entries, event) {
    for (const entry of entries) {
      const protectedCallback = protectedListener(entry);
      if (entry.removed || event[kImmediateStop] && !protectedCallback) continue;
      if (entry.once) removeTargetEntry(target, table, type, entry);
      deliverTargetEntry(target, entry, event, protectedCallback || entry.listener);
    }
  }
  function dispatchTargetEvent(target, table, event) {
    const type = event.type;
    const entries = (table.get(type) || []).slice();
    if (!(type === "abort" && isSignal(target))) appendDynamicHandler(target, type, entries);
    dispatchTargetEntries(target, table, type, entries, event);
    return !event.defaultPrevented;
  }
  function appendDynamicHandler(target, type, entries) {
    const listener = target["on" + type];
    if (typeof listener === "function") entries.push({ kind: "attribute", listener, once: false, passive: false, removed: false });
  }

  class EventTarget {
    #listeners = new Map();
    #observer = null;
    static {
      targetListeners = target => target.#listeners;
      targetObserver = target => target.#observer;
      observeTarget = (target, callback) => {
        if (!isTarget(target)) throw new TypeError("target must be an EventTarget");
        if (typeof callback !== "function") throw new TypeError("observer must be a function");
        if (target.#observer) throw new TypeError("EventTarget already has an observer");
        const record = { callback };
        target.#observer = record;
        return () => {
          if (target.#observer === record) target.#observer = null;
          record.callback = null;
        };
      };
      isTarget = value => value !== null && (typeof value === "object" || typeof value === "function") && #listeners in value;
    }
    addEventListener(type, listener, options) {
      const table = this.#listeners;
      const name = eventName(type);
      checkEventListener(listener);
      const opts = typeof options === "boolean" ? { capture: options } : options || {};
      const capture = Boolean(opts.capture), once = Boolean(opts.once), passive = Boolean(opts.passive), signal = opts.signal;
      if (signal !== undefined && !isSignal(signal)) throw new TypeError("signal must be an AbortSignal");
      if (listener == null || signal && signalAborted(signal)) return;
      const list = table.get(name);
      if (list && list.some(entry => entry.kind === "listener" && entry.listener === listener && entry.capture === capture)) return;
      const entry = addTargetEntry(table, name, listener, { capture, once, passive });
      if (signal) entry.signalCleanup = addAbortAlgorithm(signal, () => removeTargetEntry(this, table, name, entry));
      notifyTarget(this, name);
    }
    removeEventListener(type, listener, options) {
      const table = this.#listeners;
      const name = eventName(type);
      checkEventListener(listener);
      const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
      const list = table.get(name);
      if (!list) return;
      const entry = list.find(item => item.kind === "listener" && item.listener === listener && item.capture === capture);
      if (entry) removeTargetEntry(this, table, name, entry);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError("Argument 1 ('event') to EventTarget.dispatchEvent must be an instance of Event");
      const table = this.#listeners;
      beginEvent(event);
      try {
        event.target = this;
        event.currentTarget = this;
        event.eventPhase = 2;
        return dispatchTargetEvent(this, table, event);
      } finally {
        endEvent(event);
        event.currentTarget = null;
        event.eventPhase = 0;
      }
    }
  }

  // --- abort ------------------------------------------------------------------

  class AbortSignal extends EventTarget {
    #aborted = false;
    #reason = undefined;
    #algorithms = new Set();
    #onabort = null;
    static {
      isSignal = value => value !== null && (typeof value === "object" || typeof value === "function") && #aborted in value;
      signalAborted = signal => signal.#aborted;
      signalReason = signal => signal.#reason;
      addAbortAlgorithm = (signal, callback) => {
        const entry = { callback, active: true };
        if (signal.#aborted) { callback(); return () => {}; }
        signal.#algorithms.add(entry);
        return () => { entry.active = false; signal.#algorithms.delete(entry); };
      };
      abortSignal = (signal, reason) => {
        if (signal.#aborted) return;
        signal.#aborted = true;
        signal.#reason = reason === undefined ? new DOMException("The operation was aborted.", "AbortError") : reason;
        const algorithms = Array.from(signal.#algorithms);
        signal.#algorithms.clear();
        runAbortAlgorithms(algorithms);
        dispatchAbortEvent(signal, new Event("abort"));
      };
    }
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
    get onabort() {
      return this.#onabort ? this.#onabort.listener : null;
    }
    set onabort(value) {
      const previous = this.#onabort ? this.#onabort.listener : null;
      this.#onabort = setAbortAttribute(this, this.#onabort, value);
      if (previous !== (this.#onabort ? this.#onabort.listener : null)) notifyTarget(this, "abort");
    }
    throwIfAborted() {
      if (this.#aborted) throw this.#reason;
    }
    static _abort(signal, reason) {
      abortSignal(signal, reason);
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
      const sources = new Set();
      for (const source of signals) {
        if (!isSignal(source)) throw new TypeError("Expected an AbortSignal");
        sources.add(source);
      }
      const signal = new AbortSignal(internal);
      const removers = new Set();
      addAbortAlgorithm(signal, () => clearAbortAlgorithms(removers));
      try {
        for (const source of sources) attachAbortSource(signal, source, removers);
      } catch (error) {
        clearAbortAlgorithms(removers);
        throw error;
      }
      return signal;
    }
  }
  Object.defineProperty(AbortSignal.prototype, "onabort", { ...Object.getOwnPropertyDescriptor(AbortSignal.prototype, "onabort"), enumerable: true });

  const dispatchAbortEvent = Function.prototype.call.bind(EventTarget.prototype.dispatchEvent);
  function runAbortAlgorithms(entries) {
    for (const entry of entries) {
      if (!entry.active) continue;
      entry.active = false;
      entry.callback();
    }
  }
  function clearAbortAlgorithms(removers) {
    for (const remove of removers) remove();
    removers.clear();
  }
  function attachAbortSource(signal, source, removers) {
    if (signalAborted(signal)) return;
    if (signalAborted(source)) { abortSignal(signal, signalReason(source)); return; }
    removers.add(addAbortAlgorithm(source, () => abortSignal(signal, signalReason(source))));
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

  internal.eventTargets = {
    isTarget,
    isSignal,
    listeners(target, type) {
      const name = eventName(type);
      return (targetListeners(target).get(name) || []).map(entry => entry.listener);
    },
    count(target, type) {
      const name = eventName(type);
      const list = targetListeners(target).get(name);
      return list ? list.length : 0;
    },
    addAbortListener(signal, listener) {
      const table = targetListeners(signal);
      const before = table.get("abort")?.length || 0;
      addTargetEntry(table, "abort", listener, { capture: false, once: true, passive: false }, true);
      if (table.get("abort").length !== before) notifyTarget(signal, "abort");
      return () => signal.removeEventListener("abort", listener);
    },
    observe: observeTarget,
  };

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

  // Bun's MimeType.rs by_name_static: an exact, case-sensitive match of a few known
  // types gives Bun's canonical value; any other type is only lowercased.
  const canonicalBlobTypes = new Map([
    ["text/plain", "text/plain;charset=utf-8"], ["text/html", "text/html;charset=utf-8"], ["text/css", "text/css;charset=utf-8"],
    ["text/javascript", "text/javascript;charset=utf-8"], ["text/jsx", "text/javascript;charset=utf-8"],
    ["application/javascript", "text/javascript;charset=utf-8"], ["application/json", "application/json;charset=utf-8"],
    ["application/x-www-form-urlencoded", "application/x-www-form-urlencoded;charset=UTF-8"], ["application/webassembly", "application/wasm"],
  ]);
  function normalizeBlobType(type) {
    if (!type) return "";
    const given = String(type);
    return canonicalBlobTypes.get(given) ?? given.toLowerCase();
  }

  class Blob {
    #bytes;
    #type;
    #read;
    constructor(parts = [], options = {}) {
      if (parts !== null && typeof parts === "object" && typeof parts[Symbol.iterator] !== "function") {
        throw new TypeError("new Blob() expects an Array");
      }
      this.#bytes = concatBytes(Array.from(parts || [], partBytes));
      this.#type = normalizeBlobType(options.type);
      // The constructing class's reader, fixed now so a replaced prototype cannot change the bytes.
      this.#read = new.target.prototype._bytes;
    }
    // Subclasses (BunFile) read lazily.
    _bytes() {
      return this.#bytes;
    }
    // Brand-checked bytes that ignore the public prototype; throws TypeError for a non-Blob.
    _intrinsicBytes() {
      const read = this.#read;
      return read === blobBytes ? this.#bytes : Reflect.apply(read, this, []);
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
      return new TextDecoder().decode(this._bytes());
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
      const forms = formBody();
      const encoding = forms.api.encoding(this.type);
      if (!encoding) throw new Error("Invalid encoding");
      return forms.api.parse(this._bytes(), encoding, forms.deps, reason => new Error(`FormData encoding failed: ${reason}`));
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

  const blobBytes = Blob.prototype._bytes;

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

  const bodyStreams = internal.require("body_streams");
  internal.makeByteStream = function makeByteStream(bytes) {
    return bodyStreams.remember(new ReadableStream({
      type: "bytes",
      start(controller) {
        if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }), bytes);
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
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && body instanceof SharedArrayBuffer)) {
      return { bytes: new Uint8Array(toUint8(body)), type: null };
    }
    if (body instanceof FormData) return formBody().api.serialize(body, formBody().deps);
    if (body instanceof ReadableStream) return { stream: bodyStreams.adoptable(body), bytes: bodyStreams.bytes(body) || null, type: null };
    if (typeof body[Symbol.asyncIterator] === "function") return { stream: bodyStreams.fromAsyncIterable(body), type: null };
    return { bytes: native.utf8Encode(String(body)), type: "text/plain;charset=utf-8" };
  }

  async function streamBytes(stream) {
    const chunks = [];
    await bodyStreams.drain(stream, chunk => chunks.push(typeof chunk === "string" ? native.utf8Encode(chunk) : toUint8(chunk)));
    return concatBytes(chunks);
  }

  const BodyMixin = {
    async _consume() {
      if (this.bodyUsed) throw new TypeError("Body already used");
      // Someone else holds the stream's reader: refuse without using the body, as Bun does.
      if (this._stream && this._stream.locked) throw Object.assign(new TypeError("Invalid state: ReadableStream is locked"), { code: "ERR_INVALID_STATE" });
      this._bodyUsed = true;
      if (this._stream) return streamBytes(this._stream);
      return this._body || new Uint8Array(0);
    },
    async text() {
      return new TextDecoder().decode(await this._consume());
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
      const blob = new Blob([await this._consume()]);
      // Bun keeps the Content-Type as written, canonicalizing only its known types.
      blob._setType(canonicalBlobTypes.get(type) ?? type);
      return blob;
    },
    async formData() {
      const forms = formBody();
      const encoding = forms.api.encoding(this.headers.get("content-type"));
      // Bun rejects an undecodable type without using the body; a used body reports that first.
      if (!encoding && !this.bodyUsed) throw formParseError("Can't decode form data from body because of incorrect MIME type/boundary");
      const bytes = await this._consume();
      return forms.api.parse(bytes, encoding, forms.deps, reason => formParseError(`FormData parse error ${reason}`));
    },
    textStream() {
      return bodyStreams.textStream(this);
    },
  };

  function initBody(target, body, headers) {
    const extracted = extractBody(body);
    target._body = extracted.bytes;
    target._stream = extracted.stream || null;
    target._bodyUsed = false;
    if (extracted.type && !headers.has("content-type")) headers.set("content-type", extracted.type);
  }


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
      this._stream = this._bodyUsed ? bodyStreams.consumedStream() : internal.makeByteStream(this._body);
      return this._stream;
    }
    clone() {
      const body = bodyStreams.clone(this);
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
      this.#redirect = init.redirect || (source && source.redirect) || "follow";
      defineInternalBody(this);
      const replacementBody = init.body;
      const body = replacementBody !== undefined ? replacementBody : source ? source._stream || source._body : null;
      if (body !== null && body !== undefined && (this.#method === "GET" || this.#method === "HEAD")) {
        throw new TypeError("Request with a GET or HEAD method cannot have a body.");
      }
      // Fetch forbids keepalive with a stream init.body (a source request's body is fine);
      // Bun reports it before any lock check.
      if (init.keepalive && replacementBody instanceof ReadableStream) throw new TypeError("keepalive");
      initBody(this, source && replacementBody === undefined ? bodyStreams.transfer(source) : body, this.#headers);
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
      this._stream = this._bodyUsed ? bodyStreams.consumedStream() : internal.makeByteStream(this._body);
      return this._stream;
    }
    clone() {
      const body = bodyStreams.clone(this);
      return new Request(this, { body });
    }
    get [Symbol.toStringTag]() {
      return "Request";
    }
  }
  Object.assign(Request.prototype, BodyMixin);

  // No sockets under WASI. file: URLs still work, like in Bun.
  // Arguments are read and checked as Bun does (fetch_args.ts); errors reject.
  async function fetch(input) {
    const parsed = internal.require("fetch_args").parse(arguments, { Request, Headers, AbortSignal, Blob });
    if (parsed.data !== undefined) return fetchDataUrl(parsed.data);
    const { url, init } = parsed;
    input = parsed.request || url;
    if (url.startsWith("file:")) {
      const path = decodeURIComponent(new URL(url).pathname);
      const res = new Response(native.readFile(path), { headers: { "content-type": internal.mimeType(path) } });
      Response._setUrl(res, url);
      return res;
    }
    // Hosts implementing the bun_wasm ABI (docs/host-abi.md) do real HTTP.
    if (native.hostCaps.fetch) return internal.require("net").fetch(input, init);
    const err = new TypeError(`fetch() is not available in bun-wasm: WASI has no network access (${url})`);
    err.code = "ERR_NO_NETWORK";
    throw err;
  }

  function fetchDataUrl(url) {
    const { type, base64, data } = internal.require("fetch_args").dataUrlParts(url);
    const bytes = base64 ? native.base64Decode(data) : native.utf8Encode(decodeURIComponent(data));
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
    mp3: "audio/mpeg", mp4: "video/mp4", woff: "font/woff", woff2: "font/woff2", bin: "application/octet-stream",
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

  const performanceNow = () => internal.fakeTimers?.active ? internal.fakeTimers.elapsedNanoseconds / 1e6 : native.now();

  function markTime(name) {
    if (name === undefined) return performanceNow();
    if (typeof name === "number") return name;
    const mark = perfEntries.findLast((e) => e.entryType === "mark" && e.name === name);
    if (!mark) throw new DOMException(`The mark '${name}' does not exist.`, "SyntaxError");
    return mark.startTime;
  }

  const performance = {
    now: performanceNow,
    get timeOrigin() { return internal.fakeTimers?.timeOrigin ?? timeOrigin; },
    mark(name, options = {}) {
      const entry = new PerformanceEntry(String(name), "mark", options.startTime ?? performanceNow(), 0, options.detail);
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
    toJSON: () => ({ timeOrigin: performance.timeOrigin }),
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
    // Bun has no 65536-byte quota; the Browser host's random_get fills in chunks.
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

  const crypto = { getRandomValues, randomUUID };

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

  // Multipart and urlencoded bodies (form_data_body.ts), loaded on first use.
  let formBodies;
  function formBody() {
    formBodies ??= {
      api: internal.require("form_data_body"),
      deps: {
        FormData, File, URLSearchParams,
        mimeByExtension: extension => (Object.hasOwn(MIME, extension) ? MIME[extension] : undefined),
        blobBytes: blob => blob._intrinsicBytes(),
      },
    };
    return formBodies;
  }

  function formParseError(message) {
    return Object.assign(new TypeError(message), { code: "ERR_FORMDATA_PARSE_ERROR" });
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

  internal.require("web_brand")({ AbortController, AbortSignal, Event, EventTarget, CustomEvent, ErrorEvent, MessageEvent, CloseEvent });

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
    defineLazyGlobal("Worker", () => internal.require("web_worker").Worker);
    const objectURLs = internal.require("object_urls");
    URL.createObjectURL = objectURLs.createObjectURL;
    URL.revokeObjectURL = objectURLs.revokeObjectURL;
    defineLazyGlobal("WebSocket", () => internal.require("net").WebSocket);
  };
})
