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
    return {
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
    };
  }

  // --- crypto ---------------------------------------------------------------

  function cryptoModule() {
    const { Buffer } = internal.require("buffer");
    const webcrypto = globalThis.crypto;

    function encodeOut(bytes, encoding) {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return encoding === undefined || encoding === "buffer" ? buf : buf.toString(encoding);
    }

    function inputBytes(data, encoding) {
      if (typeof data === "string") return Buffer.from(data, encoding);
      if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data);
      const err = new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${internal.describe(data)}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }

    const keyApi = internal.require("crypto_keys")(Buffer, inputBytes, timingSafeEqual);
    const { KeyObject, createSecretKey } = keyApi;

    class Hash {
      #algorithm;
      #key;
      #chunks = [];
      #done = false;
      constructor(algorithm, key) {
        this.#algorithm = String(algorithm);
        this.#key = key;
        // Validate eagerly, like Node.
        if (key === undefined) native.hash(this.#algorithm, "");
        else native.hmac(this.#algorithm, "", "");
      }
      update(data, encoding) {
        if (this.#done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
        this.#chunks.push(inputBytes(data, encoding).slice());
        return this;
      }
      digest(encoding) {
        if (this.#done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
        this.#done = true;
        const input = internal.concatBytes(this.#chunks);
        const bytes = this.#key === undefined ? native.hash(this.#algorithm, input) : native.hmac(this.#algorithm, this.#key, input);
        return encodeOut(bytes, encoding);
      }
      copy() {
        const copy = new Hash(this.#algorithm, this.#key);
        for (const c of this.#chunks) copy.update(c);
        return copy;
      }
    }

    function createHash(algorithm) {
      try {
        return new Hash(algorithm);
      } catch {
        throw Object.assign(new Error("Digest method not supported"), { code: "ERR_CRYPTO_INVALID_DIGEST" });
      }
    }

    function createHmac(algorithm, key) {
      const keyBytes = internal.crypto.isKey(key) ? internal.crypto.decode(internal.crypto.record(key).key.k) : typeof key === "string" ? Buffer.from(key) : internal.toUint8(key && key.export ? key.export() : key).slice();
      try {
        return new Hash(algorithm, keyBytes);
      } catch {
        throw Object.assign(new TypeError(`Invalid digest: ${algorithm}`), { code: "ERR_CRYPTO_INVALID_DIGEST" });
      }
    }

    function randomBytes(size, callback) {
      const buf = Buffer.from(native.randomBytes(size).buffer);
      if (typeof callback === "function") {
        internal.realTimers.setImmediate(() => callback(null, buf));
        return undefined;
      }
      return buf;
    }

    function randomInt(min, max, callback) {
      if (typeof max === "function" || max === undefined) {
        callback = max;
        max = min;
        min = 0;
      }
      const range = max - min;
      const bytes = native.randomBytes(6);
      let n = 0;
      for (const b of bytes) n = n * 256 + b;
      const value = min + (n % range);
      if (typeof callback === "function") {
        internal.realTimers.setImmediate(() => callback(null, value));
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

    const unsupportedCrypto = ["createCipheriv", "createDecipheriv", "createECDH", "createDiffieHellman", "scrypt", "scryptSync", "privateEncrypt", "publicDecrypt"];
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
      getHashes: () => ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"],
      getCiphers: () => [],
      getCurves: () => [],
      webcrypto,
      subtle: webcrypto.subtle,
      ...keyApi,
      ...internal.require("x509")(Buffer, keyApi),
      Hash,
      Hmac: Hash,
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
    // first (`with`), then fall back to this realm's globals.
    function runWith(code, context, filename) {
      if (!("globalThis" in context) && Object.isExtensible(context)) {
        Object.defineProperty(context, "globalThis", { value: context, writable: true, configurable: true });
      }
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
    // The current async context is a frozen Map from storage to store,
    // carried across await/then, timers and ticks by the engine (see
    // runInContext in bootstrap.js).
    const currentFrame = () => native.getAsyncContext();
    function frameWith(storage, store) {
      const next = new Map(currentFrame() || []);
      next.set(storage, store);
      return Object.freeze(next);
    }
    function frameWithout(storage) {
      const next = new Map(currentFrame() || []);
      next.delete(storage);
      return Object.freeze(next);
    }

    class AsyncLocalStorage {
      getStore() {
        const frame = currentFrame();
        return frame ? frame.get(this) : undefined;
      }
      run(store, callback, ...args) {
        return internal.runInContext(frameWith(this, store), callback, undefined, args);
      }
      exit(callback, ...args) {
        return internal.runInContext(frameWithout(this), callback, undefined, args);
      }
      enterWith(store) {
        native.setAsyncContext(frameWith(this, store));
      }
      disable() {
        native.setAsyncContext(frameWithout(this));
      }
      static bind(fn) {
        const frame = currentFrame();
        return function bound(...args) {
          return internal.runInContext(frame, fn, this, args);
        };
      }
      static snapshot() {
        const frame = currentFrame();
        return (fn, ...args) => internal.runInContext(frame, fn, undefined, args);
      }
    }
    class AsyncResource {
      constructor(type) {
        this.type = type;
        this._frame = currentFrame();
      }
      runInAsyncScope(fn, thisArg, ...args) {
        return internal.runInContext(this._frame, fn, thisArg, args);
      }
      emitDestroy() {
        return this;
      }
      bind(fn) {
        return fn.bind(this);
      }
      asyncId() {
        return 1;
      }
      triggerAsyncId() {
        return 0;
      }
      static bind(fn) {
        return fn;
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

  // --- readline -------------------------------------------------------------

  // Lines come from reading all of stdin (or the given input's data events).
  function readlineModule() {
    const EventEmitter = internal.require("events");
    let stdinLines = null;
    function takeStdinLine() {
      if (stdinLines === null) {
        const text = native.utf8Decode(native.readStdin());
        stdinLines = text.split(/\r?\n/);
        if (stdinLines[stdinLines.length - 1] === "") stdinLines.pop();
      }
      return stdinLines.length ? stdinLines.shift() : null;
    }
    class Interface extends EventEmitter {
      constructor(input, output) {
        super();
        const opts = input && input.input ? input : { input, output };
        this.input = opts.input;
        this.output = opts.output;
        this.terminal = false;
        this.line = "";
        this.closed = false;
        this._prompt = opts.prompt === undefined ? "> " : opts.prompt;
        this._pendingQuestion = null;
        this._started = false;
        this.on("newListener", (event) => {
          if (event === "line") this._start();
        });
      }
      _start() {
        if (this._started) return;
        this._started = true;
        internal.realTimers.setImmediate(() => this._pump());
      }
      _pump() {
        if (this.input && this.input !== globalThis.process.stdin && typeof this.input.on === "function") {
          let buffered = "";
          this.input.on("data", (chunk) => {
            buffered += String(chunk);
            const parts = buffered.split(/\r?\n/);
            buffered = parts.pop();
            for (const line of parts) this._deliver(line);
          });
          this.input.on("end", () => {
            if (buffered) this._deliver(buffered);
            this.close();
          });
          return;
        }
        for (let line = takeStdinLine(); line !== null && !this.closed; line = takeStdinLine()) this._deliver(line);
        this.close();
      }
      _deliver(line) {
        if (this._pendingQuestion) {
          const cb = this._pendingQuestion;
          this._pendingQuestion = null;
          cb(line);
          return;
        }
        this.emit("line", line);
      }
      question(query, options, callback) {
        if (typeof options === "function") callback = options;
        if (this.output && this.output.write) this.output.write(query);
        const line = takeStdinLine();
        internal.realTimers.setImmediate(() => callback(line === null ? "" : line));
      }
      prompt() {
        if (this.output && this.output.write) this.output.write(this._prompt);
        this._start();
      }
      setPrompt(prompt) {
        this._prompt = prompt;
      }
      getPrompt() {
        return this._prompt;
      }
      write(data) {
        if (this.output && this.output.write) this.output.write(data);
      }
      pause() {
        return this;
      }
      resume() {
        return this;
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        this.emit("close");
      }
      async *[Symbol.asyncIterator]() {
        this._started = true;
        if (this.input && this.input !== globalThis.process.stdin && typeof this.input.on === "function") {
          const lines = [];
          let done = false;
          let wake = null;
          this._started = false;
          this.on("line", (l) => {
            lines.push(l);
            if (wake) wake();
          });
          this.on("close", () => {
            done = true;
            if (wake) wake();
          });
          while (!done || lines.length) {
            if (lines.length) yield lines.shift();
            else await new Promise((r) => (wake = r));
          }
          return;
        }
        for (let line = takeStdinLine(); line !== null && !this.closed; line = takeStdinLine()) yield line;
        this.close();
      }
    }
    const createInterface = (input, output) => new Interface(input, output);
    const promises = {
      Interface,
      createInterface(input, output) {
        const rl = new Interface(input, output);
        const ask = rl.question.bind(rl);
        rl.question = (query) => new Promise((resolve) => ask(query, resolve));
        return rl;
      },
    };
    return {
      Interface,
      createInterface,
      promises,
      clearLine: (stream, dir, cb) => (cb && cb(), true),
      clearScreenDown: (stream, cb) => (cb && cb(), true),
      cursorTo: (stream, x, y, cb) => (typeof y === "function" ? y() : cb && cb(), true),
      moveCursor: (stream, dx, dy, cb) => (cb && cb(), true),
      emitKeypressEvents() {},
    };
  }

  // --- portable Node streams -----------------------------------------------------

  function streamModule() {
    const bundle = internal.require("node_stream_core");
    internal.require("node_stream_web")(bundle);
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
    "node:readline": readlineModule,
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
    "node:net": () => Object.assign(internal.require("net").nodeNet(), internal.require("net_address")),
    "node:tls": () => unsupportedModule("tls", NO_NETWORK, ["connect", "createServer", "createSecureContext", "TLSSocket", "Server", "checkServerIdentity"], { rootCertificates: [], DEFAULT_MIN_VERSION: "TLSv1.2", DEFAULT_MAX_VERSION: "TLSv1.3", DEFAULT_ECDH_CURVE: "auto" }),
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
      callerSourceOrigin() {
        const prepare = Error.prepareStackTrace;
        let stack;
        try {
          Error.prepareStackTrace = internal.defaultPrepareStackTrace;
          stack = new Error().stack;
        } finally {
          Error.prepareStackTrace = prepare;
        }
        const lines = String(stack || "").split("\n").slice(1);
        const inspector = internal.require("inspect");
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line === "Error") continue;
          const frame = inspector.parseStack(line)[0];
          if (frame) {
            if (frame.file.startsWith("/")) return internal.pathToFileHref(frame.file);
            return /^[a-z][a-z0-9+.-]*:/i.test(frame.file) ? frame.file : null;
          }
          if (/^(?:at (?:.* \()?|[^@]*@)bun-wasm:/.test(line) || /\(native\)$|@\[native code\]$/.test(line)) continue;
          return null;
        }
        return null;
      },
      gcAndSweep: () => native.gc(),
      fullGC: () => native.gc(),
      edenGC: () => native.gc(),
      heapSize: () => native.memoryUsage().heapUsed,
      // Per-type cell counts are unavailable through the engine interface.
      heapStats: () => ({
        heapSize: native.memoryUsage().heapUsed,
        heapCapacity: native.memoryUsage().heapTotal,
        extraMemorySize: native.memoryUsage().external || 0,
        objectCount: 0,
        protectedObjectCount: 0,
        globalObjectCount: 1,
        protectedGlobalObjectCount: 1,
        objectTypeCounts: {},
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
