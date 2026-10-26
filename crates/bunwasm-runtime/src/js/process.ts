// The `process` global (also `node:process`).
//
// Platform decision: `process.platform` is "linux". bun.wasm runs under a
// POSIX-like WASI host (forward-slash paths, LF line endings, POSIX errno
// codes), and "linux" is what packages branch on for those semantics. The
// architecture is reported honestly as "wasm32", so code that picks native
// binaries by `process.arch` won't find a match and can fall back.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const EventEmitter = internal.require("events");
  const info = native.platformInfo;

  const NODE_VERSION = "26.3.0";

  const processBase: BunWasm.NodeEmitter = Object.create(EventEmitter.prototype);
  EventEmitter.call(processBase);

  function errnoException(syscall: string) {
    const err: Error & { code?: string; errno?: number; syscall?: string } = new Error(`ENOSYS: function not implemented, ${syscall}`);
    err.code = "ENOSYS";
    err.errno = -38;
    err.syscall = syscall;
    return err;
  }

  // runtime_proc.signal reports a negated WASI errno: -28 EINVAL (signal number or mode the
  // process service rejects) and -58 ENOTSUP (unsupported job-control stops). Node reports the
  // same codes from uv_signal_start and kill, with libuv's errno values.
  function signalFailure(result: number, syscall: string) {
    const [code, errno] = result === -58 ? ["ENOTSUP", -95] : result === -28 ? ["EINVAL", -22] : ["EIO", -5];
    return Object.assign(new Error(`${syscall} ${code}`), { code, errno, syscall });
  }

  let execveWarned = false;

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

  function hrtime(previous?: readonly [number, number]): [number, number] {
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

  function validateCursorCallback(callback: unknown): void {
    if (callback === undefined || typeof callback === "function") return;
    throw Object.assign(new TypeError(`The "callback" argument must be of type function. Received ${internal.describe(callback)}`), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function clearLine(this: BunWasm.ProcessWriter, direction: number, callback?: BunWasm.ProcessCursorCallback): boolean {
    validateCursorCallback(callback);
    const mode = direction < 0 ? 1 : direction > 0 ? 0 : 2;
    return this.write(`\x1b[${mode}K`, callback);
  }

  function clearScreenDown(this: BunWasm.ProcessWriter, callback?: BunWasm.ProcessCursorCallback): boolean {
    validateCursorCallback(callback);
    return this.write("\x1b[0J", callback);
  }

  function cursorTo(this: BunWasm.ProcessWriter, x?: number, y?: number | BunWasm.ProcessCursorCallback, callback?: BunWasm.ProcessCursorCallback): boolean {
    validateCursorCallback(callback);
    if (typeof y === "function") {
      callback = y;
      y = undefined;
    }
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const name = Number.isNaN(x) ? "x" : "y";
      throw Object.assign(new TypeError(`The argument '${name}' is invalid. Received NaN`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    if (typeof x !== "number" && typeof y !== "number") {
      if (callback) internal.nextTick(callback, null);
      return true;
    }
    if (typeof x !== "number") {
      throw Object.assign(new TypeError("Cannot set cursor row without setting its column"), { code: "ERR_INVALID_CURSOR_POS" });
    }
    const sequence = typeof y === "number" ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`;
    return this.write(sequence, callback);
  }

  function moveCursor(this: BunWasm.ProcessWriter, dx: number, dy: number, callback?: BunWasm.ProcessCursorCallback): boolean {
    validateCursorCallback(callback);
    if (!dx && !dy) {
      if (callback) internal.nextTick(callback, null);
      return true;
    }
    let sequence = "";
    if (dx < 0) sequence += `\x1b[${-dx}D`;
    else if (dx > 0) sequence += `\x1b[${dx}C`;
    if (dy < 0) sequence += `\x1b[${-dy}A`;
    else if (dy > 0) sequence += `\x1b[${dy}B`;
    return this.write(sequence, callback);
  }

  // stdout/stderr: synchronous writers with the bits of the stream API that
  // CLI programs actually touch.
  function makeWriter(fd: number) {
    const streamBase: BunWasm.NodeEmitter = Object.create(EventEmitter.prototype);
    EventEmitter.call(streamBase);
    const write = fd === 1 ? native.writeStdout : native.writeStderr;
    type Failure = { error: unknown; callbacks: BunWasm.ProcessWriteCallback[] };
    let failure: Failure | null = null;
    function flushFailure(pending: Failure) {
      const { error, callbacks } = pending;
      for (const callback of callbacks) callback(error);
      failure = null;
      stream.writable = true;
      // A supplied write callback can consume the error itself. Still notify installed
      // stream listeners, preserving callback -> callback tick -> error event ordering.
      if (callbacks.length === 0 || stream.listenerCount("error") > 0) internal.nextTick(() => stream.emit("error", error));
    }
    const stream: BunWasm.ProcessWriter = Object.assign(streamBase, {
      fd,
      writable: true,
      destroyed: false,
      isTTY: native.isatty(fd),
      columns: Number(env.COLUMNS) || 80,
      rows: Number(env.LINES) || 24,
      write(chunk: unknown, encoding?: unknown, callback?: unknown) {
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
          const pending: Failure = { error, callbacks: typeof callback === "function" ? [callback] : [] };
          failure = pending;
          stream.writable = false;
          internal.nextTick(() => flushFailure(pending));
          return false;
        }
        if (typeof callback === "function") internal.nextTick(callback, null);
        return true;
      },
      end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
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
      clearLine,
      clearScreenDown,
      cursorTo,
      moveCursor,
      getColorDepth: () => (stream.isTTY ? 8 : 1),
      hasColors: () => stream.isTTY,
      getWindowSize: () => [stream.columns, stream.rows],
      _writableState: { ended: false },
    });
    return stream;
  }

  function makeReader() {
    return internal.require("process_stdin")();
  }

  let stdout: BunWasm.ProcessWriter | undefined;
  let stderr: BunWasm.ProcessWriter | undefined;
  let stdin: BunWasm.ProcessReader | undefined;

  // Linux standard names and the aliases exposed by Node/Bun's os.constants.signals.
  // Realtime signals have numeric support only; do not invent JS spellings for them.
  const signals: Record<string | symbol, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
    SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
    SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
    SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
    SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29,
    SIGPWR: 30, SIGSYS: 31,
  };
  const signalNames = new Map<number, string[]>();
  for (const [name, number] of Object.entries(signals)) {
    if (!signalNames.has(number)) signalNames.set(number, []);
    signalNames.get(number)!.push(name);
  }
  const dispositions = new Map<number, number>();
  function publishSignalDisposition(number: number) {
    if (number === 9) return; // SIGKILL cannot acquire a handler or ignored disposition.
    // SIGPIPE starts ignored, but Node/Bun restore DEFAULT after its last handler is removed.
    // An unrelated removeAllListeners must preserve a signal that was still ignored.
    // Aliases are distinct events but share the host's single numeric disposition.
    const handled = signalNames.get(number)!.some((name) => processBase.listenerCount(name) > 0);
    const disposition = handled ? 2 : dispositions.get(number) === 1 ? 1 : 0;
    if ((dispositions.get(number) || 0) === disposition) return;
    const result = native.hostSignal(number, disposition);
    if (result < 0) throw signalFailure(result, "uv_signal_start");
    dispositions.set(number, disposition);
  }
  // EventEmitter invokes this after its actual mutation, before removeListener observers.
  // This also covers once wrappers and direct EventEmitter.prototype calls on process.
  internal.listenerChanged = function listenerChanged(target, name) {
    if (target !== processBase) return;
    if (name === undefined) {
      for (const number of signalNames.keys()) publishSignalDisposition(number);
    } else if (Object.hasOwn(signals, name)) publishSignalDisposition(signals[name]);
  };
  // Publish the runtime's JS-only startup default before user code can write to stdio.
  const startup = native.hostSignal(13, 1);
  if (startup < 0) throw signalFailure(startup, "uv_signal_start");
  dispositions.set(13, 1);
  internal.pumpSignals = internal.require("process_signals")(processBase, signalNames);

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
    argv0: native.argv()[0],
    execArgv: native.execArgv(),
    execPath: native.execPath(),
    env,
    pid: 1,
    ppid: 0,
    exitCode: undefined,
    noDeprecation: false,
    isBun: true,
    browser: false,
    config: { target_defaults: {}, variables: {} },
    features: { inspector: false, debug: false, uv: false, ipv6: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false, cached_builtins: true, typescript: "transform" },
    allowedNodeEnvironmentFlags: new Set(),
    cwd: () => native.cwd(),
    chdir: (dir: unknown) => native.chdir(internal.require("path").resolve(String(dir))),
    // Erased operand bridges only: the original | operator must coerce unknown input,
    // reread accessors, and throw for Symbols/BigInts without a pre-conversion.
    exit(code?: unknown) {
      if (code !== undefined) process.exitCode = code;
      const exitCode = ((process.exitCode as number) | 0) || 0;
      internal.emitExit(exitCode);
      internal.traceExit("process.exit", ((process.exitCode as number) | 0) || exitCode);
      native.exit(((process.exitCode as number) | 0) || exitCode);
    },
    reallyExit: (code: unknown) => { internal.traceExit("process.reallyExit", (code as number) | 0); native.exit((code as number) | 0); },
    abort: () => { internal.traceExit("process.abort", 134); native.exit(134); },
    // Bun's contract where the process image cannot be replaced (its Windows build):
    // workers are rejected first, then the main thread warns once and throws.
    execve() {
      if (!internal.require("worker_threads").isMainThread) {
        throw Object.assign(new TypeError("Calling process.execve is not supported in workers"), { code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
      }
      if (!execveWarned) process.emitWarning("process.execve is an experimental feature and might change at any time", "ExperimentalWarning");
      execveWarned = true;
      throw Object.assign(new TypeError("The feature process.execve is unavailable on the current platform, which is being used to run Node.js"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
    },
    kill(pid: unknown, signal: unknown = "SIGTERM") {
      const number = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()];
      if (!Number.isInteger(number) || number < 0 || number > 64) throw new TypeError(`Unknown signal: ${signal}`);
      if (pid === process.pid) {
        if (number === 0) return true;
        const result = native.hostSignal(number, 3);
        if (result < 0) throw signalFailure(result, "kill");
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
    emitWarning(warning: unknown, type?: string | BunWasm.ProcessWarningOptions | null, code?: unknown) {
      if (internal.workerNoWarnings) return;
      const opts = type !== null && typeof type === "object" ? type : { type, code };
      const name = warning instanceof Error ? warning.name : opts.type || "Warning";
      const message = warning instanceof Error ? warning.message : String(warning);
      if (process.listenerCount("warning") > 0) {
        const err: Omit<Error, "name"> & { name: unknown; code?: unknown } = warning instanceof Error ? warning : Object.assign(new Error(message), { name });
        if (opts.code) err.code = opts.code;
        internal.nextTick(() => process.emit("warning", err));
        return;
      }
      const prefix = opts.code ? `[${opts.code}] ` : "";
      native.writeStderr(`${prefix}${name}: ${message}\n`);
    },
    binding(name: unknown) {
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
  const process: BunWasm.NodeEmitter & { exitCode: unknown; pid: number; stdin?: unknown; emitWarning(warning: unknown, type?: string | BunWasm.ProcessWarningOptions | null, code?: unknown): void } = Object.assign(processBase, props);
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
