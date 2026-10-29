import { createScriptEvaluation } from "./script-evaluation.ts";
import { observePromise } from "./promise-reactions.ts";
import { installNativeStreamState } from "./native-stream-state.ts";
import { oversizedCryptoInput } from "./crypto-inputs.js";
import { installHostCrypto } from "./crypto-host.js";
import { memoryViews } from "waffle/core/memory-views";
import { isWasmMemoryBuffer, transferArrayBuffers } from "./buffer-transfer.ts";
import { ContentModules } from "./content-modules.ts";
import { SLOT_NAMES } from "./net/trampoline.ts";
import { trackLookup } from "./net/lookup.ts";
import { bindSharedObjectHost } from "./shared-objects/host.ts";

// The host engine (docs/engine-browser.md): run bun-wasm's runtime on the JS engine of
// whatever runs this file (a browser Web Worker: V8 or JavaScriptCore with JIT; Node for
// headless tests). bun-browser.wasm (cargo feature engine-host) keeps doing what is real Bun:
// transpiling, module resolution, `bun build`, sqlite, and every Rust native. This file:
//
// - calls those natives through the wasm's exports (arguments and results in a small binary
//   encoding mirrored in crates/bunwasm-runtime/src/engine_host.rs),
// - implements the natives that need engine values (module loading, eval, promise/proxy
//   introspection) on the host engine,
// - evaluates the runtime's JS polyfills (src/js/*.js, served by the wasm) natively,
// - loads ES modules natively: each file becomes a blob: (browser) or data: (Node) URL whose
//   import specifiers point at its dependencies' URLs, so live bindings, top-level await and
//   import.meta are the engine's own,
// - and drives the runtime's event loop from the host's (timers on setTimeout/MessageChannel,
//   microtasks native).
//
// Plain JS (no TypeScript) so Node can import it directly.

// The host's own versions of what the polyfills replace on globalThis.
/** Capability flags the host answers for; the wasm owns all the others. */
const NETWORK_CAPS = new Set(SLOT_NAMES);
const nativeSubtleCrypto = globalThis.crypto?.subtle;
const NativeDOMException = globalThis.DOMException;
const NativeCryptoKey = globalThis.CryptoKey;
const NativeSubtleCrypto = globalThis.SubtleCrypto;
const nativeSubtleOperations = nativeSubtleCrypto && Object.fromEntries(
  ["digest", "generateKey", "importKey", "exportKey", "sign", "verify", "encrypt", "decrypt", "deriveBits", "deriveKey", "wrapKey", "unwrapKey"]
    .map(name => [name, nativeSubtleCrypto[name]]),
);
const NativeTextEncoder = globalThis.TextEncoder;
const NativeTextDecoder = globalThis.TextDecoder;
const NativeBlob = globalThis.Blob;
const nativeCreateObjectURL = globalThis.URL && globalThis.URL.createObjectURL ? globalThis.URL.createObjectURL.bind(globalThis.URL) : null;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeDateNow = globalThis.Date.now.bind(globalThis.Date);
const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

// A `for await` loop's iterator record, made by `__bunwasm_iterate` with the
// reads and calls of GetIterator(iterable, async) and given to the loop in
// place of the iterable; a sync iterable stays sync, so the engine still
// adapts it. It notes the frame once `next()` or `return()` has returned,
// right before the loop's implicit await suspends: an async iterator method
// that throws synchronously leaves nothing pending. The engine's adapter for
// a sync iterator turns such a throw into a rejection the loop awaits, and
// awaits on close even without `return`, so a sync record notes the frame in
// those cases too. A frame already pending (a sync iterator closed because
// its value rejected) is kept.
const noFrame = Symbol("no frame");
function iteratorMethod(iterable, key) {
  const method = iterable[key];
  if (method === undefined || method === null) return undefined;
  if (typeof method !== "function") throw new TypeError(`${String(key)} is not a function`);
  return method;
}
function forAwaitRecord(iterable, frame) {
  const asyncMethod = iteratorMethod(iterable, Symbol.asyncIterator);
  const key = asyncMethod ? Symbol.asyncIterator : Symbol.iterator;
  const method = asyncMethod ?? iteratorMethod(iterable, Symbol.iterator);
  if (method === undefined) throw new TypeError("object is not async iterable");
  const iterator = Reflect.apply(method, iterable, []);
  if ((typeof iterator !== "object" || iterator === null) && typeof iterator !== "function") {
    throw new TypeError(`Result of the ${String(key)} method is not an object`);
  }
  const next = iterator.next;
  const sync = key === Symbol.iterator;
  const note = () => {
    if (record.pending === noFrame) record.pending = frame();
  };
  const call = (method) => {
    if (!sync) {
      const result = Reflect.apply(method, iterator, []);
      note();
      return result;
    }
    try {
      return Reflect.apply(method, iterator, []);
    } finally {
      note();
    }
  };
  const record = {
    pending: noFrame,
    next: () => call(next),
    get return() {
      const close = iterator.return;
      if (typeof close === "function") return () => call(close);
      if (sync) note();
      return close;
    },
  };
  return Object.defineProperty(Object.setPrototypeOf(record, null), key, { value: () => record });
}
const nativeGc = typeof globalThis.gc === "function" ? globalThis.gc.bind(globalThis) : null;
const nativeAtomicsLoad = Atomics.load;
const nativeWaitAsync = typeof Atomics.waitAsync === "function" ? Atomics.waitAsync : null;
const NativeMessageChannel = globalThis.MessageChannel;
const NativeAbortController = globalThis.AbortController;
const NativePromise = globalThis.Promise;
const nativePromiseThen = Function.prototype.call.bind(NativePromise.prototype.then);
const nativePromiseHasInstance = Function.prototype.call.bind(Function.prototype[Symbol.hasInstance], NativePromise);
const NativeString = globalThis.String;
const PENDING = Object.freeze({ state: "pending", value: undefined });
const nativeProcess = typeof process === "object" && process && process.versions && process.versions.node ? process : null;
const nativeAddEventListener = typeof globalThis.addEventListener === "function" ? globalThis.addEventListener.bind(globalThis) : null;

const utf8 = new NativeTextEncoder();
const fromUtf8 = new NativeTextDecoder();
const wireFromUtf8 = new NativeTextDecoder("utf-8", { ignoreBOM: true });

// --- the value encoding (engine_host.rs encode/decode) ------------------------------------

const T = { UNDEFINED: 0, NULL: 1, FALSE: 2, TRUE: 3, NUM: 4, STR: 5, BYTES: 6, ARRAY: 7, OBJECT: 8, BIGINT: 9, BIGUINT: 10 };
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

class Writer {
  constructor() {
    this.buf = new Uint8Array(256);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  room(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  byte(b) {
    this.room(1);
    this.buf[this.len++] = b;
  }
  u32(n) {
    this.room(4);
    this.view.setUint32(this.len, n, true);
    this.len += 4;
  }
  bytes(b) {
    this.u32(b.length);
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  value(v) {
    switch (typeof v) {
      case "undefined":
        return this.byte(T.UNDEFINED);
      case "boolean":
        return this.byte(v ? T.TRUE : T.FALSE);
      case "number":
        this.byte(T.NUM);
        this.room(8);
        this.view.setFloat64(this.len, v, true);
        this.len += 8;
        return undefined;
      case "string":
        this.byte(T.STR);
        return this.bytes(utf8.encode(v));
      case "bigint":
        return this.bigint(v);
      case "object":
        return this.object(v);
      default:
        return this.byte(T.UNDEFINED);
    }
  }
  bigint(v) {
    const signed = v >= I64_MIN && v <= I64_MAX;
    this.byte(signed ? T.BIGINT : T.BIGUINT);
    this.room(8);
    if (signed) this.view.setBigInt64(this.len, v, true);
    else this.view.setBigUint64(this.len, BigInt.asUintN(64, v), true);
    this.len += 8;
  }
  object(v) {
    if (v === null) return this.byte(T.NULL);
    if (v instanceof Uint8Array) {
      this.byte(T.BYTES);
      return this.bytes(v);
    }
    if (ArrayBuffer.isView(v)) {
      this.byte(T.BYTES);
      return this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }
    if (v instanceof ArrayBuffer) {
      this.byte(T.BYTES);
      return this.bytes(new Uint8Array(v));
    }
    if (Array.isArray(v)) {
      this.byte(T.ARRAY);
      this.u32(v.length);
      for (const item of v) this.value(item);
      return undefined;
    }
    const keys = Object.keys(v);
    this.byte(T.OBJECT);
    this.u32(keys.length);
    for (const k of keys) {
      this.bytes(utf8.encode(k));
      this.value(v[k]);
    }
    return undefined;
  }
}

class Reader {
  constructor(bytes, view, pos) {
    this.bytes = bytes;
    this.view = view;
    this.pos = pos;
  }
  u32() {
    const n = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return n;
  }
  raw() {
    const n = this.u32();
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  value() {
    const tag = this.bytes[this.pos++];
    switch (tag) {
      case T.NULL:
        return null;
      case T.FALSE:
        return false;
      case T.TRUE:
        return true;
      case T.NUM: {
        const n = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return n;
      }
      case T.BIGINT: {
        const n = this.view.getBigInt64(this.pos, true);
        this.pos += 8;
        return n;
      }
      case T.BIGUINT: {
        const n = this.view.getBigUint64(this.pos, true);
        this.pos += 8;
        return n;
      }
      case T.STR:
        return wireFromUtf8.decode(this.raw().slice());
      case T.BYTES:
        // Copied out: wasm memory can grow (and detach) on the next call.
        return this.raw().slice();
      case T.ARRAY: {
        const n = this.u32();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.value();
        return out;
      }
      case T.OBJECT: {
        const n = this.u32();
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = wireFromUtf8.decode(this.raw().slice());
          out[k] = this.value();
        }
        return out;
      }
      default:
        return undefined;
    }
  }
}

// --- calling the wasm --------------------------------------------------------------------

function wasmCaller(exports) {
  const memory = memoryViews(exports.memory);
  const result = () => {
    const ptr = exports.bunwasm_result_ptr();
    return new Reader(memory.bytes(), memory.view(), ptr).value();
  };
  function call(index, args) {
    const w = new Writer();
    w.value(args);
    const ptr = exports.bunwasm_alloc(w.len);
    memory.bytes().set(w.buf.subarray(0, w.len), ptr);
    const status = exports.bunwasm_call(index, ptr, w.len);
    const value = result();
    if (status !== 0) throw nativeError(value);
    return value;
  }
  function describe() {
    exports.bunwasm_describe();
    return result();
  }
  return { call, describe };
}

const ERRORS = { Error, TypeError, RangeError, SyntaxError };

function nativeError(info) {
  const Ctor = ERRORS[info.kind] || Error;
  const err = new Ctor(info.message);
  for (const [k, v] of Object.entries(info.props || {})) {
    if (k === "name") Object.defineProperty(err, "name", { value: v, writable: true, configurable: true });
    else err[k] = v;
  }
  if (info.name) Object.defineProperty(err, "name", { value: info.name, writable: true, configurable: true });
  return err;
}

// Thrown to unwind after process.exit; never reported.
class ExitSignal {
  constructor(code) {
    this.code = code;
  }
}

/**
 * Run the program bun-browser.wasm set up (after its `_start` returned with
 * `bunwasm_ready() === 1`) on this JS engine.
 * @param {object} o
 * @param {WebAssembly.Instance} o.instance
 * @param {"blob" | "data"} o.moduleUrls  how module sources become importable URLs without o.modules
 * @param {{url(key: string): string, put(url: string, source: string): void | Promise<void>}} [o.modules]
 *   a module store: named URLs the host's module loader serves from what was
 *   put (a service worker, Node's module hooks). Needed for import cycles.
 * @param {(code: number) => void} o.onExit  called once when the program ends
 * @param {typeof fetch} [o.fetch]  the host's fetch, for user code when o.net has no fetch (else fetch rejects)
 * @param {{natives: object, caps: Record<string, boolean>, onNews(cb: () => void): void}} [o.net]
 *   networking: the bun_wasm ABI (docs/host-abi.md) as the JS functions net.js
 *   calls (hostListen, hostRead, …), which slots they cover, and a way to be
 *   told when any handle may have changed
 * @param {{setRawMode(raw: boolean): string | undefined}} [o.terminal]  the attached terminal
 *   session's input mode, when this process reads keyboard input
 * @param {Int32Array} [o.processWake]  the process wake word that pipe and child changes publish on;
 *   the loop waits on it while the program waits on I/O
 * @param {import("./shared-objects/service").SharedObjectService} [o.sharedObjects] private backing transport
 * @returns {Promise<number>} the exit code (if onExit returns)
 */
export function startEngineHost(o) {
  return new Promise((resolve) => {
    try {
      const host = new EngineHost(o, resolve);
      host.disposeNativeStreams = installNativeStreamState();
      host.start();
    } catch (error) { o.sharedObjects?.close(); throw error; }
  });
}

class EngineHost {
  constructor(o, resolve) {
    this.o = o;
    this.resolveDone = resolve;
    this.wasm = wasmCaller(o.instance.exports);
    this.exited = false;
    this.pendingAsync = 0;
    this.testComplete = false;
    this.timer = null;
    this.timerAt = Infinity;
    this.immediate = false;
    // Module graph: key (path or builtin) -> URL; URL -> path for stack traces.
    this.urls = new Map();
    this.building = new Set();
    // promise -> {state, value}, for console.log and Bun.peek.
    this.promiseStates = new WeakMap();
    // Pending writes to o.modules, awaited before the next import().
    this.storing = [];
    this.paths = new Map();
    this.contentModules = o.moduleUrls === "blob" ? new ContentModules({
      named: o.modules, source: key => this.moduleSource(key), contentUrl: (source, key) => this.url(source, key),
      paths: this.paths, storing: this.storing,
    }) : null;
    this.handoffs = new Map();
    this.asyncContext = undefined;
    this.wakeArmed = false;
    if (NativeMessageChannel) {
      this.channel = new NativeMessageChannel();
      this.channel.port1.onmessage = () => {
        this.immediate = false;
        this.pump();
      };
    }
  }

  start() {
    const d = this.wasm.describe();
    this.entry = d.entry;
    const native = this.buildNative(d);
    this.native = native;
    let internal;
    try {
      const factory = this.evalPolyfill("bootstrap");
      internal = factory(native);
    } catch (err) {
      this.o.onExit && this.writeErr(`bun-wasm: bootstrap failed: ${err && err.stack ? err.stack : err}\n`);
      return this.exit(70);
    }
    this.internal = internal;
    installHostCrypto(nativeSubtleCrypto,NativeCryptoKey,internal.crypto,native);
    // Module URLs show as their paths; frames of this host itself (and the
    // worker bundle it lives in) are internal, like the polyfills.
    internal.displayName = (file, evalFrame = false) => {
      if (typeof file !== "string") return file;
      const path = this.paths.get(file);
      if (path) return path;
      if (evalFrame) return file;
      return /^(blob:|data:|file:|https?:|node:internal\/)/.test(file) ? `bun-wasm:host` : file;
    };
    this.installGlobals();
    this.wrapPromiseJobs();
    this.watchRejections();
    this.startEntry();
    this.schedule(0);
    return undefined;
  }

  writeErr(text) {
    try {
      this.native.writeStderr(text);
    } catch {
      // nothing else to do
    }
  }

  // --- natives ---

  buildNative(d) {
    const native = {};
    const call = this.wasm.call;
    d.natives.forEach((name, index) => {
      const fn = (...args) => call(index, args);
      const dot = name.indexOf(".");
      if (dot < 0) {
        native[name] = fn;
        return;
      }
      const group = name.slice(0, dot);
      (native[group] || (native[group] = {}))[name.slice(dot + 1)] = fn;
    });
    Object.assign(native, d.constants);
    // Networking: the bun_wasm ABI functions net.js calls (native.host*),
    // implemented in JS by the host (o.net), not by wasm slots.
    const net = this.o.net;
    // The host decides the network capabilities. Everything else the wasm reports (such as its
    // runtime_proc process calls, imported directly) is the guest's own and stays as it is.
    native.hostCaps = Object.fromEntries(Object.entries(native.hostCaps || {}).map(([k, v]) => [k, NETWORK_CAPS.has(k) ? Boolean(net && net.caps[k]) : v]));
    if (net) {
      Object.assign(native, net.natives);
      if (native.hostLookup) native.hostLookup = trackLookup(native.hostLookup, promise => this.track(promise));
      net.onNews(() => this.schedule(0));
    }
    if (this.o.terminal) native.terminalSetRawMode = raw => this.o.terminal.setRawMode(raw);
    native.engine = "host";
    this.installSubtleCrypto();
    native.subtleCrypto = nativeSubtleCrypto;
    native.DOMException = NativeDOMException;
    native.CryptoKey = NativeCryptoKey;
    native.SubtleCrypto = NativeSubtleCrypto;
    Object.assign(native, this.valueNatives(native.mapPosition));
    return native;
  }

  installSubtleCrypto() {
    if (!nativeSubtleCrypto) return;
    const host = this;
    for (const [name, operation] of Object.entries(nativeSubtleOperations)) {
      const wrapper = { [name](...args) {
        let result;
        try {
          if (oversizedCryptoInput(name,args)) throw new NativeDOMException("Crypto input is too large","OperationError");
          result = Reflect.apply(operation,this,args);
        } catch (error) { result = NativePromise.reject(error); }
        // Tracking observes rejection; the returned promise must still report an unhandled rejection.
        return host.track(result).then(value => value);
      } }[name];
      Object.defineProperty(wrapper, "length", { value: operation.length });
      Object.defineProperty(nativeSubtleCrypto, name, { value: wrapper, writable: true, configurable: true });
    }
  }

  valueNatives(mapPosition) {
    const host = this;
    const shared = this.o?.sharedObjects;
    return {
      ...createScriptEvaluation((code, filename) => host.evalAt(code, filename), mapPosition),
      sharedObjects: shared ? bindSharedObjectHost(shared, {
        active: () => !host.exited,
        pending: delta => { host.pendingAsync += delta; },
        wake: () => host.schedule(0),
      }) : undefined,
      exit(code) {
        const status = (code | 0) & 0xff;
        host.exit(status);
        throw new ExitSignal(status);
      },
      scheduleTick() {
        if (host.tickQueued) return;
        host.tickQueued = true;
        nativeQueueMicrotask(() => host.drainTicks());
      },
      runMicrotasks() {
        // Native Promise jobs cannot run until the synchronous guest drain returns.
        host.drainTicks();
      },
      // A timer or immediate was added, maybe while the loop waits on a
      // promise (top-level await) with nothing armed.
      wake(ms) {
        host.schedule(ms > 0 ? ms : 0);
      },
      compileCjs(path) {
        return host.evalAt(host.native.hostCjsSource(path), path);
      },
      // require() of an ES module: Bun's bundler converts it to CommonJS
      // (imports become live require() bindings); see bootstrap.js.
      compileEsmAsCjs(path) {
        return host.evalAt(host.native.hostEsmAsCjs(path), path);
      },
      importModule(spec) {
        return host.importKey(spec);
      },
      loadPolyfill(name) {
        return host.evalPolyfill(name);
      },
      // The engine doesn't expose these to JS; console.log shows less.
      // Known only for promises whose settling the host saw (wrapPromiseJobs);
      // others print as pending.
      promiseState: (p) => (host.promiseStates.get(p) || PENDING).state,
      promiseResult: (p) => (host.promiseStates.get(p) || PENDING).value,
      promiseThen: (promise, fulfilled, rejected) => host.promiseThen(promise, fulfilled, rejected),
      isProxy: () => false,
      transferArrayBuffers, isWasmMemoryBuffer,
      getProxyTarget: () => undefined,
      isPromise: nativePromiseHasInstance,
      isError: (v) => (typeof Error.isError === "function" ? Error.isError(v) : v instanceof Error),
      iteratorEntries: () => undefined,
      ownKeysInOrder: () => undefined,
      getAsyncContext: () => host.o.asyncContext ? host.o.asyncContext.get() : host.asyncContext,
      setAsyncContext: (v) => {
        if (host.o.asyncContext) return host.o.asyncContext.set(v);
        host.asyncContext = v;
      },
      gc: () => nativeGc?.(),
      memoryUsage() {
        const mem = typeof performance === "object" && performance.memory;
        const used = mem ? mem.usedJSHeapSize : 0;
        return { rss: used, heapTotal: mem ? mem.totalJSHeapSize : 0, heapUsed: used, external: 0, arrayBuffers: 0 };
      },
    };
  }

  evalPolyfill(name) {
    const source = this.native ? this.native.polyfillSource(name) : this.wasm.call(this.indexOf("polyfillSource"), [name]);
    if (typeof source !== "string") throw new Error(`bun-wasm: missing internal module ${name}`);
    return this.evalAt(source, `bun-wasm:${name}`);
  }

  indexOf(name) {
    return this.wasm.describe().natives.indexOf(name);
  }

  // Indirect eval: global scope, sloppy unless the code says otherwise; the
  // sourceURL names the file in stack traces.
  evalAt(code, filename) {
    // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
    return (0, eval)(`${code}\n//# sourceURL=${filename}`);
  }

  // --- ES modules ---

  url(source, key) {
    let url;
    if (this.o.moduleUrls === "blob" && nativeCreateObjectURL) {
      url = nativeCreateObjectURL(new NativeBlob([source], { type: "text/javascript" }));
    } else {
      url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
    }
    this.paths.set(url, key);
    return url;
  }

  importKey(key) {
    return this.track(this.importReady(key));
  }

  /** Builds module `key` and its static dependencies, waits until the store has them, imports it. */
  async importReady(key) {
    const url = this.ensureModule(key);
    if (this.storing.length > 0) await Promise.all(this.storing.splice(0));
    return import(url);
  }

  /** The URL of module `key` (a path or a builtin name), built with its dependencies. */
  ensureModule(key) {
    if (this.contentModules) return this.contentModules.ensure(key);
    const cached = this.urls.get(key);
    if (cached) return cached;
    const store = this.o.modules;
    if (store) {
      // A named URL is known before its source exists, so import cycles link
      // natively, with live bindings, like in Bun.
      const url = store.url(key);
      this.urls.set(key, url);
      this.paths.set(url, key);
      let source;
      try {
        source = this.moduleSource(key);
      } catch (err) {
        this.urls.delete(key);
        throw err;
      }
      const write = store.put(url, source);
      if (write) this.storing.push(write);
      return url;
    }
    // Content URLs (blob:/data:) exist only once their source is final: no cycles.
    if (this.building.has(key)) {
      const err = new Error(`Circular ES module imports are not supported by the browser engine yet (${key})`);
      err.code = "ERR_CIRCULAR_IMPORT";
      throw err;
    }
    this.building.add(key);
    try {
      const url = this.url(this.moduleSource(key), key);
      this.urls.set(key, url);
      return url;
    } finally {
      this.building.delete(key);
    }
  }

  moduleSource(key) {
    const info = this.native.hostModuleSource(key);
    if (info.format === "esm") return this.linkEsm(key, info);
    // CommonJS, JSON, text and builtins: evaluated now (sharing require's
    // cache), re-exported by a small wrapper.
    let value;
    let def;
    if (info.format === "builtin") {
      value = this.internal.builtin(key);
      def = value && typeof value === "object" && value.__esModule ? value.default : value;
    } else {
      [value, def] = this.internal.importNonEsm(key, info.format);
    }
    this.handoffs.set(key, { value, default: def });
    return wrapperSource(key, value);
  }

  linkEsm(key, info) {
    let code = info.code;
    // Replace from the end so earlier offsets stay valid. Offsets are UTF-8
    // byte offsets: work on bytes.
    const bytes = utf8.encode(code);
    const parts = [];
    let end = bytes.length;
    const imports = info.imports.slice().sort((a, b) => b.start - a.start);
    for (const imp of imports) {
      parts.push(bytes.subarray(imp.end, end));
      parts.push(utf8.encode(this.replacement(key, imp)));
      end = imp.start;
    }
    parts.push(bytes.subarray(0, end));
    parts.reverse();
    code = parts.map((p) => fromUtf8.decode(p)).join("");
    return code;
  }

  replacement(from, imp) {
    if (imp.kind === "dynamic") return `globalThis.__bunwasm_dynamicImport(${JSON.stringify(from)})`;
    if (imp.key === null) {
      const err = new Error(imp.error);
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    }
    return JSON.stringify(this.ensureModule(imp.key));
  }

  installGlobals() {
    const host = this;
    const hidden = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
    hidden("__bunwasm_meta", (meta, path) => {
      host.internal.initImportMeta(meta, path, path === host.internal.mainPath);
    });
    hidden("__bunwasm_dynamicImport", (from) => (spec) =>
      host.track(
        (async () => host.importReady(host.native.resolve(NativeString(spec), from, false)))(),
      ),
    );
    hidden("__bunwasm_wrap", (key) => host.handoffs.get(key));
    this.installContextHooks(hidden);
    // Without a networking host, user code gets the host's own fetch.
    if (this.o.fetch && !this.native.hostCaps.fetch) this.installFetch(this.o.fetch);
  }

  // AsyncLocalStorage across suspensions. For this engine the transpiler
  // prints hooks around `await`, async generator `yield`, `for await`, and the
  // `catch` and `finally` blocks that can observe a rejected await (vendor
  // patch 0008, docs/engine-browser.md). A resumed frame would stay set for
  // whatever runs after the function suspends again or returns; jobs the host
  // wraps (then callbacks, timers, ticks) set their own, and a microtask puts
  // the previous one back if nothing changed it meanwhile.
  installContextHooks(hidden) {
    const host = this;
    const id = (value) => value;
    // A native continuation provider already scopes every job, including raw
    // eval. Its post-getter frame must not be replaced with the printer's
    // earlier frame, so every hook is inert.
    if (this.o.asyncContext) {
      hidden("__bunwasm_capture", () => undefined);
      hidden("__bunwasm_resume", (_saved, value) => value);
      hidden("__bunwasm_resumed", id);
      hidden("__bunwasm_caught", () => {});
      hidden("__bunwasm_id", id);
      hidden("__bunwasm_iterate", id);
      hidden("__bunwasm_entered", () => {});
      hidden("__bunwasm_exited", () => {});
      return;
    }
    const enter = (saved) => {
      const ambient = host.asyncContext;
      if (ambient === saved) return;
      host.asyncContext = saved;
      nativeQueueMicrotask(() => {
        if (host.asyncContext === saved) host.asyncContext = ambient;
      });
    };
    // `__bunwasm_resume(__bunwasm_capture(), await x)` in a function without
    // handlers; `__bunwasm_resumed(await __bunwasm_id(x, s = capture()), s, s = 0)`
    // in one whose `catch`/`finally` blocks start with `__bunwasm_caught(s, s = 0)`.
    // `s` is 0 while no suspension is pending, else the frame it began in.
    hidden("__bunwasm_capture", () => host.asyncContext);
    hidden("__bunwasm_resume", (saved, value) => {
      enter(saved);
      return value;
    });
    hidden("__bunwasm_resumed", (value, saved) => {
      enter(saved);
      return value;
    });
    // A generator's throw() runs its handlers synchronously in the caller's
    // frame, not the one its pending `yield` captured.
    let syncGeneratorResume = 0;
    hidden("__bunwasm_caught", (saved) => {
      if (saved !== 0 && syncGeneratorResume === 0) enter(saved);
    });
    hidden("__bunwasm_id", id);
    // `for await`: `{ let c; try { for await (… of c = __bunwasm_iterate(y)) {
    // try { __bunwasm_entered(c); … } finally { __bunwasm_caught(s, s = 0); } } }
    // finally { __bunwasm_exited(c); } }`. The body starts in the frame its
    // `next()` was called in; the loop leaves, after the iterator closed, in
    // the frame of its last `next()` or `return()`.
    const reenter = (record) => {
      const saved = record.pending;
      record.pending = noFrame;
      if (saved !== noFrame) enter(saved);
    };
    hidden("__bunwasm_iterate", (iterable) => forAwaitRecord(iterable, () => host.asyncContext));
    hidden("__bunwasm_entered", reenter);
    hidden("__bunwasm_exited", (record) => {
      if (record !== undefined) reenter(record);
    });
    const asyncGeneratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})()));
    const nativeThrow = asyncGeneratorPrototype.throw;
    const { throw: wrapped } = {
      throw(value) {
        syncGeneratorResume++;
        try {
          return nativeThrow.call(this, value);
        } finally {
          syncGeneratorResume--;
        }
      },
    };
    Object.defineProperty(asyncGeneratorPrototype, "throw", { value: wrapped });
  }

  // User code gets the host's real fetch, adapted to the runtime's Response.
  installFetch(hostFetch) {
    const host = this;
    const web = this.internal.web;
    const polyfillFetch = globalThis.fetch;
    async function fetch(input, init = {}) {
      const url = input instanceof web.Request ? input.url : NativeString(input instanceof web.URL ? input.href : input);
      if (url.startsWith("file:") || url.startsWith("data:")) return polyfillFetch(input, init);
      const req = input instanceof web.Request && Object.keys(init).length === 0 ? input : new web.Request(input, init);
      // The runtime's AbortSignal drives a native one for the host request.
      const signal = init.signal || (input instanceof web.Request ? input.signal : undefined);
      if (signal) signal.throwIfAborted();
      const controller = new NativeAbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        // A native Blob: Node's fetch would wrap a byte array in the global
        // (polyfill) ReadableStream, which it doesn't accept.
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : new NativeBlob([await req.arrayBuffer()]);
        const options = { method: req.method, headers: Array.from(req.headers), body, redirect: init.redirect || "follow", signal: controller.signal };
        const res = await host.track(hostFetch(req.url, options));
        const bytes = new Uint8Array(await host.track(res.arrayBuffer()));
        const nullBody = req.method === "HEAD" || res.status === 204 || res.status === 304;
        const out = new web.Response(nullBody ? null : bytes, {
          status: res.status >= 200 && res.status <= 599 ? res.status : 200,
          statusText: res.statusText,
          headers: Array.from(res.headers),
        });
        web.Response._setNetwork(out, res.url || req.url, Boolean(res.redirected));
        return out;
      } catch (err) {
        if (signal && signal.aborted) throw signal.reason;
        throw err;
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true, writable: true, enumerable: false });
  }

  drainTicks() {
    this.tickQueued = false;
    this.guard(() => this.internal.runTicks());
  }

  // Bun runs process.nextTick callbacks before promise jobs, and promise
  // callbacks keep the AsyncLocalStorage context they were registered in.
  // The host engine owns the job queue, so every callback given to
  // Promise.prototype.then (queueMicrotask goes through it too) drains
  // pending ticks first and restores its context. `await` doesn't call
  // `then` on native promises, so it is not covered.
  wrapPromiseJobs() {
    const host = this;
    const states = this.promiseStates;
    // What a promise resolved with `value` becomes, if that can be told
    // without observable effects: a non-thenable fulfills it; a native
    // promise passes on its known state. `in` instead of reading `then`,
    // which may be a getter.
    const settleWith = (promise, value) => {
      if (nativePromiseHasInstance(value)) {
        const known = states.get(value);
        if (known && known.state !== "pending") states.set(promise, known);
        return;
      }
      if ((typeof value !== "object" && typeof value !== "function") || value === null || !("then" in value)) {
        states.set(promise, { state: "fulfilled", value });
      }
    };
    const wrap = (fn, box, rejects) => {
      const context = host.asyncContext;
      const nativeContext = host.o.asyncContext;
      return (value) => {
        if (host.tickQueued) host.drainTicks();
        const previous = host.asyncContext;
        if (!nativeContext) host.asyncContext = context;
        try {
          // A missing handler does what the default one would.
          if (typeof fn !== "function") {
            if (rejects) throw value;
            settleWith(box.promise, value);
            return value;
          }
          const result = fn(value);
          settleWith(box.promise, result);
          return result;
        } catch (err) {
          states.set(box.promise, { state: "rejected", value: err });
          throw err;
        } finally {
          if (!nativeContext) host.asyncContext = previous;
        }
      };
    };
    const attach = (react, promise, onFulfilled, onRejected) => {
      const box = { promise: null };
      box.promise = react(promise, wrap(onFulfilled, box, false), wrap(onRejected, box, true));
      return box.promise;
    };
    const { then } = {
      then(onFulfilled, onRejected) {
        return attach(nativePromiseThen, this, onFulfilled, onRejected);
      },
    };
    host.promiseThen = (promise, fulfilled, rejected) => attach(observePromise, promise, fulfilled, rejected);
    Object.defineProperty(NativePromise.prototype, "then", { value: then, configurable: true, writable: true, enumerable: false });

    // Statics whose result state is known at once. `this` stays the caller's
    // (subclasses); the constructor itself is not replaced, so promise
    // identity, `constructor` and await's fast path are untouched.
    const nativeResolve = NativePromise.resolve;
    const nativeReject = NativePromise.reject;
    const nativeWithResolvers = NativePromise.withResolvers;
    const statics = {
      resolve(value) {
        const promise = nativeResolve.call(this, value);
        if (promise !== value) settleWith(promise, value);
        return promise;
      },
      reject(reason) {
        const promise = nativeReject.call(this, reason);
        states.set(promise, { state: "rejected", value: reason });
        return promise;
      },
      withResolvers() {
        const r = nativeWithResolvers.call(this);
        let settled = false;
        const { resolve, reject } = r;
        r.resolve = (value) => {
          if (!settled) settleWith(r.promise, value);
          settled = true;
          resolve(value);
        };
        r.reject = (reason) => {
          if (!settled) states.set(r.promise, { state: "rejected", value: reason });
          settled = true;
          reject(reason);
        };
        return r;
      },
    };
    for (const name of ["resolve", "reject"].concat(nativeWithResolvers ? ["withResolvers"] : [])) {
      Object.defineProperty(NativePromise, name, { value: statics[name], configurable: true, writable: true, enumerable: false });
    }
  }


  watchRejections() {
    const onRejection = (reason, promise) => {
      if (this.exited || reason instanceof ExitSignal) return;
      if (!this.guard(() => this.internal.handleRejection(reason, promise))) this.exit(1);
    };
    if (nativeProcess) {
      nativeProcess.on("unhandledRejection", onRejection);
      nativeProcess.on("uncaughtException", (err) => this.uncaught(err));
    } else if (nativeAddEventListener) {
      nativeAddEventListener("unhandledrejection", (event) => {
        event.preventDefault();
        onRejection(event.reason, event.promise);
      });
      nativeAddEventListener("error", (event) => {
        event.preventDefault();
        this.uncaught(event.error);
      });
    }
  }

  startEntry() {
    const startup = this.internal.workerStartup;
    if (!startup) { this.runEntry(); return; }
    this.pendingAsync++;
    nativePromiseThen(startup.ready, () => {
      this.pendingAsync--;
      if (this.exited) return;
      this.runEntry();
      this.schedule(0);
    }, error => {
      this.pendingAsync--;
      if (this.exited) return;
      this.uncaught(error);
      if (!this.exited) this.exit(1);
    });
  }

  runEntry() {
    const { entry, internal } = this;
    let started;
    try {
      if (entry.kind === "eval") started = this.importKey(entry.main);
      else if (entry.kind === "test") started = internal.runTests(entry.args);
      else started = internal.runMain(entry.main);
    } catch (err) {
      this.uncaught(err);
      return;
    }
    if (started && typeof started.then === "function") {
      this.track(started).then(
        () => this.entrySettled(),
        (err) => { this.uncaught(err); this.entrySettled(); },
      );
    }
  }

  entrySettled() {
    if (this.entry.kind !== "test") return;
    this.testComplete = true;
    this.schedule(0);
  }

  // --- the event loop ---

  /** Keep the process alive until `promise` settles; wake the loop then. */
  track(promise) {
    this.pendingAsync++;
    const done = () => {
      this.pendingAsync--;
      this.schedule(0);
    };
    promise.then(done, done);
    return promise;
  }

  schedule(ms) {
    if (this.exited) return;
    if (ms <= 0) {
      if (this.immediate) return;
      this.immediate = true;
      if (this.channel) this.channel.port2.postMessage(0);
      else nativeSetTimeout(() => {
        this.immediate = false;
        this.pump();
      }, 0);
      return;
    }
    // runTimers hands back fractional ms, and setTimeout drops the fraction: the
    // wake would land just before the timer is due, and the sub-millisecond retry
    // that follows gets the browser's 4ms nested-timer clamp.
    ms = Math.ceil(ms);
    const at = nativeDateNow() + ms;
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) nativeClearTimeout(this.timer);
    this.timerAt = at;
    this.timer = nativeSetTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump();
    }, ms);
  }

  // One turn: run one due timer/immediate (microtasks then run natively),
  // then decide when to come back.
  pump() {
    if (this.exited) return;
    // Read before stepping I/O, so a change published meanwhile still ends the next wait.
    const observedWake = this.o.processWake ? nativeAtomicsLoad(this.o.processWake, 0) : 0;
    this.guard(() => this.internal.pumpSignals(), false);
    if (this.exited) return;
    if (this.testComplete) return this.finish();
    let next = this.guard(() => this.internal.runTimers(), 0);
    // Network handles (net.js waiters): step them; the networking host's
    // onNews wakes the loop when something changes.
    const io = this.guard(() => this.internal.ioPending(), 0);
    if (io > 0 && this.guard(() => this.internal.pumpIo(), false) && next !== 0) next = 0;
    if (this.o.debug) this.o.debug(`pump next=${next} pending=${this.pendingAsync} io=${io}`);
    this.flush();
    if (this.exited) return;
    if (next >= 0 || this.pendingAsync > 0 || io > 0) this.idleWait = false;
    if (next === 0) return this.schedule(0);
    if (io > 0) this.wakeOnProcessChange(observedWake);
    // A sender may be another worker, so shared pending signals do not necessarily post a
    // message here. Only bound waits that already keep the guest alive; handlers alone must
    // not create a timer or stop an otherwise idle program from finishing.
    if (next > 0) return this.schedule(this.native.hostCaps.signal ? Math.min(next, 25) : next);
    if (this.pendingAsync > 0 || io > 0) {
      if (this.native.hostCaps.signal) this.schedule(25);
      return undefined;
    }
    return this.finish();
  }

  // Pipe and child changes publish on the process wake word: run the loop for them rather than
  // waiting out the bounded rescan. Other sources still rely on that rescan.
  wakeOnProcessChange(observed) {
    const word = this.o.processWake;
    if (!word || !nativeWaitAsync || this.wakeArmed) return;
    const wait = nativeWaitAsync(word, 0, observed);
    if (!wait.async) return this.schedule(0);
    this.wakeArmed = true;
    nativePromiseThen(wait.value, () => {
      this.wakeArmed = false;
      this.schedule(0);
    });
  }

  finish() {
    // Chromium reports unhandled rejections in a later task: look once more
    // after one before deciding the program is done.
    if (!this.idleWait) {
      this.idleWait = true;
      nativeSetTimeout(() => this.pump(), 0);
      return undefined;
    }
    this.idleWait = false;
    const more = !this.testComplete && this.guard(() => this.internal.emitBeforeExit(), false);
    if (more) return this.schedule(0);
    const code = this.guard(() => this.internal.beforeExit(), 1);
    this.exit(typeof code === "number" ? code : 0);
    return undefined;
  }

  flush() {
    try {
      this.native.flushOutput();
    } catch {
      // the wasm is gone
    }
  }

  /** Run `fn`; uncaught errors go to process.on("uncaughtException") or end the run. */
  guard(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      this.uncaught(err);
      return fallback;
    }
  }

  uncaught(err) {
    if (this.exited || err instanceof ExitSignal) return;
    let handled = false;
    try {
      handled = this.internal.handleUncaught(err);
    } catch (inner) {
      if (inner instanceof ExitSignal) return;
      this.writeErr(`error: ${inner}\n`);
    }
    if (!handled) this.exit(1);
  }

  exit(code) {
    if (this.exited) return;
    this.exited = true;
    this.internal?.workerStartup?.cancel();
    this.o.sharedObjects?.close();
    this.disposeNativeStreams?.();
    this.native.closeAllDirs();
    this.flush();
    if (this.timer !== null) nativeClearTimeout(this.timer);
    if (this.o.onExit) this.o.onExit(code);
    this.resolveDone(code);
  }
}

/** ES module re-exporting a CommonJS/JSON/builtin module's exports (handed over by __bunwasm_wrap). */
function wrapperSource(key, value) {
  const keys = value !== null && (typeof value === "object" || typeof value === "function") ? Object.keys(value) : [];
  let src = `const h = globalThis.__bunwasm_wrap(${JSON.stringify(key)}); const m = h.value; export default h.default;\n`;
  const exports = [];
  keys.forEach((k, i) => {
    if (k === "default" || k === "__esModule" || !/^[\p{L}\p{N}_$]+$/u.test(k)) return;
    src += `const e${i} = m[${JSON.stringify(k)}];\n`;
    exports.push(`e${i} as ${JSON.stringify(k)}`);
  });
  if (exports.length) src += `export { ${exports.join(", ")} };\n`;
  return src;
}
