// bun-wasm bootstrap. Evaluated once at startup with the `native` object
// (src/natives.rs). Installs the globals and returns `internal`: the hooks the
// Rust side calls (module loading, the event loop, error reporting).
(function (native) {
  "use strict";

  const internal = { native };

  // Engine hooks for the formatter (inspect.js) and util.types.
  function isModuleNamespace(value) {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === null &&
      Object.prototype.toString.call(value) === "[object Module]";
  }
  Object.assign(internal, {
    promiseState: native.promiseState,
    promiseResult: native.promiseResult,
    isProxy: native.isProxy,
    getProxyTarget: native.getProxyTarget,
    iteratorEntries: native.iteratorEntries,
    ownKeysInOrder: native.ownKeysInOrder,
    isPromise: native.isPromise,
    isError: native.isError,
    getSourceLine: native.getSourceLine,
    mapPosition: native.mapPosition,
    isESMNamespace: isModuleNamespace,
    isModuleNamespaceObject: isModuleNamespace,
  });
  const polyfills = new Map();

  // Lazily evaluate src/js/<name>.js; every file is a factory taking `internal`.
  internal.require = function requirePolyfill(name) {
    if (polyfills.has(name)) return polyfills.get(name);
    const factory = native.loadPolyfill(name);
    const exports = factory(internal);
    polyfills.set(name, exports);
    return exports;
  };

  // --- stack traces ---------------------------------------------------------
  //
  // QuickJS-ng supports V8's Error.prepareStackTrace. We use it to print
  // frames in QuickJS's own format, but with positions mapped back to the
  // file on disk (source maps for transpiled code, the injected ESM
  // prologue), and without the Error subclass constructor frames that JSC
  // doesn't show either.

  function isErrorConstructor(fn) {
    return typeof fn === "function" && (fn === Error || fn.prototype instanceof Error);
  }

  // V8 (the host engine in browsers/Node): eval'd code (CommonJS) names its
  // file through //# sourceURL, and strict-mode frames hide their function,
  // so top-level code is recognised by its enclosing position (1:1).
  // Only V8 calls Error.prepareStackTrace among host engines (JavaScriptCore
  // and SpiderMonkey stacks are parsed in inspect.js).
  const isV8 = native.engine === "host";
  function v8TopLevel(site) {
    return typeof site.getEnclosingLineNumber === "function" && site.getEnclosingLineNumber() === 1 && site.getEnclosingColumnNumber() === 1;
  }

  // V8 places `new Error()` at `new`; Bun (JSC) at the constructor name.
  function pastNew(file, line, col) {
    let text;
    try {
      text = internal.getSourceLine && internal.getSourceLine(file, line);
    } catch {
      return col;
    }
    if (typeof text !== "string") return col;
    const m = /^new\s+/.exec(text.slice(col - 1));
    return m ? col + m[0].length : col;
  }

  function evalOriginFile(site) {
    if (typeof site.getEvalOrigin !== "function") return null;
    const origin = site.getEvalOrigin();
    const match = typeof origin === "string" && /\(([^()]+):\d+:\d+\)/.exec(origin);
    return match ? match[1] : null;
  }

  function formatCallSite(site) {
    // The host engine loads modules from blob:/data: URLs; show their paths.
    const rawFile = (typeof site.getScriptNameOrSourceURL === "function" && site.getScriptNameOrSourceURL()) || site.getFileName() || evalOriginFile(site);
    const file = internal.displayName ? internal.displayName(rawFile, typeof site.isEval === "function" && site.isEval()) : rawFile;
    const name = site.getFunctionName();
    // A syntax error's location: no function, just file:line:col.
    if (!isV8 && site.getFunction() === undefined && !name && file) {
      return `${file}:${site.getLineNumber()}:${site.getColumnNumber()}`;
    }
    let line = site.getLineNumber();
    let col = site.getColumnNumber();
    if (line !== null && file && !internal.mappedCallSites?.has(site)) {
      const mapped = native.mapPosition(file, line, col);
      if (mapped) [line, col] = mapped;
      if (isV8) col = pastNew(file, line, col);
    }
    // Module and script top-level code prints bare, like JSC.
    const topLevel = isV8 ? !name && v8TopLevel(site) : isTopLevel(site.getFunction());
    if ((!name || name === "__bunwasm_cjs__") && file && line !== null && (topLevel || name === "__bunwasm_cjs__")) return `${file}:${line}:${col}`;
    const label = name || "<anonymous>";
    if (site.isNative()) return `${label} (native)`;
    if (file === null || file === undefined) {
      const evalFrame = typeof site.isEval === "function" && site.isEval();
      return `${label} (${evalFrame ? "unknown" : "native"})`;
    }
    if (line === null) return `${label} (${file})`;
    return `${label} (${file}:${line}:${col})`;
  }

  // CommonJS wrappers (registered by evaluateModule) and ES module bodies,
  // which QuickJS represents as nameless functions printing as native code.
  const topLevelFunctions = new WeakSet();
  internal.topLevelFunctions = topLevelFunctions;
  function isTopLevel(fn) {
    if (typeof fn !== "function") return false;
    if (topLevelFunctions.has(fn)) return true;
    return Function.prototype.toString.call(fn).startsWith("function () {\n    [native code]");
  }

  Error.prepareStackTrace = function prepareStackTrace(error, callsites) {
    let start = 0;
    while (start < callsites.length - 1 && isErrorConstructorFrame(callsites[start])) start++;
    let out = "";
    for (let i = start; i < callsites.length; i++) out += `    at ${formatCallSite(callsites[i])}\n`;
    return out;
  };
  internal.defaultPrepareStackTrace = Error.prepareStackTrace;

  function isErrorConstructorFrame(site) {
    return site.isConstructor() && isErrorConstructor(site.getFunction());
  }

  internal.formatCallSite = formatCallSite;
  internal.mappedCallSites = new WeakSet();

  // --- small path helpers (the full node:path lives in path.js) ------------

  function dirname(path) {
    const i = path.lastIndexOf("/");
    if (i < 0) return ".";
    if (i === 0) return "/";
    return path.slice(0, i);
  }

  function basename(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function pathToFileHref(path) {
    // encodeURI leaves a few characters that URL paths must escape.
    return "file://" + encodeURI(path).replace(/[?#]/g, encodeURIComponent);
  }
  internal.dirname = dirname;
  internal.basename = basename;
  internal.pathToFileHref = pathToFileHref;

  function defineHidden(target, values) {
    for (const key of Object.keys(values)) {
      Object.defineProperty(target, key, {
        value: values[key],
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
  internal.defineHidden = defineHidden;
  internal.require("stack_trace");

  function defineGlobal(name, value) {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  internal.defineGlobal = defineGlobal;

  // Lazily computed global (evaluated on first access, then replaced by a
  // plain data property).
  function defineLazyGlobal(name, compute) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      get() {
        const value = compute();
        defineGlobal(name, value);
        return value;
      },
      set(value) {
        defineGlobal(name, value);
      },
    });
  }

  // --- async context ----------------------------------------------------------
  //
  // QuickJS (patched in third_party/rquickjs-sys) keeps an async-context value
  // that promise reactions capture at then/await time and restore when they
  // run. Timers, ticks and immediates do the same here, so AsyncLocalStorage
  // follows the logical flow of a program.

  function runInContext(context, fn, thisArg, args) {
    const previous = native.getAsyncContext();
    native.setAsyncContext(context);
    try {
      return fn.apply(thisArg, args);
    } finally {
      native.setAsyncContext(previous);
    }
  }
  internal.runInContext = runInContext;

  // --- timers ---------------------------------------------------------------

  let timerSeq = 1;
  // Pending timers sorted by (when, seq).
  let timerQueue = [];
  const immediates = [];
  let refedTimers = 0;

  function insertTimer(timer) {
    let lo = 0;
    let hi = timerQueue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = timerQueue[mid];
      const before = other._when < timer._when || (other._when === timer._when && other._seq < timer._seq);
      if (before) lo = mid + 1;
      else hi = mid;
    }
    timerQueue.splice(lo, 0, timer);
    // A host-owned event loop (engine-host) may be idle waiting on a promise.
    if (native.wake) native.wake(timer._delay);
  }

  function removeTimer(timer) {
    const i = timerQueue.indexOf(timer);
    if (i >= 0) timerQueue.splice(i, 1);
  }

  class Timeout {
    constructor(callback, delay, args, repeat) {
      this._id = timerSeq++;
      this._seq = this._id;
      this._callback = callback;
      this._args = args;
      this._delay = delay;
      this._repeat = repeat;
      this._ref = true;
      this._active = true;
      this._context = native.getAsyncContext();
      this._when = native.now() + delay;
      refedTimers++;
      insertTimer(this);
    }
    ref() {
      if (!this._ref && this._active) refedTimers++;
      this._ref = true;
      return this;
    }
    unref() {
      if (this._ref && this._active) refedTimers--;
      this._ref = false;
      return this;
    }
    hasRef() {
      return this._ref;
    }
    refresh() {
      if (!this._active) return this;
      removeTimer(this);
      this._when = native.now() + this._delay;
      this._seq = timerSeq++;
      insertTimer(this);
      return this;
    }
    close() {
      cancelTimer(this);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  function cancelTimer(timer) {
    if (!timer || !timer._active) return;
    timer._active = false;
    if (timer._ref) refedTimers--;
    removeTimer(timer);
  }

  const timersById = new Map();

  function normalizeDelay(delay) {
    const ms = Number(delay);
    if (!(ms >= 1) || ms > 2147483647) return 1;
    return ms;
  }

  function checkCallback(callback) {
    if (typeof callback === "function") return;
    const err = new TypeError(`The "callback" argument must be of type function. Received ${internal.describe(callback)}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }

  function setTimeout(callback, delay, ...args) {
    checkCallback(callback);
    const timer = new Timeout(callback, normalizeDelay(delay), args, false);
    timersById.set(timer._id, timer);
    return timer;
  }

  function setInterval(callback, delay, ...args) {
    checkCallback(callback);
    const timer = new Timeout(callback, normalizeDelay(delay), args, true);
    timersById.set(timer._id, timer);
    return timer;
  }

  function lookupTimer(handle) {
    if (handle instanceof Timeout) return handle;
    if (typeof handle === "number" || typeof handle === "string") return timersById.get(Number(handle));
    return undefined;
  }

  function clearTimeout(handle) {
    const timer = lookupTimer(handle);
    if (!timer) return;
    cancelTimer(timer);
    timersById.delete(timer._id);
  }

  class Immediate {
    constructor(callback, args) {
      this._callback = callback;
      this._args = args;
      this._ref = true;
      this._active = true;
      this._context = native.getAsyncContext();
    }
    ref() {
      this._ref = true;
      return this;
    }
    unref() {
      this._ref = false;
      return this;
    }
    hasRef() {
      return this._ref;
    }
  }

  function setImmediate(callback, ...args) {
    checkCallback(callback);
    const immediate = new Immediate(callback, args);
    immediates.push(immediate);
    if (native.wake) native.wake(0);
    return immediate;
  }

  function clearImmediate(immediate) {
    if (immediate instanceof Immediate) immediate._active = false;
  }

  function runOneTimer(now) {
    const timer = timerQueue.shift();
    if (timer._repeat) {
      timer._when = now + timer._delay;
      timer._seq = timerSeq++;
      insertTimer(timer);
    } else {
      timer._active = false;
      if (timer._ref) refedTimers--;
      timersById.delete(timer._id);
    }
    runInContext(timer._context, timer._callback, timer, timer._args);
  }

  // Called by the Rust event loop. Runs at most one callback so microtasks
  // drain between callbacks. Returns 0 when something ran, the delay in ms
  // until the next timer, or -1 when nothing keeps the process alive.
  internal.runTimers = function runTimers() {
    const workerProgress = internal.workerPump && internal.workerPump();
    // Immediates first: like Bun, setImmediate callbacks queued by the
    // main script run before even a due setTimeout(0).
    while (immediates.length > 0) {
      const immediate = immediates.shift();
      if (!immediate._active) continue;
      immediate._active = false;
      runInContext(immediate._context, immediate._callback, immediate, immediate._args);
      return 0;
    }
    const now = native.now();
    if (timerQueue.length > 0 && timerQueue[0]._when <= now) {
      runOneTimer(now);
      return 0;
    }
    if (workerProgress || internal.pendingIo > 0) return 0;
    if (refedTimers <= 0 && internal.messagePortRefs <= 0) return -1;
    // Unref'd timers at the front don't keep us alive but still fire if a
    // ref'd one is pending later.
    return timerQueue.length ? Math.max(0.01, timerQueue[0]._when - now) : 1000;
  };
  internal.pendingIo = 0;
  internal.messagePortRefs = 0;
  // Replaced by net.js when a networking host is present.
  internal.ioPending = () => 0;
  internal.pumpIo = () => false;

  // --- process.nextTick -------------------------------------------------------

  const tickQueue = [];

  internal.nextTick = function nextTick(callback, ...args) {
    checkCallback(callback);
    if (tickQueue.length === 0) native.scheduleTick();
    tickQueue.push([callback, args, native.getAsyncContext()]);
  };

  internal.runTicks = function runTicks() {
    try {
      while (tickQueue.length > 0) {
        const [callback, args, context] = tickQueue.shift();
        runInContext(context, callback, undefined, args);
      }
    } finally {
      if (tickQueue.length > 0) native.scheduleTick();
    }
  };

  function queueMicrotask(callback) {
    checkCallback(callback);
    // Errors thrown by a microtask are uncaught exceptions, not rejections.
    Promise.resolve().then(() => {
      try {
        callback();
      } catch (err) {
        if (!internal.handleUncaught(err)) native.exit(1);
      }
    });
  }

  defineGlobal("setTimeout", setTimeout);
  defineGlobal("setInterval", setInterval);
  defineGlobal("clearTimeout", clearTimeout);
  defineGlobal("clearInterval", clearTimeout);
  defineGlobal("setImmediate", setImmediate);
  defineGlobal("clearImmediate", clearImmediate);
  defineGlobal("queueMicrotask", queueMicrotask);
  internal.timers = { setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout, setImmediate, clearImmediate, Timeout, Immediate };

  // Short description of a value for ERR_INVALID_ARG_TYPE messages.
  internal.describe = function describe(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") {
      const name = value.constructor && value.constructor.name;
      return name ? `an instance of ${name}` : "an instance of Object";
    }
    let shown = String(value);
    if (shown.length > 28) shown = shown.slice(0, 25) + "...";
    if (typeof value === "string") shown = `'${shown}'`;
    return `type ${typeof value} (${shown})`;
  };

  // --- CommonJS ---------------------------------------------------------------

  const moduleCache = Object.create(null);
  let mainModule;

  class Module {
    constructor(id, parent) {
      this.id = id;
      this.filename = id;
      this.path = dirname(id);
      this.exports = {};
      this.loaded = false;
      this.children = [];
      this.paths = nodeModulePaths(this.path);
      defineHidden(this, { parent });
    }
    require(spec) {
      if (typeof spec === "string" && spec.startsWith("internal/") && globalThis.process.env.BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING === "1") {
        const exposed = internal.require("node_stream_internals").modules;
        if (Object.prototype.hasOwnProperty.call(exposed, spec)) return exposed[spec];
      }
      return requireFrom(spec, this.filename);
    }
  }

  function nodeModulePaths(dir) {
    const paths = [];
    let current = dir;
    for (;;) {
      if (basename(current) !== "node_modules") paths.push((current === "/" ? "" : current) + "/node_modules");
      if (current === "/") break;
      current = dirname(current);
    }
    return paths;
  }

  function isBuiltinId(id) {
    return id.startsWith("node:") || id === "bun" || id.startsWith("bun:");
  }

  function loadModule(path, format) {
    const cached = moduleCache[path];
    if (cached) return cached;
    const kind = format || native.moduleFormat(path);
    const mod = new Module(path, undefined);
    moduleCache[path] = mod;
    try {
      evaluateModule(mod, path, kind);
    } catch (err) {
      delete moduleCache[path];
      throw err;
    }
    mod.loaded = true;
    return mod;
  }

  function evaluateModule(mod, path, kind) {
    if (kind === "json") {
      mod.exports = JSON.parse(native.readFileUtf8(path));
      return;
    }
    if (kind === "html") {
      mod.exports = internal.require("html_server").create(path);
      return;
    }
    if (kind === "text") {
      mod.exports = native.readFileUtf8(path);
      return;
    }
    if (kind === "esm") {
      // The host engine can't evaluate an ES module synchronously: it runs
      // the module converted to CommonJS by Bun's bundler instead.
      if (native.compileEsmAsCjs) {
        const wrapper = native.compileEsmAsCjs(path);
        callModuleWrapper(mod, wrapper, path);
        return;
      }
      mod.exports = native.requireEsm(path);
      return;
    }
    const wrapper = native.compileCjs(path);
    callModuleWrapper(mod, wrapper, path);
  }

  function callModuleWrapper(mod, wrapper, path) {
    topLevelFunctions.add(wrapper);
    const require = makeRequire(path, mod);
    if (wrapper.length !== 6) {
      wrapper.call(mod.exports, mod.exports, require, mod, path, dirname(path));
      return;
    }
    const meta = Object.create(null);
    internal.initImportMeta(meta, path, mod === mainModule);
    wrapper.call(mod.exports, mod.exports, require, mod, path, dirname(path), meta);
  }

  function resolveFrom(spec, fromPath) {
    if (typeof spec !== "string") {
      const err = new TypeError(`The "id" argument must be of type string. Received ${internal.describe(spec)}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    return native.resolve(spec, fromPath, true);
  }

  function requireFrom(spec, fromPath) {
    const resolved = resolveFrom(spec, fromPath);
    if (isBuiltinId(resolved)) return internal.builtin(resolved);
    return loadModule(resolved, null).exports;
  }

  function makeRequire(fromPath, mod) {
    function require(spec) {
      return mod ? mod.require(spec) : requireFrom(spec, fromPath);
    }
    require.resolve = function resolve(spec) {
      return resolveFrom(spec, fromPath);
    };
    require.resolve.paths = function paths(spec) {
      return isBuiltinId(spec) ? null : nodeModulePaths(dirname(fromPath));
    };
    require.cache = moduleCache;
    require.main = mainModule;
    require.extensions = { ".js": null, ".json": null, ".node": null };
    return require;
  }
  internal.makeRequire = makeRequire;
  internal.moduleCache = moduleCache;
  internal.Module = Module;
  internal.isBuiltinId = isBuiltinId;

  // ESM importing a non-ES module. Returns [namespace source, default export].
  internal.importNonEsm = function importNonEsm(path, format) {
    const exports = loadModule(path, format).exports;
    if (format === "cjs" && exports !== null && typeof exports === "object" && exports.__esModule) {
      return [exports, exports.default];
    }
    return [exports, exports];
  };

  internal.initImportMeta = function initImportMeta(meta, path, isMain) {
    defineHidden(meta, {
      url: pathToFileHref(path),
      dir: dirname(path),
      dirname: dirname(path),
      path,
      filename: path,
      file: basename(path),
      main: isMain,
      require: makeRequire(path, undefined),
      resolve(spec) {
        const resolved = native.resolve(String(spec), path, false);
        return isBuiltinId(resolved) ? resolved : pathToFileHref(resolved);
      },
      resolveSync(spec) {
        return native.resolve(String(spec), path, false);
      },
    });
    Object.defineProperty(meta, "env", {
      get: () => globalThis.process.env,
      configurable: true,
      enumerable: false,
    });
  };

  internal.runMain = function runMain(requested) {
    // `bun run ./app` finds app.ts, app/index.js, ... like an import would.
    let path = requested;
    if (!native.exists(path) || native.stat(path).mode & 0o040000) {
      try {
        path = native.resolve(requested, "/", false);
      } catch {
        path = requested;
      }
      if (path !== requested) {
        native.setMainPath(path);
        internal.mainPath = path;
        if (globalThis.process.argv[1] === requested) globalThis.process.argv[1] = path;
      }
    }
    if (!native.exists(path)) {
      const err = new Error(`Module not found "${native.mainArg() || path}"`);
      err.code = "ERR_MODULE_NOT_FOUND";
      err.__bunwasmPlain = true;
      throw err;
    }
    const format = native.moduleFormat(path);
    if (format === "html") return internal.require("html_server").start(path);
    if (format === "esm") return native.importModule(path);
    mainModule = new Module(path, null);
    mainModule.id = ".";
    moduleCache[path] = mainModule;
    try {
      evaluateModule(mainModule, path, format);
    } catch (err) {
      delete moduleCache[path];
      throw err;
    }
    mainModule.loaded = true;
    return undefined;
  };
  internal.getMainModule = () => mainModule;

  // `bun test [args]`: the runner lives in bun_test.js. It sets
  // process.exitCode when tests fail.
  internal.runTests = function runTests(args) {
    return internal.require("bun_test").run(args);
  };
  internal.importModule = (path) => native.importModule(path);

  // --- built-in modules -------------------------------------------------------

  const builtinCache = new Map();
  const builtinFactories = Object.create(null);
  internal.builtinFactories = builtinFactories;

  internal.builtin = function builtin(id) {
    if (builtinCache.has(id)) return builtinCache.get(id);
    const factory = builtinFactories[id];
    if (!factory) throw new Error(`Cannot find module '${id}'`);
    const exports = factory();
    builtinCache.set(id, exports);
    return exports;
  };

  // --- uncaught errors --------------------------------------------------------

  function printError(err) {
    let text;
    try {
      text = internal.require("inspect").formatError(err);
    } catch (formatErr) {
      text = fallbackErrorText(err);
    }
    native.writeStderr(text.endsWith("\n") ? text : text + "\n");
    native.writeStderr(`\nBun v${native.platformInfo.version} (WASI ${native.platformInfo.arch})\n`);
  }
  internal.printError = printError;

  function fallbackErrorText(err) {
    if (err instanceof Error) return `${err.name === "Error" ? "error" : err.name}: ${err.message}\n${err.stack || ""}\n`;
    return `error: ${String(err)}\n`;
  }

  function emitExit(code) {
    const process = globalThis.process;
    if (!process || process._exiting) return;
    process._exiting = true;
    try {
      process.emit("exit", code);
    } catch (err) {
      // An exception inside an exit handler is itself fatal.
      if (internal.workerError) internal.workerError(err);
      process.exitCode = 1;
      printError(err);
    } finally {
      if (internal.workerExit) internal.workerExit((process.exitCode | 0) || code);
      native.closeAllDirs();
    }
  }
  internal.emitExit = emitExit;

  function listenerCount(event) {
    const process = globalThis.process;
    return process && typeof process.listenerCount === "function" ? process.listenerCount(event) : 0;
  }

  // Plain messages like `Module not found "x"` print without a stack.
  function printFatal(err) {
    if (err && typeof err.__bunwasmFormatted === "string") {
      native.writeStderr(`${err.__bunwasmFormatted}Bun v${native.platformInfo.version} (WASI ${native.platformInfo.arch})\n`);
      return;
    }
    if (err && err.__bunwasmPlain) {
      native.writeStderr(`error: ${err.message}\n\nBun v${native.platformInfo.version} (WASI ${native.platformInfo.arch})\n`);
      return;
    }
    printError(err);
  }

  function handleBrokenPipe(err) {
    if (!err || err.code !== "EPIPE") return false;
    // Preserve errno through try/catch and stream callbacks first. Only an escaping broken
    // pipe takes the process's SIGPIPE disposition, rather than guessing from an I/O trap.
    if (native.hostSignal(13, 3) < 0) throw new Error("Cannot raise SIGPIPE");
    internal.pumpSignals();
    return true;
  }

  internal.handleUncaught = function handleUncaught(err) {
    if (listenerCount("uncaughtException") > 0) {
      globalThis.process.emit("uncaughtException", err, "uncaughtException");
      return true;
    }
    if (handleBrokenPipe(err)) return true;
    if (internal.workerError) internal.workerError(err);
    printFatal(err);
    globalThis.process.exitCode = 1;
    emitExit(1);
    return false;
  };

  internal.handleRejection = function handleRejection(reason) {
    if (listenerCount("unhandledRejection") > 0) {
      globalThis.process.emit("unhandledRejection", reason, undefined);
      return true;
    }
    if (handleBrokenPipe(reason)) return true;
    if (internal.workerError) internal.workerError(reason);
    printFatal(reason);
    // Bun reports exit code 0 to "exit" listeners here (and still exits 1).
    emitExit(0);
    return false;
  };

  internal.emitBeforeExit = function emitBeforeExit() {
    if (listenerCount("beforeExit") === 0) return false;
    const process = globalThis.process;
    process.emit("beforeExit", process.exitCode || 0);
    return refedTimers > 0 || immediates.length > 0 || tickQueue.length > 0;
  };

  internal.beforeExit = function beforeExit() {
    const process = globalThis.process;
    const code = (process.exitCode | 0) || 0;
    emitExit(code);
    return (process.exitCode | 0) || 0;
  };

  // --- globals ----------------------------------------------------------------

  defineGlobal("global", globalThis);
  defineGlobal("self", globalThis);

  internal.mainPath = native.mainPath();
  internal.require("web")(defineGlobal, defineLazyGlobal);
  internal.require("crypto")(defineGlobal);
  defineGlobal("process", internal.require("process"));
  if (typeof globalThis.Temporal === "undefined") defineLazyGlobal("Temporal", () => internal.require("temporal").Temporal);
  defineGlobal("console", internal.require("console"));
  defineGlobal("Bun", internal.require("bun"));
  defineLazyGlobal("Buffer", () => internal.require("buffer").Buffer);
  if (typeof globalThis.Intl === "undefined") {
    // QuickJS has no Intl: a small en-US one (intl.js), which the engine's
    // own toLocaleString methods then defer to.
    defineLazyGlobal("Intl", () => internal.require("intl"));
    defineHidden(Number.prototype, {
      toLocaleString(locales, options) {
        return new globalThis.Intl.NumberFormat(locales, options).format(Number(this));
      },
    });
    defineHidden(Date.prototype, {
      toLocaleDateString(locales, options) {
        return new globalThis.Intl.DateTimeFormat(locales, Object.assign({ year: "numeric", month: "numeric", day: "numeric" }, options)).format(this);
      },
      toLocaleTimeString(locales, options) {
        return new globalThis.Intl.DateTimeFormat(locales, Object.assign({ hour: "numeric", minute: "2-digit", second: "2-digit" }, options)).format(this);
      },
    });
  }
  defineLazyGlobal("structuredClone", () => internal.require("structured_clone").structuredClone);
  if (typeof globalThis.WebAssembly === "undefined") defineLazyGlobal("WebAssembly", () => internal.require("webassembly"));
  internal.require("builtins");
  internal.bunBuiltinGlobals = internal.require("bun_builtin_globals");
  internal.require("function");
  if (process.env.BUNWASM_WORKER_INIT) internal.require("worker_threads").initialize();

  return internal;
})
