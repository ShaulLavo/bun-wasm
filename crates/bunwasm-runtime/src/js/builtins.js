// Registry of built-in modules (`node:*`, `bun`, `bun:*`) and the small Node
// modules that don't deserve their own file. Modules for things WASI can't do
// reject loading or throw a clear error when used.
(function (internal) {
  "use strict";
  const native = internal.native;
  const reg = internal.builtinFactories;
  const lazy = (name, pick) => () => (pick ? pick(internal.require(name)) : internal.require(name));

  function unsupportedError(what, why) {
    const err = new Error(`${what} is not supported in bun-wasm: ${why}`);
    err.code = "ERR_NOT_SUPPORTED_IN_WASM";
    return err;
  }

  function thrower(what, why) {
    const fn = function () {
      throw unsupportedError(what, why);
    };
    Object.defineProperty(fn, "name", { value: what.slice(what.lastIndexOf(".") + 1) });
    return fn;
  }

  // A module whose listed functions/classes all throw on use.
  function unsupportedModule(name, why, keys, extra = {}) {
    const mod = {};
    for (const key of keys) mod[key] = thrower(`${name}.${key}`, why);
    return Object.assign(mod, extra);
  }

  const NO_PROCESSES = "WASI has no processes";
  const NO_NETWORK = "WASI has no network access";

  const dns = internal.require("dns");

  // --- os -------------------------------------------------------------------

  function osModule() {
    const env = globalThis.process.env;
    const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };
    const cpu = { model: "wasm32", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
    return internal.require("node_os_values")({
      EOL: "\n",
      devNull: "/dev/null",
      arch: () => globalThis.process.arch,
      machine: () => globalThis.process.arch,
      platform: () => "linux",
      type: () => "Linux",
      release: () => "wasi-preview1",
      version: () => "WASI preview1",
      hostname: () => env.HOSTNAME || "localhost",
      homedir: () => env.HOME || "/",
      tmpdir: () => (env.TMPDIR || env.TMP || env.TEMP || "/tmp").replace(/(.)\/$/, "$1"),
      endianness: () => "LE",
      uptime: () => native.now() / 1000,
      loadavg: () => [0, 0, 0],
      totalmem: () => 4294967296,
      freemem: () => 4294967296 - native.memoryUsage().rss,
      availableParallelism: () => 1,
      cpus: () => [cpu],
      networkInterfaces: () => ({}),
      userInfo: () => ({ uid: 0, gid: 0, username: env.USER || "user", homedir: env.HOME || "/", shell: env.SHELL || null }),
      getPriority: () => 0,
      setPriority() {},
      constants: { signals, errno: {}, priority: {}, dlopen: {}, UV_UDP_REUSEADDR: 4 },
    });
  }

  // --- crypto ---------------------------------------------------------------

  function cryptoModule() {
    const { Buffer } = internal.require("buffer");
    const webcrypto = globalThis.crypto;

    function encodeOut(bytes, encoding) {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return encoding === undefined || encoding === "buffer" ? buf : buf.toString(encoding);
    }

    // A view over a detached buffer reads as no bytes, as in Bun.
    const viewBytes = (data) => (ArrayBuffer.isView(data) && data.byteLength === 0 ? new Uint8Array(0) : internal.toUint8(data));
    function inputBytes(data, encoding) {
      if (typeof data === "string") return Buffer.from(data, encoding);
      if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return viewBytes(data);
      const err = new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${internal.describe(data)}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }

    const keyApi = internal.require("crypto_keys")(Buffer, inputBytes, timingSafeEqual);
    const { KeyObject, createSecretKey } = keyApi;

    const digests = internal.require("node_digest");

    const finalized = () => Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
    // Bun's JSHash.cpp and JSHmac.cpp states: the stream's _flush computes and caches the
    // digest without finalizing a Hash, so a later digest() returns it and only empty
    // updates still succeed. Hmac finalizes on any digest, and a later digest() is empty.
    let flushDigest;
    // `algorithm` is a canonical name from node_digest.ts, already validated.
    class Hash {
      #algorithm;
      #key;
      #outputLength;
      #chunks = [];
      #digest = null;
      #finalized = false;
      constructor(algorithm, key, outputLength, options) {
        this.#algorithm = algorithm;
        this.#key = key;
        this.#outputLength = outputLength;
        // Stream options, applied when crypto_hash_stream.ts first builds the Transform state.
        this._options = options;
      }
      static {
        flushDigest = (hash) => (hash.#key === undefined ? encodeOut(hash.#compute()) : hash.digest());
      }
      #compute() {
        if (this.#digest !== null) return this.#digest;
        const input = internal.concatBytes(this.#chunks);
        this.#chunks = [];
        this.#digest = this.#key === undefined ? native.nodeDigest(this.#algorithm, input, this.#outputLength) : native.nodeHmac(this.#algorithm, this.#key, input);
        return this.#digest;
      }
      update(data, encoding) {
        if (this.#finalized) throw finalized();
        const bytes = inputBytes(data, encoding);
        if (this.#digest !== null && bytes.length) throw Object.assign(new Error("Hash update failed"), { code: "ERR_CRYPTO_HASH_UPDATE_FAILED" });
        this.#chunks.push(bytes.slice());
        return this;
      }
      digest(encoding) {
        if (this.#finalized && this.#key !== undefined) return encodeOut(new Uint8Array(0), Buffer.isEncoding(encoding) ? encoding : undefined);
        if (this.#finalized) throw finalized();
        this.#finalized = true;
        return encodeOut(this.#compute(), encoding);
      }
      copy(options) {
        if (this.#finalized || this.#digest !== null) throw finalized();
        // A copy takes its own output length; without one it uses the default, as in Bun.
        const requested = digests.outputLength(options);
        if (requested !== undefined && !digests.isXof(this.#algorithm) && requested !== digests.byteLength(this.#algorithm)) throw digests.notXofError();
        const copy = new Hash(this.#algorithm, this.#key, requested);
        for (const c of this.#chunks) copy.update(c);
        return copy;
      }
    }

    internal.require("crypto_hash_stream")(Hash, {
      _transform(chunk, encoding, callback) {
        this.update(chunk, encoding);
        callback();
      },
      _flush(callback) {
        this.push(flushDigest(this));
        callback();
      },
    });

    function createHash(algorithm, options) {
      const name = digests.hashName(String(algorithm));
      // Bun's BoringSSL error here carries no `code`.
      if (name === undefined) throw new Error("Digest method not supported");
      const outputLength = digests.outputLength(options);
      if (outputLength !== undefined && !digests.isXof(name) && outputLength !== digests.byteLength(name)) throw digests.notXofError();
      return new Hash(name, undefined, outputLength, options);
    }

    function createHmac(algorithm, key, options) {
      const args = internal.require("node_crypto_args");
      args.validateString(algorithm, "hmac");
      const keyBytes = ArrayBuffer.isView(key) ? viewBytes(key).slice() : args.secretKey(key).slice();
      const name = digests.hmacName(String(algorithm));
      if (name === undefined) throw Object.assign(new TypeError(`Invalid digest: ${algorithm}`), { code: "ERR_CRYPTO_INVALID_DIGEST" });
      return Reflect.construct(Hash, [name, keyBytes, undefined, options], Hmac);
    }

    // crypto.Hmac works with or without `new`. As in Bun, Hmac and Hash are unrelated
    // classes on the same LazyTransform; Hmac shares Hash's methods except copy().
    function Hmac(hmac, key, options) {
      return createHmac(hmac, key, options);
    }
    Hmac.prototype = Object.create(Object.getPrototypeOf(Hash.prototype), Object.getOwnPropertyDescriptors(Hash.prototype));
    delete Hmac.prototype.copy;
    Object.defineProperty(Hmac.prototype, "constructor", { value: Hmac, writable: true, configurable: true });

    function randomBytes(size, callback) {
      const buf = Buffer.from(native.randomBytes(size).buffer);
      if (typeof callback === "function") {
        internal.realTimers.setImmediate(() => callback(null, buf));
        return undefined;
      }
      return buf;
    }

    // Node's lib/internal/crypto/random.js: argument checks, then rejection sampling over
    // 48-bit draws so every value in the range is equally likely.
    const RAND_MAX = 0xffff_ffff_ffff;
    const rangeNumber = (value) => (Math.abs(value) <= 2 ** 32 ? String(value) : String(value).replace(/\B(?=(\d{3})+$)/g, "_"));
    function randomInt(min, max, callback) {
      const minNotSpecified = typeof max === "undefined" || typeof max === "function";
      if (minNotSpecified) {
        callback = max;
        max = min;
        min = 0;
      }
      if (callback !== undefined && typeof callback !== "function")
        throw Object.assign(new TypeError(`The "callback" argument must be of type function. Received ${internal.describe(callback)}`), { code: "ERR_INVALID_ARG_TYPE" });
      for (const [name, value] of [["min", min], ["max", max]]) {
        if (!Number.isSafeInteger(value))
          throw Object.assign(new TypeError(`The "${name}" argument must be a safe integer. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
      const outOfRange = (name, rule, received) =>
        Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${received}`), { code: "ERR_OUT_OF_RANGE" });
      // Bun prints max plainly here and separates the digits of a too-large range.
      if (max <= min) throw outOfRange("max", `greater than the value of "min" (${min})`, max);
      const range = max - min;
      if (range > RAND_MAX) throw outOfRange(`max${minNotSpecified ? "" : " - min"}`, `<= ${RAND_MAX}`, rangeNumber(range));
      const limit = RAND_MAX - (RAND_MAX % range);
      let n;
      do {
        n = 0;
        for (const b of native.randomBytes(6)) n = n * 256 + b;
      } while (n >= limit);
      const value = min + (n % range);
      if (callback !== undefined) {
        internal.realTimers.setImmediate(() => callback(undefined, value));
        return undefined;
      }
      return value;
    }

    function timingSafeEqual(a, b) {
      const x = internal.toUint8(a);
      const y = internal.toUint8(b);
      if (x.byteLength !== y.byteLength) {
        throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
      }
      return native.timingSafeEqual(x,y);
    }

    function randomFillSync(buffer, offset = 0, size) {
      const view = internal.toUint8(buffer);
      const end = size === undefined ? view.length : offset + size;
      view.set(native.randomBytes(end - offset), offset);
      return buffer;
    }

    const unsupportedCrypto = ["scrypt", "scryptSync", "privateEncrypt", "publicDecrypt"];
    return unsupportedModule("crypto", "this Node crypto operation is not implemented", unsupportedCrypto, {
      createHash,
      createHmac,
      KeyObject,
      createSecretKey,
      hash: (algorithm, data, encoding = "hex") => createHash(algorithm).update(data).digest(encoding),
      randomBytes,
      pseudoRandomBytes: randomBytes,
      randomFillSync,
      randomFill: (buffer, ...rest) => {
        const callback = rest.pop();
        randomFillSync(buffer, ...rest);
        internal.realTimers.setImmediate(() => callback(null, buffer));
      },
      randomInt,
      randomUUID: () => webcrypto.randomUUID(),
      getRandomValues: (array) => webcrypto.getRandomValues(array),
      timingSafeEqual,
      getHashes: () => digests.nodeHashes.slice(),
      webcrypto,
      subtle: webcrypto.subtle,
      ...keyApi,
      ...internal.require("node_cipher")(),
      ...internal.require("node_dh")(),
      ...internal.require("node_pbkdf2")(digests, Buffer),
      ...internal.require("x509")(Buffer, keyApi),
      Hash,
      Hmac,
    });
  }

  // --- timers ---------------------------------------------------------------

  function timersPromises() {
    return internal.require("timer_promises");
  }

  function timersModule() {
    const t = internal.timers;
    return {
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
      setImmediate: t.setImmediate,
      clearImmediate: t.clearImmediate,
      promises: internal.builtin("node:timers/promises"),
      active: (timer) => timer && timer.refresh && timer.refresh(),
      unenroll: (timer) => t.clearTimeout(timer),
    };
  }

  // --- module / vm ----------------------------------------------------------

  function moduleModule() {
    const builtinModules = Object.keys(reg)
      .filter((id) => id.startsWith("node:"))
      .map((id) => id.slice(5));
    function createRequire(filename) {
      let path = filename instanceof URL || String(filename).startsWith("file:") ? internal.require("node_url").fileURLToPath(filename) : String(filename);
      if (path.endsWith("/")) path += "noop.js";
      return internal.makeRequire(path);
    }
    const Module = internal.Module;
    Object.assign(Module, {
      builtinModules,
      createRequire,
      isBuiltin: (name) => Object.prototype.hasOwnProperty.call(reg, name.startsWith("node:") ? name : "node:" + name) || name === "bun" || name.startsWith("bun:"),
      _cache: internal.moduleCache,
      _extensions: { ".js": () => {}, ".json": () => {}, ".node": () => {} },
      _resolveFilename: (request, parent) => native.resolve(request, (parent && parent.filename) || native.cwd() + "/", true),
      _nodeModulePaths: (dir) => new Module(dir + "/x", null).paths,
      wrap: (code) => `(function (exports, require, module, __filename, __dirname) { ${code}\n});`,
      register() {},
      syncBuiltinESMExports() {},
      findSourceMap: () => undefined,
      SourceMap: class SourceMap {},
      Module,
    });
    return Module;
  }

  function vmModule() {
    class Script {
      constructor(code, options = {}) {
        this.code = String(code);
        this.filename = typeof options === "string" ? options : options.filename || "evalmachine.<anonymous>";
      }
      runInThisContext() {
        return native.evalScript(internal.prepareText(this.code, "script", "vm-script", this.filename), this.filename);
      }
      runInContext(context) {
        return runWith(this.code, context, this.filename);
      }
      runInNewContext(context = {}) {
        return runWith(this.code, context, this.filename);
      }
    }
    // Not a real separate realm: globals resolve through the context object
    // first (`with`; Hermes has no `with`, see vm_context.ts), then fall back
    // to this realm's globals.
    function runWith(code, context, filename) {
      if (!("globalThis" in context) && Object.isExtensible(context)) {
        Object.defineProperty(context, "globalThis", { value: context, writable: true, configurable: true });
      }
      if (native.engine === "hermes") return internal.require("vm_context").run(String(code), context, filename);
      const runner = native.evalScript(`(function (__ctx, __code) { with (__ctx) { return eval(__code); } })`, filename);
      return runner(context, internal.prepareText(String(code), "eval", "vm-context", filename));
    }
    return {
      Script,
      runInThisContext: (code, options) => new Script(code, options).runInThisContext(),
      runInContext: (code, context, options) => new Script(code, options).runInContext(context),
      runInNewContext: (code, context, options) => new Script(code, options).runInNewContext(context),
      createContext: (context = {}) => context,
      isContext: (value) => value !== null && typeof value === "object",
      compileFunction: (code, params = [], options = {}) => native.evalScript(internal.prepareText(`(function (${params.join(", ")}) {\n${code}\n})`, "wrapper", "vm-compileFunction", options.filename), options.filename),
    };
  }

  // --- async_hooks / diagnostics_channel ------------------------------------

  function asyncHooksModule() {
    // The current async context is carried across await/then, timers and ticks
    // by the engine (see runInContext in bootstrap.js); async_local_storage.ts
    // owns what it holds.
    const currentFrame = () => native.getAsyncContext();
    const { AsyncLocalStorage } = internal.require("async_local_storage");
    const invalidArgType = (name, type, value) => Object.assign(
      new TypeError(`The "${name}" argument must be of type ${type}. Received ${internal.describe(value)}`),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
    // bind, static bind and runInAsyncScope follow Bun's src/js/node/async_hooks.ts (see
    // docs/bun-patches/async-local-storage.md): the bound function runs in the context the
    // resource was created in.
    class AsyncResource {
      #frame;
      constructor(type) {
        if (typeof type !== "string") throw invalidArgType("type", "string", type);
        this.type = type;
        this.#frame = currentFrame();
      }
      runInAsyncScope(fn, thisArg, ...args) {
        return internal.runInContext(this.#frame, fn, thisArg, args);
      }
      emitDestroy() {
        return this;
      }
      bind(fn, thisArg) {
        if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
        let bound;
        if (thisArg === undefined) {
          const resource = this;
          bound = function (...args) {
            return Reflect.apply(resource.runInAsyncScope, resource, [fn, this].concat(args));
          };
        } else {
          bound = this.runInAsyncScope.bind(this, fn, thisArg);
        }
        Object.defineProperty(bound, "length", { configurable: true, enumerable: false, value: fn.length, writable: false });
        return bound;
      }
      asyncId() {
        return 1;
      }
      triggerAsyncId() {
        return 0;
      }
      static bind(fn, type, thisArg) {
        type = type || fn.name;
        return new AsyncResource(type || "bound-anonymous-fn").bind(fn, thisArg);
      }
    }
    return {
      AsyncLocalStorage,
      AsyncResource,
      createHook: () => ({ enable() { return this; }, disable() { return this; } }),
      executionAsyncId: () => 1,
      triggerAsyncId: () => 0,
      executionAsyncResource: () => ({}),
    };
  }

  function diagnosticsChannelModule() {
    const channels = new Map();
    class Channel {
      constructor(name) {
        this.name = name;
        this._subscribers = [];
      }
      get hasSubscribers() {
        return this._subscribers.length > 0;
      }
      subscribe(fn) {
        this._subscribers.push(fn);
      }
      unsubscribe(fn) {
        const i = this._subscribers.indexOf(fn);
        if (i >= 0) this._subscribers.splice(i, 1);
        return i >= 0;
      }
      publish(message) {
        for (const fn of this._subscribers.slice()) fn(message, this.name);
      }
      bindStore() {}
      unbindStore() {}
      runStores(data, fn, thisArg, ...args) {
        return fn.apply(thisArg, args);
      }
    }
    const channel = (name) => {
      if (!channels.has(name)) channels.set(name, new Channel(name));
      return channels.get(name);
    };
    const tracingChannel = (name) => {
      const names = ["start", "end", "asyncStart", "asyncEnd", "error"];
      const tc = {};
      for (const n of names) tc[n] = channel(`tracing:${name}:${n}`);
      tc.traceSync = (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args);
      tc.tracePromise = (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args);
      tc.traceCallback = (fn, pos, ctx, thisArg, ...args) => fn.apply(thisArg, args);
      tc.subscribe = () => {};
      tc.unsubscribe = () => {};
      return tc;
    };
    return {
      channel,
      hasSubscribers: (name) => channels.has(name) && channels.get(name).hasSubscribers,
      subscribe: (name, fn) => channel(name).subscribe(fn),
      unsubscribe: (name, fn) => channel(name).unsubscribe(fn),
      tracingChannel,
      Channel,
    };
  }

  // --- portable Node streams -----------------------------------------------------

  function streamModule() {
    const bundle = internal.require("node_stream_core");
    internal.require("node_stream_web")(bundle);
    // Bun's internal/streams/duplexpair, built on this module's Duplex, so it loads on first use.
    bundle.Stream.duplexPair = function duplexPair(options) {
      return internal.require("bun_builtins").require("internal:streams/duplexpair")(options);
    };
    return bundle.Stream;
  }

  function zlibModule() {
    return internal.require("zlib").module();
  }

  // --- net / http helpers that work without sockets -------------------------

  const STATUS_CODES = {
    100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints", 200: "OK", 201: "Created",
    202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content", 206: "Partial Content",
    207: "Multi-Status", 208: "Already Reported", 226: "IM Used", 300: "Multiple Choices", 301: "Moved Permanently",
    302: "Found", 303: "See Other", 304: "Not Modified", 305: "Use Proxy", 307: "Temporary Redirect",
    308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required",
    408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed",
    413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable",
    417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity",
    423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required",
    429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
    500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
    504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates",
    507: "Insufficient Storage", 508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended",
    511: "Network Authentication Required",
  };
  const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"];

  function httpModule(name) {
    // With a networking host (docs/host-abi.md) servers and requests work.
    if (native.hostCaps.listen || native.hostCaps.fetch) {
      const http = internal.require("net").nodeHttp(name === "https" ? "https:" : "http:");
      return Object.assign(http, {
        STATUS_CODES,
        METHODS,
        maxHeaderSize: 16384,
        validateHeaderName(name) { internal.require("http_common").validateHeaderName(name); },
        validateHeaderValue: internal.require("http_common").validateHeaderValue,
        setMaxIdleHTTPParsers() {},
      });
    }
    return unsupportedModule(name, NO_NETWORK, ["createServer", "request", "get", "Agent", "Server", "ClientRequest", "IncomingMessage", "ServerResponse", "OutgoingMessage"], {
      STATUS_CODES,
      METHODS,
      maxHeaderSize: 16384,
      validateHeaderName(name) { internal.require("http_common").validateHeaderName(name); },
      validateHeaderValue: internal.require("http_common").validateHeaderValue,
      setMaxIdleHTTPParsers() {},
    });
  }

  // --- registry -------------------------------------------------------------

  const entries = {
    "node:assert": lazy("assert"),
    "node:assert/strict": lazy("assert", (a) => a.strict),
    "node:buffer": lazy("buffer"),
    "node:events": lazy("events"),
    "node:fs": lazy("node_fs", (m) => m.fs),
    "node:fs/promises": lazy("node_fs", (m) => m.promises),
    "node:path": lazy("path"),
    "node:path/posix": lazy("path", (p) => p.posix),
    "node:path/win32": lazy("path", (p) => p.win32),
    "node:string_decoder": lazy("string_decoder"),
    "node:util": lazy("util"),
    "node:sys": lazy("util"),
    "node:util/types": lazy("util", (u) => u.types),
    "node:url": lazy("node_url"),
    "node:process": () => globalThis.process,
    "node:console": () => globalThis.console,
    "node:os": osModule,
    "node:crypto": cryptoModule,
    "node:timers": timersModule,
    "node:timers/promises": timersPromises,
    "node:module": moduleModule,
    "node:vm": vmModule,
    "node:querystring": () => internal.require("bun_builtins").require("node:querystring"),
    "node:async_hooks": asyncHooksModule,
    "node:diagnostics_channel": diagnosticsChannelModule,
    "node:readline": lazy("node_readline"),
    "node:readline/promises": () => internal.builtin("node:readline").promises,
    "node:stream": streamModule,
    "node:stream/promises": () => internal.builtin("node:stream").promises,
    "node:stream/consumers": lazy("stream_consumers"),
    "node:stream/web": () => internal.require("streams"),
    "node:perf_hooks": () => ({
      performance: globalThis.performance,
      PerformanceObserver: class PerformanceObserver {
        observe() {}
        disconnect() {}
      },
      monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0, min: 0, max: 0, mean: 0, stddev: 0 }),
      createHistogram: () => ({ record() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }),
      constants: {},
    }),
    "node:tty": () => ({
      isatty: (fd) => native.isatty(fd),
      ReadStream: thrower("tty.ReadStream", "no terminal streams"),
      WriteStream: thrower("tty.WriteStream", "no terminal streams"),
    }),
    "node:constants": () => Object.assign({}, internal.builtin("node:os").constants.signals, internal.builtin("node:fs").constants),
    "node:worker_threads": lazy("worker_threads"),
    "node:child_process": () => internal.require("spawn").nodeChildProcess(),
    "node:cluster": () => unsupportedModule("cluster", NO_PROCESSES, ["fork", "setupPrimary", "setupMaster", "disconnect"], { isPrimary: true, isMaster: true, isWorker: false, workers: {} }),
    "ws": () => internal.require("ws_builtin"),
    // npm packages Bun replaces with its own src/js/thirdparty modules, even when installed.
    "node-fetch": () => internal.require("bun_builtins").require("node-fetch"),
    "undici": () => internal.require("bun_builtins").require("undici"),
    "isomorphic-fetch": () => internal.require("bun_builtins").require("isomorphic-fetch"),
    "@vercel/fetch": () => internal.require("bun_builtins").require("vercel_fetch"),
    "node:net": () => Object.assign(internal.require("net").nodeNet(), internal.require("net_address")),
    "node:tls": lazy("node_tls"),
    "node:dgram": () => unsupportedModule("dgram", NO_NETWORK, ["createSocket", "Socket"]),
    "node:dns": () => dns.module(),
    "node:dns/promises": () => dns.promises(),
    "node:http": () => httpModule("http"),
    "node:https": () => httpModule("https"),
    "node:http2": () => unsupportedModule("http2", NO_NETWORK, ["createServer", "createSecureServer", "connect"], { constants: {}, Http2ServerRequest: internal.require("http2_request"), Http2ServerResponse: internal.require("http2_response") }),
    "node:zlib": zlibModule,
    // Node's contract when built without tracing. Bun and Node also reject it in workers.
    "node:trace_events": () => {
      throw Object.assign(new Error("Trace events are unavailable"), { code: "ERR_TRACE_EVENTS_UNAVAILABLE" });
    },
    "node:inspector": () => Object.assign(
      unsupportedModule("inspector", "no debugger", ["open", "waitForDebugger", "Session"], { console: globalThis.console }),
      { close() {}, url() { return undefined; } },
    ),
    "node:repl": () => internal.require("node_repl"),
    "node:v8": () => ({
      getHeapStatistics: () => ({ total_heap_size: native.memoryUsage().heapTotal, used_heap_size: native.memoryUsage().heapUsed, heap_size_limit: 4294967296 }),
      ...internal.require("v8"),
      setFlagsFromString() {},
      cachedDataVersionTag: () => 0,
    }),
    "node:wasi": () => internal.require("bun_builtins").require("node:wasi"),
    "node:domain": () => unsupportedModule("domain", "domains are deprecated and not implemented", ["create", "createDomain", "Domain"]),
    "node:punycode": () => internal.require("bun_builtins").require("node:punycode"),
    bun: () => globalThis.Bun,
    "bun:jsc": () => ({
      callerSourceOrigin: internal.require("caller_origin"),
      gcAndSweep: () => native.gc(),
      fullGC: () => native.gc(),
      edenGC: () => native.gc(),
      heapSize: () => native.memoryUsage().heapUsed,
      // Per-type cell counts come only from JSC; other engines report none.
      heapStats: () => ({
        heapSize: native.memoryUsage().heapUsed,
        heapCapacity: native.memoryUsage().heapTotal,
        extraMemorySize: native.memoryUsage().external || 0,
        objectCount: 0,
        protectedObjectCount: 0,
        globalObjectCount: 1,
        protectedGlobalObjectCount: 1,
        objectTypeCounts: native.objectTypeCounts?.() ?? {},
        protectedObjectTypeCounts: {},
      }),
      memoryUsage: () => native.memoryUsage(),
      describe: (v) => String(v),
      serialize: thrower("bun:jsc.serialize", "JavaScriptCore is not available"),
      deserialize: thrower("bun:jsc.deserialize", "JavaScriptCore is not available"),
    }),
    "bun:internal-for-testing": () => ({
      isASANEnabled: () => false,
      preparation: () => internal.preparation,
      prepareSource: (...args) => internal.prepareText(...args),
      semverIntersects: (left, right) => native.semverIntersects(`${left}`, `${right}`),
      directoryCount: () => native.directoryCount(),
      liveCipherCount: () => native.nodeCrypto.liveCiphers(),
      bunStringRoundTrip: (bytes, encoding) => native.bunStringRoundTrip(bytes, encoding),
      linearMemoryBytes: () => native.linearMemoryBytes(),
      // Node-internal modules for vendored Node tests, under the names they import them by.
      // Bun's map holds more; these are the ones bun-wasm serves from Bun's own sources.
      exposedInternals: {
        "internal/freelist": internal.require("bun_builtins").require("internal:freelist"),
        "internal/fixed_queue": internal.require("bun_builtins").require("internal:fixed_queue").FixedQueue,
      },
    }),
    "node:test": () => internal.require("node_test"),
    "bun:test": () => internal.require("bun_test").exports,
    "bun:sqlite": () => internal.require("bun_sqlite"),
    "bun:ffi": () => unsupportedModule("bun:ffi", "no native libraries in wasm", ["dlopen", "CString", "ptr", "toArrayBuffer", "toBuffer", "linkSymbols", "cc"], { FFIType: {}, suffix: "so" }),
    "bun:wrap": () => internal.require("bun_wrap"),
  };
  Object.assign(reg, entries);
  return reg;
})
