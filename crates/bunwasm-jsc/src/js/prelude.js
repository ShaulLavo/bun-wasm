// Globals for bun-jsc: Bun's JavaScriptCore with a small Bun/Node surface on top.
// Evaluated as a classic script; the completion value is this factory. main.rs calls it with
// the natives and the polyfill factories shared with bunwasm-runtime (inspect.js, console.js,
// path.js, buffer.js, all engine-agnostic), and gets back the hooks its event loop drives.
(function (native, factories) {
  "use strict";
  const g = globalThis;

  // --- module registry for the shared polyfills -------------------------------
  const builtins = new Map();
  const internal = {
    native,
    toUint8(v) {
      if (v instanceof Uint8Array) return v;
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      return native.encodeUtf8(String(v));
    },
    require(id) {
      if (builtins.has(id)) return builtins.get(id);
      const factory = factories[id];
      if (!factory) throw new Error(`bun-jsc: no internal module "${id}"`);
      const exports = factory(internal);
      builtins.set(id, exports);
      return exports;
    },
  };

  const inspectHooks = {
    promiseState(p) {
      const s = native.promiseState(p);
      return s === 0 ? "pending" : s === 1 ? "fulfilled" : "rejected";
    },
    promiseResult: (p) => native.promiseResult(p),
    isProxy: (v) => native.proxyTarget(v) !== null,
    getProxyTarget: (v) => native.proxyTarget(v),
    isPromise: (v) => native.promiseState(v) !== -1,
    // Frames are mapped back to the original files (the bundle's inline source map), whose
    // text is in the map's sourcesContent.
    getSourceLine: (file, n) => {
      const map = sourceMap();
      const i = map ? map.files.indexOf(file) : -1;
      if (i < 0 || map.contents[i] == null) return undefined;
      return map.contents[i].split("\n")[n - 1];
    },
    isESMNamespace: () => false,
  };
  builtins.set("inspect", factories.inspect(inspectHooks));
  const inspect = builtins.get("inspect");

  // --- text encoding ----------------------------------------------------------
  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      return native.encodeUtf8(String(input));
    }
    encodeInto(source, dest) {
      const bytes = native.encodeUtf8(String(source));
      const n = Math.min(bytes.length, dest.length);
      // Don't split a UTF-8 sequence at the end of dest.
      let end = n;
      if (n < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      dest.set(bytes.subarray(0, end));
      const read = native.decodeUtf8(bytes.subarray(0, end), false).length;
      return { read, written: end };
    }
  }
  class TextDecoder {
    constructor(label = "utf-8", options = {}) {
      const l = String(label).toLowerCase();
      if (l !== "utf-8" && l !== "utf8" && l !== "unicode-1-1-utf-8") throw new RangeError(`Unsupported encoding: ${label}`);
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() {
      return "utf-8";
    }
    decode(input) {
      if (input === undefined) return "";
      let bytes = internal.toUint8(input);
      if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
      return native.decodeUtf8(bytes, this.fatal);
    }
  }
  g.TextEncoder = TextEncoder;
  g.TextDecoder = TextDecoder;

  // --- errors -----------------------------------------------------------------
  // fs natives throw "CODE: description, syscall 'path'" (Bun's wording); add Node's fields.
  const ERRNO = { ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOTEMPTY: -39, EIO: -5 };
  function fsCall(fn, ...args) {
    try {
      return fn(...args);
    } catch (e) {
      const m = /^([A-Z]+): .*?, (\w+)(?: '(.*)')?$/.exec(e && e.message);
      if (m) {
        e.code = m[1];
        e.errno = ERRNO[m[1]];
        e.syscall = m[2];
        if (m[3] !== undefined) e.path = m[3];
      }
      throw e;
    }
  }

  // --- stack traces -----------------------------------------------------------
  // JSC writes `name@file:line:column` frames into err.stack, in bundle positions. Bun prints
  // V8-style `at name (file:line:column)` frames in source positions: convert before printing.
  const VLQ = new Map(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", (c, i) => [c, i]));
  let smap;
  function sourceMap() {
    if (smap !== undefined) return smap;
    smap = null;
    const m = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(entrySource || "");
    if (!m) return null;
    const json = JSON.parse(native.decodeUtf8(native.decodeBase64(m[1]), false));
    const dir = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
    const files = json.sources.map((s) => (s.startsWith("/") ? s : normalizePath(dir + s)));
    const lines = [];
    let src = 0, oline = 0, ocol = 0;
    for (const lineText of json.mappings.split(";")) {
      const segs = [];
      let gcol = 0;
      for (const seg of lineText.split(",")) {
        if (!seg) continue;
        const v = [];
        let value = 0, shift = 0;
        for (const ch of seg) {
          const d = VLQ.get(ch);
          value += (d & 31) << shift;
          if (d & 32) shift += 5;
          else {
            v.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        gcol += v[0];
        if (v.length >= 4) {
          src += v[1];
          oline += v[2];
          ocol += v[3];
          segs.push([gcol, src, oline, ocol]);
        }
      }
      lines.push(segs);
    }
    smap = { files, contents: json.sourcesContent || [], lines };
    return smap;
  }
  function normalizePath(p) {
    const out = [];
    for (const part of p.split("/")) {
      if (part === "..") out.pop();
      else if (part !== "." && part !== "") out.push(part);
    }
    return "/" + out.join("/");
  }
  function mapPosition(file, line, col) {
    const map = file === entryPath ? sourceMap() : null;
    const segs = map && map.lines[line - 1];
    if (!segs || !segs.length) return [file, line, col];
    let best = segs[0];
    for (const s of segs) if (s[0] <= col - 1) best = s;
    return [map.files[best[1]], best[2] + 1, best[3] + 1];
  }
  function v8Stack(err) {
    const stack = typeof err.stack === "string" ? err.stack : "";
    if (/^\s+at /m.test(stack)) return stack;
    const frames = [];
    for (const raw of stack.split("\n")) {
      const m = /^(.*?)@(.*):(\d+):(\d+)$/.exec(raw);
      if (!m || m[2].startsWith("bun-jsc:")) continue;
      const [file, line, col] = mapPosition(m[2], Number(m[3]), Number(m[4]));
      const name = m[1] === "global code" || m[1] === "module code" || m[1] === "eval code" ? "" : m[1] || "<anonymous>";
      frames.push(name ? `    at ${name} (${file}:${line}:${col})` : `    at ${file}:${line}:${col}`);
    }
    return `${err.name}: ${err.message}\n${frames.join("\n")}`;
  }

  function printError(err) {
    let text;
    try {
      if (err instanceof Error) {
        const desc = Object.getOwnPropertyDescriptor(err, "stack");
        if (!desc || desc.writable || desc.configurable) Object.defineProperty(err, "stack", { value: v8Stack(err), writable: true, configurable: true, enumerable: false });
      }
      text = inspect.formatError(err);
    } catch {
      text = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack || ""}\n` : `error: ${String(err)}\n`;
    }
    native.writeStderr(text.endsWith("\n") ? text : text + "\n");
    native.writeStderr(`\nBun v${native.version} (WASI wasm32)\n`);
  }

  // --- process ----------------------------------------------------------------
  const listeners = new Map();
  const process = {
    argv: JSON.parse(native.argv),
    env: JSON.parse(native.env),
    execArgv: [],
    platform: "wasi",
    arch: "wasm32",
    version: "v24.3.0",
    versions: { bun: native.version, node: "24.3.0" },
    pid: 1,
    exitCode: undefined,
    title: "bun",
    cwd: () => native.cwd(),
    exit(code) {
      if (code !== undefined) process.exitCode = code;
      emitExit();
      native.exit(process.exitCode | 0);
    },
    nextTick(fn, ...args) {
      if (typeof fn !== "function") throw new TypeError('The "callback" argument must be of type function');
      ticks.push([fn, args]);
    },
    hrtime: Object.assign(
      function hrtime(prev) {
        const ns = BigInt(Math.round(native.now() * 1e6));
        let s = Number(ns / 1000000000n),
          n = Number(ns % 1000000000n);
        if (prev) {
          s -= prev[0];
          n -= prev[1];
          if (n < 0) {
            s--;
            n += 1e9;
          }
        }
        return [s, n];
      },
      { bigint: () => BigInt(Math.round(native.now() * 1e6)) },
    ),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return process;
    },
    once(event, fn) {
      const wrapped = (...a) => {
        process.off(event, wrapped);
        fn(...a);
      };
      return process.on(event, wrapped);
    },
    off(event, fn) {
      const l = listeners.get(event);
      if (l) {
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      }
      return process;
    },
    emit(event, ...args) {
      const l = listeners.get(event);
      if (!l || l.length === 0) return false;
      for (const fn of l.slice()) fn(...args);
      return true;
    },
    listenerCount: (event) => (listeners.get(event) || []).length,
    stdout: { write: (s) => (native.writeStdout(typeof s === "string" ? s : internal.toUint8(s)), true), isTTY: false },
    stderr: { write: (s) => (native.writeStderr(typeof s === "string" ? s : internal.toUint8(s)), true), isTTY: false },
  };
  process.addListener = process.on;
  process.removeListener = process.off;
  g.process = process;

  const ticks = [];
  let exiting = false;
  function emitExit() {
    if (exiting) return;
    exiting = true;
    try {
      process.emit("exit", process.exitCode | 0);
    } catch (err) {
      printError(err);
      process.exitCode = 1;
    }
  }

  // --- microtasks and timers --------------------------------------------------
  g.queueMicrotask = function queueMicrotask(fn) {
    if (typeof fn !== "function") throw new TypeError("queueMicrotask requires a function");
    Promise.resolve().then(() => {
      try {
        fn();
      } catch (err) {
        handleUncaught(err);
      }
    });
  };

  let nextId = 1;
  let seq = 0;
  const timers = new Map();
  class Timeout {
    constructor(id) {
      this._id = id;
    }
    ref() {
      const t = timers.get(this._id);
      if (t) t.ref = true;
      return this;
    }
    unref() {
      const t = timers.get(this._id);
      if (t) t.ref = false;
      return this;
    }
    hasRef() {
      const t = timers.get(this._id);
      return !!(t && t.ref);
    }
    refresh() {
      const t = timers.get(this._id);
      if (t) {
        t.at = native.now() + t.ms;
        t.seq = seq++;
      }
      return this;
    }
    close() {
      timers.delete(this._id);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }
  function addTimer(fn, ms, args, repeat) {
    if (typeof fn !== "function") throw new TypeError('The "callback" argument must be of type function');
    ms = Number(ms);
    if (!(ms >= 1) || ms > 2147483647) ms = 1;
    const id = nextId++;
    timers.set(id, { fn, args, ms, at: native.now() + ms, repeat, ref: true, seq: seq++ });
    return new Timeout(id);
  }
  function clearTimer(t) {
    if (t == null) return;
    timers.delete(typeof t === "object" ? t._id : Number(t));
  }
  g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  g.setImmediate = (fn, ...args) => addTimer(fn, 0, args, false);
  g.clearTimeout = g.clearInterval = g.clearImmediate = clearTimer;

  function dueTimer() {
    let best = null;
    for (const [id, t] of timers) if (!best || t.at < best[1].at || (t.at === best[1].at && t.seq < best[1].seq)) best = [id, t];
    return best;
  }

  // --- uncaught errors and rejections -----------------------------------------
  function handleUncaught(err) {
    if (process.listenerCount("uncaughtException") > 0) {
      process.emit("uncaughtException", err, "uncaughtException");
      return;
    }
    printError(err);
    process.exitCode = 1;
    emitExit();
    native.exit(1);
  }
  function handleRejection(promise, reason) {
    if (process.listenerCount("unhandledRejection") > 0) {
      process.emit("unhandledRejection", reason, promise);
      return;
    }
    printError(reason);
    // Bun reports 0 to "exit" listeners here, then exits with 1.
    emitExit();
    native.exit(1);
  }

  // --- performance ------------------------------------------------------------
  const timeOrigin = native.now();
  g.performance = { now: () => native.now() - timeOrigin, timeOrigin: Date.now() - (native.now() - timeOrigin) };

  // --- fs / Bun.file ----------------------------------------------------------
  function toPath(p) {
    if (p && typeof p === "object" && typeof p.href === "string" && p.protocol === "file:") return decodeURIComponent(p.pathname);
    return String(p);
  }
  function encodingOf(options) {
    return typeof options === "string" ? options : options && options.encoding;
  }
  function toBuffer(bytes) {
    const { Buffer } = internal.require("buffer");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function dataBytes(data) {
    if (typeof data === "string") return data;
    if (data && typeof data.__bunFilePath === "string") return fsCall(native.readFileBytes, data.__bunFilePath);
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data);
    return String(data);
  }
  const fs = {
    readFileSync(path, options) {
      const enc = encodingOf(options);
      if (enc === "utf8" || enc === "utf-8") return fsCall(native.readFileText, toPath(path));
      const bytes = fsCall(native.readFileBytes, toPath(path));
      if (enc) return toBuffer(bytes).toString(enc);
      return toBuffer(bytes);
    },
    writeFileSync(path, data, options) {
      const flag = options && typeof options === "object" ? options.flag : undefined;
      fsCall(native.writeFile, toPath(path), dataBytes(data), flag === "a");
    },
    appendFileSync(path, data) {
      fsCall(native.writeFile, toPath(path), dataBytes(data), true);
    },
    existsSync: (path) => native.exists(toPath(path)),
    readdirSync: (path) => JSON.parse(fsCall(native.readdir, toPath(path))),
    mkdirSync(path, options) {
      fsCall(native.mkdir, toPath(path), !!(options && options.recursive));
    },
    rmSync(path, options) {
      fsCall(native.rm, toPath(path), !!(options && options.recursive), !!(options && options.force));
    },
  };
  fs.unlinkSync = (path) => fs.rmSync(path);
  fs.promises = {
    readFile: async (p, o) => fs.readFileSync(p, o),
    writeFile: async (p, d, o) => fs.writeFileSync(p, d, o),
    appendFile: async (p, d) => fs.appendFileSync(p, d),
    readdir: async (p) => fs.readdirSync(p),
    mkdir: async (p, o) => fs.mkdirSync(p, o),
    rm: async (p, o) => fs.rmSync(p, o),
  };

  function BunFile(path) {
    const p = toPath(path);
    return {
      __bunFilePath: p,
      name: p,
      type: p.endsWith(".json") ? "application/json;charset=utf-8" : "text/plain;charset=utf-8",
      get size() {
        return native.exists(p) ? native.readFileBytes(p).length : 0;
      },
      text: async () => fsCall(native.readFileText, p),
      json: async () => JSON.parse(fsCall(native.readFileText, p)),
      bytes: async () => fsCall(native.readFileBytes, p),
      arrayBuffer: async () => {
        const b = fsCall(native.readFileBytes, p);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      exists: async () => native.exists(p),
    };
  }

  // --- Bun --------------------------------------------------------------------
  const Bun = {
    version: native.version,
    revision: "",
    argv: process.argv,
    env: process.env,
    main: process.argv[1],
    file: BunFile,
    async write(dest, data) {
      const path = dest && typeof dest.__bunFilePath === "string" ? dest.__bunFilePath : toPath(dest);
      const bytes = dataBytes(data);
      fsCall(native.writeFile, path, bytes, false);
      return typeof bytes === "string" ? native.encodeUtf8(bytes).length : bytes.length;
    },
    sleep: (ms) => new Promise((resolve) => g.setTimeout(resolve, ms)),
    sleepSync: (ms) => native.sleep(ms),
    nanoseconds: () => Math.round((native.now() - timeOrigin) * 1e6),
    inspect: inspect.bunInspect,
    isMainThread: true,
  };
  g.Bun = Bun;

  // --- console, Buffer, require -----------------------------------------------
  g.console = internal.require("console");
  const bufferModule = internal.require("buffer");
  g.Buffer = bufferModule.Buffer;
  if (typeof g.atob !== "function" && bufferModule.atob) {
    g.atob = bufferModule.atob;
    g.btoa = bufferModule.btoa;
  }

  const util = {
    inspect: inspect.nodeInspect,
    format: inspect.nodeFormat,
    formatWithOptions: inspect.nodeFormatWithOptions,
    promisify: (fn) => (...args) => new Promise((res, rej) => fn(...args, (e, v) => (e ? rej(e) : res(v)))),
    isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    types: { isPromise: inspectHooks.isPromise, isProxy: inspectHooks.isProxy },
    TextEncoder,
    TextDecoder,
  };
  const modules = {
    fs: () => fs,
    "fs/promises": () => fs.promises,
    path: () => internal.require("path"),
    "path/posix": () => internal.require("path"),
    util: () => util,
    buffer: () => bufferModule,
    process: () => process,
    timers: () => ({ setTimeout: g.setTimeout, setInterval: g.setInterval, setImmediate: g.setImmediate, clearTimeout: clearTimer, clearInterval: clearTimer, clearImmediate: clearTimer }),
    "timers/promises": () => ({ setTimeout: (ms, v) => new Promise((r) => g.setTimeout(() => r(v), ms)), setImmediate: (v) => new Promise((r) => g.setImmediate(() => r(v))) }),
  };
  const moduleCache = new Map();
  function requireBuiltin(id) {
    const name = String(id).replace(/^node:/, "");
    if (moduleCache.has(name)) return moduleCache.get(name);
    const make = modules[name];
    if (!make) {
      const err = new Error(`Cannot find module '${id}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    const m = make();
    if (m && typeof m === "object" && !("default" in m)) Object.defineProperty(m, "default", { value: m, enumerable: false, configurable: true });
    moduleCache.set(name, m);
    return m;
  }
  g.require = requireBuiltin;

  // --- ES modules -------------------------------------------------------------
  // The entry is one bundled module; the only imports left in it are builtins, served as
  // modules re-exporting what `require` returns.
  const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "));
  function builtinSource(name) {
    const m = requireBuiltin(name);
    const names = m && (typeof m === "object" || typeof m === "function") ? Object.keys(m).filter((k) => k !== "default") : [];
    let src = `const m = globalThis.require(${JSON.stringify(name)});\nexport default m;\n`;
    names.forEach((k, i) => {
      src += `const e${i} = m[${JSON.stringify(k)}];\n`;
    });
    if (names.length) src += `export { ${names.map((k, i) => `e${i} as ${/^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k) ? k : JSON.stringify(k)}`).join(", ")} };\n`;
    return src;
  }
  let entryKey = null;
  let entrySource = null;
  let entryPath = null;

  // --- hooks for main.rs ------------------------------------------------------
  return {
    setEntry(key, source) {
      entryKey = key;
      entrySource = source;
      entryPath = decodeURIComponent(key.replace(/^file:\/\//, ""));
      requireBuiltin.main = { id: ".", filename: decodeURIComponent(key.replace(/^file:\/\//, "")), loaded: false };
    },
    // Source text for a module key (cpp/helpers.cpp calls it from the loader's fetch hook).
    fetchModule(key) {
      if (key === entryKey) return entrySource;
      if (key.startsWith("node:")) return builtinSource(key.slice(5));
      if (key.startsWith("file://")) return fsCall(native.readFileText, decodeURIComponent(key.slice(7)));
      throw new Error(`Cannot find module '${key}'`);
    },
    importMeta(meta, key) {
      if (!key.startsWith("file://")) return;
      meta.file = meta.path.slice(meta.path.lastIndexOf("/") + 1);
      meta.resolve = (specifier) => {
        const s = String(specifier);
        if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
          const base = s.startsWith("/") ? [] : meta.dir.split("/").filter(Boolean);
          for (const part of s.split("/")) {
            if (part === "..") base.pop();
            else if (part !== "." && part !== "") base.push(part);
          }
          return "file:///" + base.join("/");
        }
        if (modules[s.replace(/^node:/, "")]) return s.startsWith("node:") ? s : "node:" + s;
        const err = new Error(`Cannot find module '${s}' from '${meta.path}'`);
        err.code = "MODULE_NOT_FOUND";
        throw err;
      };
    },
    watchMain(promise) {
      promise.then(() => {
        if (requireBuiltin.main) requireBuiltin.main.loaded = true;
      }, handleUncaught);
    },
    // ms until the next referenced timer is due, 0 if one is due, -1 if none keep the loop alive.
    nextDelay() {
      let alive = false;
      for (const t of timers.values()) if (t.ref) alive = true;
      if (!alive) return -1;
      const best = dueTimer();
      return Math.max(0, best[1].at - native.now());
    },
    // Runs the earliest due timer; main.rs drains microtasks after each call.
    runTimer() {
      const best = dueTimer();
      if (!best || best[1].at > native.now()) return;
      const [id, t] = best;
      if (t.repeat) {
        t.at = native.now() + t.ms;
        t.seq = seq++;
      } else timers.delete(id);
      t.fn(...t.args);
    },
    // The nextTick queue; main.rs runs it before each microtask drain. Returns whether it ran any.
    runTicks() {
      if (ticks.length === 0) return false;
      while (ticks.length) {
        const [fn, args] = ticks.shift();
        try {
          fn(...args);
        } catch (err) {
          handleUncaught(err);
        }
      }
      return true;
    },
    handleUncaught,
    handleRejection,
    exit() {
      emitExit();
      return process.exitCode | 0;
    },
  };
});
