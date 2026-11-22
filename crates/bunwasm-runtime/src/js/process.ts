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
  let bindingConstants: object | undefined;
  let bindingLookup: ((name: unknown, own: Record<string, () => unknown>) => unknown) | undefined;
  const ownBindings: Record<string, () => unknown> = {
    constants: () => constantsBinding(),
    uv: () => internal.require("uv_errors").binding(),
  };

  // Bun's constructProcessConfigObject for Linux, with the guest's architecture. Frozen, as in Bun.
  function processConfig() {
    const variables = {
      v8_enable_i18n_support: 1, enable_lto: false, enable_thin_lto: false, lto_jobs: "", node_module_version: 147,
      napi_build_version: 10, node_builtin_shareable_builtins: [], node_byteorder: "little", node_without_node_options: true,
      clang: 0, control_flow_guard: false, coverage: false, dcheck_always_on: 0, debug_nghttp2: false, debug_node: false,
      enable_pgo_generate: false, enable_pgo_use: false, error_on_warn: false, force_dynamic_crt: 0, napi_build: "0.0",
      host_arch: info.arch, target_arch: info.arch, asan: 0,
    };
    return Object.freeze({ target_defaults: {}, variables });
  }

  function constantsBinding() {
    return bindingConstants ??= Object.assign(Object.create(null), {
      fs: internal.builtin("node:fs").constants,
      os: internal.builtin("node:os").constants,
      crypto: internal.builtin("node:crypto").constants,
      zlib: internal.builtin("node:zlib").constants,
    });
  }

  // Node's EnvSetter, as Bun's JSEnvironmentVariableMap::put has it: a symbol name throws, an
  // empty name is ignored (nodejs/node#32920), and the value becomes a string
  // (`process.env.N = 1` -> "1").
  function setEnv(target: Record<PropertyKey, unknown>, key: string | symbol, value: unknown) {
    if (typeof key === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    if (key === "") return true;
    const text = `${value as string}`;
    target[key] = text;
    if (key === "TZ") timeZoneChanged(text);
    if (internal.workerEnvChange) internal.workerEnvChange(key, text);
    return true;
  }
  // Node's RealEnvStore::Set and ::Delete reset the time zone on every TZ write, on the main
  // thread only (a worker's env is a map), and so does Bun. Updates another thread made
  // to a shared environment do not, as in Bun. Names over 31 characters are ignored, as in Bun.
  const envTarget = native.env();
  const workerProcess = Object.hasOwn(envTarget, "BUNWASM_WORKER_INIT");
  // The engine answers with the zone ID ICU resolved (GMT and Etc/UTC are UTC, EST5EDT is
  // America/New_York), and the Intl fallback takes that ID rather than the raw name.
  function applyTimeZone(zone: string | undefined) {
    let resolved = native.setTimeZone?.(zone ?? "");
    // QuickJS has no zones of its own: time_zone.ts gives it one zone's offsets from the Intl
    // fallback's zone data, read natively without loading that data (1 to 2 ms).
    if (resolved === undefined && native.setLocalTimeOffsets) resolved = internal.require("time_zone")(zone ?? "");
    if (typeof resolved === "string") internal.setIntlTimeZone?.(resolved);
  }
  function timeZoneChanged(zone: string | undefined) {
    if (!workerProcess && !internal.envFromPeer) applyTimeZone(zone);
  }
  // The zone a process or worker starts with applies to the Intl fallback as well as to local time.
  if (typeof envTarget.TZ === "string") applyTimeZone(envTarget.TZ);
  function defineError(message: string) {
    return Object.assign(new TypeError(message), { code: "ERR_INVALID_OBJECT_DEFINE_PROPERTY" });
  }
  const env: Record<PropertyKey, unknown> = new Proxy(envTarget, {
    set(target, key, value, receiver) {
      // A write to an object that only inherits from process.env is that object's own,
      // with the value as given, and changes nothing about the process.
      if (receiver !== env) return Reflect.defineProperty(receiver, key, { value, writable: true, enumerable: true, configurable: true });
      return setEnv(target, key, value);
    },
    deleteProperty(target, key) {
      delete target[key];
      if (key === "TZ") timeZoneChanged(undefined);
      if (typeof key === "string" && internal.workerEnvChange) internal.workerEnvChange(key, undefined);
      return true;
    },
    // Node's EnvDefiner: only a complete, configurable, writable and enumerable data
    // descriptor, which then goes through the setter like an assignment.
    defineProperty(target, key, descriptor) {
      if ("get" in descriptor || "set" in descriptor) throw defineError("'process.env' does not accept an accessor(getter/setter) descriptor");
      if (!("value" in descriptor) || descriptor.configurable !== true || descriptor.writable !== true || descriptor.enumerable !== true) {
        throw defineError("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
      }
      return setEnv(target, key, descriptor.value);
    },
  });

  // Bun's loadEnvFile (src/js/builtins/ProcessObjectInternals.ts): the file fills in only the
  // variables that read undefined, so an existing empty value wins.
  function loadEnvFile(path?: unknown) {
    if (path === undefined) path = ".env";
    else if (typeof path !== "string") {
      throw Object.assign(new TypeError(`The "path" argument must be of type string. Received ${internal.describe(path)}`), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const fs = internal.builtin("node:fs") as unknown as { readFileSync(path: string, encoding: string): string };
    const content = fs.readFileSync(path as string, "utf8");
    const parsed = Object.fromEntries(native.parseEnv(content));
    for (const key of Object.keys(parsed)) {
      if (env[key] === undefined) env[key] = parsed[key];
    }
  }

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

  // A guest's resident memory is the core's linear memory, which every engine shares (on the
  // Browser engine too, whose JS heap is the page's). The core reads its size directly, without
  // the engine's heap counters; where it cannot, the engine record's figures stand in.
  function residentBytes(usage?: ReturnType<BunWasm.Native["memoryUsage"]>) {
    const linear = native.linearMemoryBytes?.();
    if (typeof linear === "number") return linear;
    const record = usage ?? native.memoryUsage();
    return record.rss ?? record.wasmCapacity ?? 0;
  }
  // Node's five counters, as numbers. The engine's own extras stay readable but are not
  // enumerable, so the result compares and prints like Node's and Bun's.
  function memoryUsage() {
    const usage = native.memoryUsage();
    const result = {
      rss: residentBytes(usage), heapTotal: usage.heapTotal ?? 0, heapUsed: usage.heapUsed ?? 0,
      external: usage.external ?? 0, arrayBuffers: usage.arrayBuffers ?? 0,
    };
    for (const key of ["arrayBufferCount", "wasmCapacity", "failedAllocation"] as const) {
      if (key in usage) Object.defineProperty(result, key, { value: usage[key], writable: true, configurable: true, enumerable: false });
    }
    return result;
  }
  memoryUsage.rss = () => residentBytes();

  // Bun's lazily built process properties (PropertyCallback): the first read or write leaves an
  // ordinary writable data property behind.
  function lazyData(name: string, build: () => unknown): PropertyDescriptor {
    const settle = (value: unknown) => {
      Object.defineProperty(process, name, { value, writable: true, configurable: true, enumerable: true });
      return value;
    };
    return { get: () => settle(build()), set: settle, configurable: true, enumerable: true };
  }

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

  // process.exitCode is Bun's exit byte (BunProcess.cpp setProcessExitCodeInner): Node's
  // validateInteger after numeric strings convert, undefined and null leave it alone, and it
  // reads undefined until something sets it.
  let exitByte: number | undefined;
  function exitCodeRangeError(range: string, value: number) {
    const shown = Number.isInteger(value) && Math.abs(value) > 2 ** 32 ? String(value).replace(/\B(?=(\d{3})+$)/g, "_") : String(value);
    return Object.assign(new RangeError(`The value of "code" is out of range. It must be ${range}. Received ${shown}`), { code: "ERR_OUT_OF_RANGE" });
  }
  function setExitCode(code: unknown) {
    if (code === undefined || code === null) return;
    const value = typeof code === "string" && code !== "" && !Number.isNaN(Number(code)) ? Number(code) : code;
    if (typeof value !== "number") {
      throw Object.assign(new TypeError(`The "code" argument must be of type number. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (!Number.isInteger(value)) throw exitCodeRangeError("an integer", value);
    if (!Number.isSafeInteger(value)) throw exitCodeRangeError(`>= ${Number.MIN_SAFE_INTEGER} && <= ${Number.MAX_SAFE_INTEGER}`, value);
    exitByte = (value % 256) & 0xff;
  }
  // Which call started the exit, for BUN_WASM_TRACE_EXIT: process.exit() reaches the guest's
  // exit through process.reallyExit, which a program may replace.
  let exitReason = "process.reallyExit";
  // Node's createProcessFinalization (lib/internal/process/finalization.js) as Bun ports it
  // in src/js/builtins/ProcessObjectInternals.ts.
  function createFinalization() {
    type Entry = { ref: WeakRef<object>; fn: unknown; event: string };
    let entries: Entry[] = [];
    let installed = false;
    function validateRef(obj: unknown): asserts obj is object {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
        throw Object.assign(new TypeError(`The "obj" argument must be of type object. Received ${internal.describe(obj)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
    }
    function run(event: string) {
      const due = entries.filter(entry => entry.event === event);
      entries = entries.filter(entry => entry.event !== event);
      for (const entry of due) {
        const target = entry.ref.deref();
        if (target !== undefined) (entry.fn as (target: object, event: string) => void)(target, event);
      }
    }
    function register(ref: unknown, fn: unknown, event: string) {
      validateRef(ref);
      if (!installed) {
        installed = true;
        process.on("exit", () => run("exit"));
        process.on("beforeExit", () => run("beforeExit"));
      }
      entries.push({ ref: new WeakRef(ref), fn, event });
    }
    return {
      register(ref: unknown, fn: unknown) { register(ref, fn, "exit"); },
      registerBeforeExit(ref: unknown, fn: unknown) { register(ref, fn, "beforeExit"); },
      unregister(ref: unknown) {
        validateRef(ref);
        entries = entries.filter(entry => {
          const target = entry.ref.deref();
          return target !== undefined && target !== ref;
        });
      },
    };
  }
  let finalization: ReturnType<typeof createFinalization> | undefined;

  const [pid, ppid] = native.processIdentity();
  const props = {
    title: "bun",
    version: `v${NODE_VERSION}`,
    versions: {
      node: NODE_VERSION,
      bun: info.version,
      // Only the running engine names itself (quickjs, webkit, spidermonkey, hermes, or the
      // Node host's v8), so `process.versions.quickjs` detects QuickJS and nothing else.
      ...(native.engineVersion ? { [native.engineVersion[0]]: native.engineVersion[1] } : {}),
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
    loadEnvFile,
    pid,
    ppid,
    noDeprecation: false,
    isBun: true,
    browser: false,
    config: processConfig(),
    features: { inspector: false, debug: false, uv: false, ipv6: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false, cached_builtins: true, typescript: "transform" },
    // Node's legacy and private members, as Bun stubs them (BunProcess.cpp processObjectTable).
    _getActiveRequests: () => [],
    _getActiveHandles: () => [],
    _linkedBinding() {},
    _tickCallback() {},
    // Main thread only: worker_threads removes these from a worker's process.
    _debugEnd() {},
    _debugProcess() {},
    _startProfilerIdleNotifier() {},
    _stopProfilerIdleNotifier() {},
    moduleLoadList: [],
    _preload_modules: [],
    cwd: () => native.cwd(),
    chdir: (dir: unknown) => native.chdir(internal.require("path").resolve(String(dir))),
    // Bun's Process_functionExit: set the code, emit 'exit' (which sets _exiting), then call
    // process.reallyExit as a method with the code the listeners left.
    exit(code?: unknown) {
      setExitCode(code);
      internal.emitExit(exitByte ?? 0);
      const reallyExit = process.reallyExit;
      if (typeof reallyExit !== "function") throw new TypeError("process.reallyExit is not a function");
      exitReason = "process.exit";
      reallyExit.call(process, exitByte ?? 0);
    },
    // The raw exit: no 'exit' listeners. An integer keeps its low byte, anything else exits 0.
    reallyExit(code: unknown) {
      const byte = Number.isInteger(code) ? ((code as number) % 256) & 0xff : 0;
      internal.traceExit(exitReason, byte);
      internal.exitStarted = true;
      native.exit(byte);
    },
    abort: () => { internal.traceExit("process.abort", 134); internal.exitStarted = true; native.exit(134); },
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
    // maxRSS is kilobytes. Linear memory never shrinks, so its current size is the peak.
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: memoryUsage.rss() / 1024 }),
    cpuUsage: (previous?: unknown) => internal.require("process_args").cpuUsage({ user: Math.floor(native.now() * 1000), system: 0 }, previous),
    uptime: () => native.now() / 1000,
    umask: (mask?: unknown) => internal.require("process_args").umask(mask),
    getuid: () => 0,
    geteuid: () => 0,
    getgid: () => 0,
    getegid: () => 0,
    getgroups: () => [],
    setuid() {},
    setgid() {},
    emitWarning(warning: unknown, ...options: unknown[]) {
      internal.require("process_warning").emitWarning(process, warning, options[0], options[1], options[2]);
    },
    binding(name: unknown) {
      return (bindingLookup ??= internal.require("process_binding"))(name, ownBindings);
    },
    dlopen() {
      throw new Error("process.dlopen is not supported in bun-wasm");
    },
    setSourceMapsEnabled() {},
    hasUncaughtExceptionCaptureCallback: () => internal.uncaughtCapture !== undefined,
    setUncaughtExceptionCaptureCallback(fn: unknown) {
      if (fn === null) {
        internal.uncaughtCapture = undefined;
        return;
      }
      if (typeof fn !== "function") {
        throw Object.assign(new TypeError(`The "fn" argument must be of type function or null. Received ${internal.describe(fn)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
      if (internal.uncaughtCapture !== undefined) {
        throw Object.assign(new Error("`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active"), { code: "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET" });
      }
      internal.uncaughtCapture = fn as BunWasm.UncaughtCapture;
    },
    // Runs the uncaught exception handlers and reports whether one claimed the error.
    _fatalException: (error: unknown, fromPromise?: unknown) => internal.dispatchUncaught(error, Boolean(fromPromise)),
    getActiveResourcesInfo: () => [],
    constrainedMemory: () => 0,
    availableMemory: () => 4294967296 - memoryUsage.rss(),
    stdin: undefined,
  };
  const process: BunWasm.NodeEmitter & { noDeprecation: boolean; exitCode?: unknown; reallyExit: unknown; pid: number; env: Record<PropertyKey, unknown>; execArgv: string[]; stdin?: unknown; emitWarning(warning: unknown, type?: string | BunWasm.ProcessWarningOptions | null, code?: unknown): void } = Object.assign(processBase, props);
  delete process.stdin;

  Object.defineProperties(process, {
    stdout: { get: () => stdout || (stdout = makeWriter(1)), configurable: true, enumerable: true },
    stderr: { get: () => stderr || (stderr = makeWriter(2)), configurable: true, enumerable: true },
    stdin: { get: () => stdin || (stdin = makeReader()), configurable: true, enumerable: true },
    mainModule: { get: () => internal.getMainModule(), configurable: true, enumerable: false },
    exitCode: { get: () => exitByte, set: setExitCode, configurable: true, enumerable: true },
    finalization: { get: () => finalization ??= createFinalization(), configurable: true, enumerable: false },
    allowedNodeEnvironmentFlags: lazyData("allowedNodeEnvironmentFlags", () => internal.require("process_allowed_flags")),
    report: lazyData("report", () => internal.require("process_report")(process)),
    _exiting: { value: false, writable: true, configurable: true, enumerable: false },
    [Symbol.toStringTag]: { value: "process", configurable: true },
  });

  return process;
})
