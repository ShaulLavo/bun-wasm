// The `process` global (also `node:process`).
//
// Platform decision: `process.platform` is "linux". bun.wasm runs under a
// POSIX-like WASI host (forward-slash paths, LF line endings, POSIX errno
// codes), and "linux" is what packages branch on for those semantics. The
// architecture is reported honestly as "wasm32", so code that picks native
// binaries by `process.arch` won't find a match and can fall back.
(function (internal) {
  "use strict";
  const native = internal.native;
  const EventEmitter = internal.require("events");
  const info = native.platformInfo;

  const NODE_VERSION = "26.3.0";

  const process = Object.create(EventEmitter.prototype);
  EventEmitter.call(process);

  function errnoException(syscall) {
    const err = new Error(`ENOSYS: function not implemented, ${syscall}`);
    err.code = "ENOSYS";
    err.errno = -38;
    err.syscall = syscall;
    return err;
  }

  // Like Node, assigned values become strings (`process.env.N = 1` -> "1").
  const env = new Proxy(native.env(), {
    set(target, key, value) {
      target[key] = typeof key === "symbol" ? value : String(value);
      if (typeof key === "string" && internal.workerEnvChange) internal.workerEnvChange(key, target[key]);
      return true;
    },
    deleteProperty(target, key) {
      delete target[key];
      if (typeof key === "string" && internal.workerEnvChange) internal.workerEnvChange(key, undefined);
      return true;
    },
    defineProperty(target, key, descriptor) {
      if ("value" in descriptor && typeof key !== "symbol") descriptor = Object.assign({}, descriptor, { value: String(descriptor.value) });
      const result = Reflect.defineProperty(target, key, descriptor);
      if (result && typeof key === "string" && internal.workerEnvChange) internal.workerEnvChange(key, target[key]);
      return result;
    },
  });

  function hrtime(previous) {
    const ns = internal.fakeTimers?.elapsedNanoseconds ?? native.nanoseconds();
    let sec = Math.floor(ns / 1e9);
    let nsec = Math.floor(ns % 1e9);
    if (previous) {
      sec -= previous[0];
      nsec -= previous[1];
      if (nsec < 0) {
        sec -= 1;
        nsec += 1e9;
      }
    }
    return [sec, nsec];
  }
  hrtime.bigint = () => BigInt(Math.floor(internal.fakeTimers?.elapsedNanoseconds ?? native.nanoseconds()));

  function memoryUsage() {
    return native.memoryUsage();
  }
  memoryUsage.rss = () => native.memoryUsage().rss;

  // stdout/stderr: synchronous writers with the bits of the stream API that
  // CLI programs actually touch.
  function makeWriter(fd) {
    const stream = Object.create(EventEmitter.prototype);
    EventEmitter.call(stream);
    const write = fd === 1 ? native.writeStdout : native.writeStderr;
    let failure = null;
    function flushFailure() {
      const { error, callbacks } = failure;
      for (const callback of callbacks) callback(error);
      failure = null;
      stream.writable = true;
      // A supplied write callback can consume the error itself. Still notify installed
      // stream listeners, preserving callback -> callback tick -> error event ordering.
      if (callbacks.length === 0 || stream.listenerCount("error") > 0) internal.nextTick(() => stream.emit("error", error));
    }
    Object.assign(stream, {
      fd,
      writable: true,
      destroyed: false,
      isTTY: native.isatty(fd),
      columns: Number(env.COLUMNS) || 80,
      rows: Number(env.LINES) || 24,
      write(chunk, encoding, callback) {
        if (typeof encoding === "function") callback = encoding;
        if (failure) {
          if (typeof callback === "function") failure.callbacks.push(callback);
          return false;
        }
        try {
          // This API is synchronous: surface a buffered stdout failure to this write's
          // callback/listener path, not to an unrelated later event-loop flush.
          write(typeof chunk === "string" ? chunk : internal.toUint8(chunk), true);
        } catch (error) {
          failure = { error, callbacks: typeof callback === "function" ? [callback] : [] };
          stream.writable = false;
          internal.nextTick(flushFailure);
          return false;
        }
        if (typeof callback === "function") internal.nextTick(callback, null);
        return true;
      },
      end(chunk, encoding, callback) {
        if (typeof chunk === "function") callback = chunk;
        else if (chunk !== undefined && chunk !== null) stream.write(chunk, encoding);
        if (typeof callback === "function") internal.nextTick(callback);
        return stream;
      },
      cork() {},
      uncork() {},
      setDefaultEncoding() {
        return stream;
      },
      getColorDepth: () => (stream.isTTY ? 8 : 1),
      hasColors: () => stream.isTTY,
      getWindowSize: () => [stream.columns, stream.rows],
      _writableState: { ended: false },
    });
    return stream;
  }

  // stdin: reads everything on first use (WASI stdin is a blocking pipe or
  // file; there is no async notification).
  function makeReader() {
    const stream = Object.create(EventEmitter.prototype);
    EventEmitter.call(stream);
    let started = false;
    let encoding = null;
    function start() {
      if (started) return;
      started = true;
      setImmediate(() => {
        const bytes = native.readStdin();
        if (bytes.length > 0) stream.emit("data", encoding ? native.utf8Decode(bytes) : internal.require("buffer").Buffer.from(bytes));
        stream.emit("end");
        stream.emit("close");
      });
    }
    stream.on("newListener", (event) => {
      if (event === "data" || event === "readable" || event === "end") start();
    });
    Object.assign(stream, {
      fd: 0,
      isTTY: native.isatty(0),
      readable: true,
      setEncoding(enc) {
        encoding = enc;
        return stream;
      },
      resume() {
        start();
        return stream;
      },
      pause: () => stream,
      setRawMode: () => stream,
      ref: () => stream,
      unref: () => stream,
      read() {
        return null;
      },
      async *[Symbol.asyncIterator]() {
        started = true;
        const bytes = native.readStdin();
        if (bytes.length > 0) yield encoding ? native.utf8Decode(bytes) : internal.require("buffer").Buffer.from(bytes);
      },
    });
    return stream;
  }

  let stdout;
  let stderr;
  let stdin;

  const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };
  const signalNames = new Map(Object.entries(signals).map(([name, number]) => [number, name]));
  const dispositions = new Map();
  function publishSignalDisposition(name) {
    const number = signals[name];
    if (number === 9) return; // SIGKILL cannot acquire a handler or ignored disposition.
    // SIGPIPE starts ignored, but Node/Bun restore DEFAULT after its last handler is removed.
    // An unrelated removeAllListeners must preserve a signal that was still ignored.
    const disposition = process.listenerCount(name) > 0 ? 2 : dispositions.get(number) === 1 ? 1 : 0;
    if ((dispositions.get(number) || 0) === disposition) return;
    if (native.hostSignal(number, disposition) < 0) throw new Error(`Cannot set ${name} disposition`);
    dispositions.set(number, disposition);
  }
  // EventEmitter invokes this after its actual mutation, before removeListener observers.
  // This also covers once wrappers and direct EventEmitter.prototype calls on process.
  internal.listenerChanged = function listenerChanged(target, name) {
    if (target !== process) return;
    if (name === undefined) {
      for (const signal of Object.keys(signals)) publishSignalDisposition(signal);
    } else if (Object.hasOwn(signals, name)) publishSignalDisposition(name);
  };
  // Publish the runtime's JS-only startup default before user code can write to stdio.
  if (native.hostSignal(13, 1) < 0) throw new Error("Cannot set SIGPIPE disposition");
  dispositions.set(13, 1);
  internal.pumpSignals = function pumpSignals() {
    let progress = false;
    for (;;) {
      const number = native.hostSignal(0, 0);
      if (number <= 0) return progress;
      const name = signalNames.get(number);
      if (!name) throw new Error(`Cannot dispatch signal ${number}`);
      // The host clears pending first. A once listener can therefore restore DEFAULT before
      // its callback runs without reclassifying this already delivered, handled signal.
      process.emit(name, name);
      progress = true;
    }
  };

  const props = {
    title: "bun",
    version: `v${NODE_VERSION}`,
    versions: {
      node: NODE_VERSION,
      bun: info.version,
      quickjs: "ng",
      modules: "147",
      wasi: "preview1",
    },
    revision: info.revision,
    arch: info.arch,
    platform: "linux",
    release: { name: "node", sourceUrl: "", headersUrl: "" },
    argv: native.argv(),
    argv0: "bun",
    execArgv: [],
    execPath: "/usr/local/bin/bun",
    env,
    pid: 1,
    ppid: 0,
    exitCode: undefined,
    isBun: true,
    browser: false,
    config: { target_defaults: {}, variables: {} },
    features: { inspector: false, debug: false, uv: false, ipv6: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false, cached_builtins: true, typescript: "transform" },
    allowedNodeEnvironmentFlags: new Set(),
    cwd: () => native.cwd(),
    chdir: (dir) => native.chdir(internal.require("path").resolve(String(dir))),
    exit(code) {
      if (code !== undefined) process.exitCode = code;
      const exitCode = (process.exitCode | 0) || 0;
      internal.emitExit(exitCode);
      native.exit((process.exitCode | 0) || exitCode);
    },
    reallyExit: (code) => native.exit(code | 0),
    abort: () => native.exit(134),
    kill(pid, signal = "SIGTERM") {
      const number = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()];
      if (!Number.isInteger(number) || number < 0 || number > 64) throw new TypeError(`Unknown signal: ${signal}`);
      if (pid === process.pid) {
        if (number === 0) return true;
        if (native.hostSignal(number, 3) < 0) throw new Error(`Cannot send signal ${signal}`);
        return true;
      }
      throw errnoException("kill");
    },
    nextTick: internal.nextTick,
    hrtime,
    memoryUsage,
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: native.memoryUsage().rss / 1024 }),
    cpuUsage: () => ({ user: Math.floor(native.now() * 1000), system: 0 }),
    uptime: () => native.now() / 1000,
    umask: () => 0o22,
    getuid: () => 0,
    geteuid: () => 0,
    getgid: () => 0,
    getegid: () => 0,
    getgroups: () => [],
    setuid() {},
    setgid() {},
    emitWarning(warning, type, code) {
      if (internal.workerNoWarnings) return;
      const opts = type !== null && typeof type === "object" ? type : { type, code };
      const name = warning instanceof Error ? warning.name : opts.type || "Warning";
      const message = warning instanceof Error ? warning.message : String(warning);
      if (process.listenerCount("warning") > 0) {
        const err = warning instanceof Error ? warning : Object.assign(new Error(message), { name });
        if (opts.code) err.code = opts.code;
        internal.nextTick(() => process.emit("warning", err));
        return;
      }
      const prefix = opts.code ? `[${opts.code}] ` : "";
      native.writeStderr(`${prefix}${name}: ${message}\n`);
    },
    binding(name) {
      throw new Error(`No such module: ${name}`);
    },
    dlopen() {
      throw new Error("process.dlopen is not supported in bun-wasm");
    },
    setSourceMapsEnabled() {},
    hasUncaughtExceptionCaptureCallback: () => false,
    setUncaughtExceptionCaptureCallback() {},
    getActiveResourcesInfo: () => [],
    constrainedMemory: () => 0,
    availableMemory: () => 4294967296 - native.memoryUsage().rss,
    report: { getReport: () => ({ header: {} }) },
    stdin: undefined,
  };
  Object.assign(process, props);
  delete process.stdin;

  Object.defineProperties(process, {
    stdout: { get: () => stdout || (stdout = makeWriter(1)), configurable: true, enumerable: true },
    stderr: { get: () => stderr || (stderr = makeWriter(2)), configurable: true, enumerable: true },
    stdin: { get: () => stdin || (stdin = makeReader()), configurable: true, enumerable: true },
    mainModule: { get: () => internal.getMainModule(), configurable: true, enumerable: false },
    _exiting: { value: false, writable: true, configurable: true, enumerable: false },
    [Symbol.toStringTag]: { value: "process", configurable: true },
  });

  return process;
})
