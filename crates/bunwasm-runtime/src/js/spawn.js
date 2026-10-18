// Guest processes resolve through the host executable registry, never arbitrary OS commands.
(function (internal) {
  "use strict";
  const native = internal.native;
  const { Buffer } = internal.require("buffer");
  const AGAIN = -2;
  // Slot 14 selector 3 returns the completed outcome's signal, not a requested signal.
  const CHILD_FINAL_SIGNAL = 3;
  const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };

  function unsupported(message) {
    return Object.assign(new Error(`${message} is not supported in bun-wasm`), { code: "ERR_NOT_SUPPORTED_IN_WASM" });
  }

  function hostError(handle) {
    let info;
    try { info = JSON.parse(native.hostError(handle)); } catch { info = {}; }
    return Object.assign(new Error(info.message || "Child process failed"), info, { code: info.code || "EIO" });
  }

  function signalNumber(signal = "SIGTERM") {
    const number = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()];
    if (!Number.isInteger(number) || number < 0 || number > 64) throw new TypeError(`Unknown signal: ${signal}`);
    return number;
  }

  function signalName(number) {
    return Object.keys(signals).find((name) => signals[name] === number) || number;
  }

  function finalSignal(handle) {
    const number = native.hostChildPipe(handle, CHILD_FINAL_SIGNAL);
    if (number < 0) throw hostError(handle);
    return number === 0 ? null : signalName(number);
  }

  function bytes(value) {
    if (typeof value === "string") return Buffer.from(value);
    if (value && typeof value._bytes === "function") return value._bytes();
    return internal.toUint8(value);
  }

  function stdioMode(value, fd, fallback) {
    if (value === undefined) return fallback;
    if (value === null || value === "ignore") return "ignore";
    if (value === fd || value === "inherit") return "inherit";
    if (value === "pipe") return "pipe";
    if (fd === 0 && (typeof value !== "string" || value !== "ipc")) return "pipe";
    throw unsupported(`stdio redirection ${String(value)}`);
  }

  function validateCommandLength(cmd) {
    const argv = Array.isArray(cmd) ? cmd : cmd && cmd.cmd;
    if (Array.isArray(argv) && argv.length > 0xfffffffd) throw new TypeError("cmd array is too large");
  }

  function normalize(cmd, options, sync) {
    if (!Array.isArray(cmd)) {
      options = cmd || {};
      cmd = options.cmd;
    }
    options = options || {};
    if (!Array.isArray(cmd) || !cmd.length) throw new TypeError("cmd must be a non-empty array");
    validateCommandLength(cmd);
    if (options.ipc !== undefined) throw unsupported("Child process IPC");
    const argv = internal.require("package_scripts").spawnArguments(cmd.map(String), options.cwd);
    if (argv.some((arg) => arg.includes("\0"))) throw new TypeError("Command arguments cannot contain null bytes");
    const proc = globalThis.process;
    if (!native.hostCaps.spawn) throw unsupported("Spawning a process without host process support");
    const env = {};
    for (const [key, value] of Object.entries(options.env || proc.env)) if (value !== undefined) env[key] = String(value);
    const io = options.stdio;
    const input = Array.isArray(io) ? io[0] : options.stdin;
    const output = Array.isArray(io) ? io[1] : options.stdout;
    const error = Array.isArray(io) ? io[2] : options.stderr;
    const requestedCwd = options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : String(options.cwd || native.cwd());
    const cwd = internal.require("path").resolve(native.cwd(), requestedCwd);
    const meta = { executable: argv[0], argv, cwd, env,
      stdin: stdioMode(input, 0, "ignore"),
      stdout: stdioMode(output, 1, "pipe"),
      stderr: stdioMode(error, 2, sync ? "pipe" : "inherit") };
    if (options._worker) meta.worker = options._worker;
    return { meta, options, input };
  }

  function start(cmd, options, sync) {
    const spec = normalize(cmd, options, sync);
    if (spec.options.signal && spec.options.signal.aborted) throw spec.options.signal.reason;
    if (spec.options.killSignal !== undefined) signalNumber(spec.options.killSignal);
    const handle = native.hostSpawn(JSON.stringify(spec.meta));
    if (handle < 0) throw hostError(0);
    const pipes = [0, 1, 2].map((fd) => spec.meta[["stdin", "stdout", "stderr"][fd]] === "pipe" ? native.hostChildPipe(handle, fd) : 0);
    if (pipes.some((pipe) => pipe < 0)) {
      native.hostChildKill(handle, 9);
      for (const pipe of pipes) if (pipe > 0) native.hostClose(pipe);
      native.hostClose(handle);
      throw hostError(0);
    }
    return Object.assign(spec, { handle, pipes });
  }

  // Bounded steps let the synchronous path drain all pipes while stdin is written.
  function readPipe(state, consume) {
    if (!state.handle) return false;
    const chunk = native.hostRead(state.handle);
    if (chunk === AGAIN) return false;
    if (typeof chunk !== "number") {
      consume(Buffer.from(chunk));
      return true;
    }
    const handle = state.handle;
    state.handle = 0;
    native.hostClose(handle);
    if (chunk < 0) throw hostError(handle);
    state.end();
    return true;
  }

  function writer(handle) {
    const queue = [];
    let closing = false;
    let closed = !handle;
    function flush() {
      if (closed) return true;
      if (queue.length) {
        const chunk = queue[0];
        const count = native.hostWrite(handle, chunk);
        if (count === AGAIN || count === 0) return false;
        if (count < 0) throw hostError(handle);
        if (count === chunk.length) queue.shift();
        else queue[0] = chunk.subarray(count);
      }
      if (!queue.length && closing) {
        native.hostClose(handle);
        closed = true;
      }
      return closed || !queue.length;
    }
    return {
      write(chunk) {
        if (closed || closing) throw Object.assign(new Error("write after end"), { code: "EPIPE", errno: -32, syscall: "write" });
        const data = bytes(chunk);
        if (data.length) queue.push(data.slice());
        flush();
        return data.length;
      },
      flush,
      destroy() { if (!closed) native.hostClose(handle); closed = true; queue.length = 0; },
      end(chunk) {
        if (chunk !== undefined) this.write(chunk);
        closing = true;
        flush();
      },
      get closed() { return closed; },
      ref() { return this; },
      unref() { return this; },
    };
  }

  function initialInput(input, sink) {
    if (input === undefined || input === null || input === "pipe" || input === "inherit" || input === "ignore" || input === 0) return;
    if (input && typeof input.getReader === "function") {
      (async () => { for await (const chunk of input) sink.write(chunk); sink.end(); })().catch(() => sink.end());
      return;
    }
    sink.end(input);
  }

  function spawn(cmd, options) {
    const spec = start(cmd, options, false);
    internal.require("net");
    const sink = writer(spec.pipes[0]);
    const outputs = [];
    const states = spec.pipes.slice(1).map((handle) => {
      const state = { handle, size: 0, end() {} };
      let controller;
      let wake;
      let cancelled = false;
      let ended = false;
      const notify = () => { if (wake) wake(); wake = null; };
      const stream = handle ? new internal.web.ReadableStream({
        start(c) { controller = c; },
        pull() { if (state.handle) return new Promise((resolve) => { wake = resolve; }); },
        cancel() { cancelled = true; if (state.handle) native.hostClose(state.handle); state.handle = 0; notify(); },
      }) : null;
      state.end = () => { if (controller && !cancelled && !ended) controller.close(); ended = true; notify(); };
      state.error = (error) => { if (controller && !cancelled && !ended) controller.error(error); ended = true; notify(); };
      state.consume = (chunk) => {
        if (!cancelled) controller.enqueue(chunk);
        notify();
        state.size += chunk.length;
        if (state.size <= (spec.options.maxBuffer === undefined ? 64 * 1024 * 1024 : Number(spec.options.maxBuffer))) return;
        child.exitedDueToMaxBuffer = true;
        child.kill(spec.options.killSignal);
        native.hostClose(state.handle);
        state.handle = 0;
        state.end();
      };
      if (stream) Object.assign(stream, {
        text: () => new internal.web.Response(stream).text(),
        bytes: () => globalThis.Bun.readableStreamToBytes(stream),
        arrayBuffer: () => new internal.web.Response(stream).arrayBuffer(),
        json: () => new internal.web.Response(stream).json(),
      });
      outputs.push(stream);
      return state;
    });
    let resolveExit;
    let rejectExit;
    let timer;
    let abort;
    let closed = false;
    let settled = false;
    const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    const child = {
      pid: spec.handle, stdin: spec.pipes[0] ? sink : null, stdout: outputs[0], stderr: outputs[1],
      exited, exitCode: null, signalCode: null, killed: false,
      exitedDueToTimeout: false, exitedDueToMaxBuffer: false,
      kill(signal) {
        if (settled) return;
        const number = signalNumber(signal);
        if (native.hostChildWait(spec.handle) >= 0) return;
        if (native.hostChildKill(spec.handle, number) < 0) {
          if (native.hostChildWait(spec.handle) >= 0) return;
          throw hostError(spec.handle);
        }
        if (number) child.killed = true;
        // Requests do not classify completion; even SIGKILL may lose to an already selected exit.
      },
      ref() { waiter.ref = true; return child; },
      unref() { waiter.ref = false; return child; },
      resourceUsage() { return undefined; },
      async [Symbol.asyncDispose]() { if (!settled) child.kill(); await exited; },
    };
    function finish(code) {
      const signalCode = finalSignal(spec.handle);
      settled = true;
      child.exitCode = signalCode === null ? code : null;
      child.signalCode = signalCode;
      if (timer) internal.realTimers.clearTimeout(timer);
      if (abort) spec.options.signal.removeEventListener("abort", abort);
      resolveExit(code);
      if (typeof spec.options.onExit === "function") spec.options.onExit(child, child.exitCode, child.signalCode, null);
    }
    function close() {
      if (closed) return;
      closed = true;
      sink.destroy();
      native.hostClose(spec.handle);
    }
    function step() {
      if (closed) return true;
      const code = settled ? 0 : native.hostChildWait(spec.handle);
      if (code < 0 && code !== AGAIN) throw hostError(spec.handle);
      if (code >= 0 && !settled) { sink.destroy(); finish(code); }
      if (!settled) sink.flush();
      let progress = false;
      for (const state of states) if (readPipe(state, state.consume)) progress = true;
      if (settled && states.every((state) => !state.handle)) { if (!spec.options._worker) close(); return true; }
      return progress ? "progress" : false;
    }
    function fail(error) {
      for (const state of states) {
        if (state.handle) native.hostClose(state.handle);
        state.handle = 0;
        state.error(error);
      }
      close();
      rejectExit(error);
    }
    Object.defineProperty(child, "_finishWorker", { value: close });
    const waiter = internal.addIoWaiter({ step, fail, ref: true });
    Object.defineProperty(child, "_abortWorker", { value() {
      child.kill(9);
      for (const state of states) {
        if (state.handle) native.hostClose(state.handle);
        state.handle = 0;
        state.end();
      }
      settled = true;
      resolveExit(1);
      close();
    } });
    initialInput(spec.input, sink);
    if (spec.options.timeout > 0) timer = internal.realTimers.setTimeout(() => { child.exitedDueToTimeout = true; child.kill(spec.options.killSignal); }, spec.options.timeout);
    if (spec.options.signal) {
      abort = () => child.kill(spec.options.killSignal);
      spec.options.signal.addEventListener("abort", abort, { once: true });
    }
    return child;
  }

  function spawnSync(cmd, options) {
    validateCommandLength(cmd);
    let spec;
    try { spec = start(cmd, options, true); } catch (error) {
      return { pid: 0, success: false, exitCode: 1, signalCode: null, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message + "\n"), error };
    }
    const chunks = [[], []];
    const states = spec.pipes.slice(1).map((handle) => ({ handle, end() {} }));
    const sink = writer(spec.pipes[0]);
    const started = native.now();
    const maxBuffer = spec.options.maxBuffer === undefined ? 64 * 1024 * 1024 : Number(spec.options.maxBuffer);
    const sizes = [0, 0];
    let exitCode = AGAIN;
    let timedOut = false;
    try {
      if (spec.input && typeof spec.input.getReader === "function") throw unsupported("Synchronous streaming stdin");
      initialInput(spec.input, sink);
      sink.end();
      while (exitCode === AGAIN || states.some((state) => state.handle)) {
        sink.flush();
        states.forEach((state, i) => readPipe(state, (chunk) => {
          sizes[i] += chunk.length;
          if (sizes[i] > maxBuffer) throw Object.assign(new Error("Child process output exceeds maxBuffer"), { code: "ENOBUFS" });
          chunks[i].push(chunk);
        }));
        exitCode = native.hostChildWait(spec.handle);
        if (exitCode < 0 && exitCode !== AGAIN) throw hostError(spec.handle);
        if (exitCode === AGAIN && !timedOut && spec.options.timeout > 0 && native.now() - started >= spec.options.timeout) {
          timedOut = true;
          const requestedSignal = signalNumber(spec.options.killSignal);
          if (native.hostChildKill(spec.handle, requestedSignal) < 0 && native.hostChildWait(spec.handle) < 0) throw hostError(spec.handle);
        }
        if (exitCode === AGAIN || states.some((state) => state.handle)) native.hostPoll(1);
      }
      const signalCode = finalSignal(spec.handle);
      return { pid: spec.handle, success: exitCode === 0, exitCode: signalCode === null ? exitCode : null, signalCode,
        exitedDueToTimeout: timedOut, stdout: Buffer.from(internal.concatBytes(chunks[0])), stderr: Buffer.from(internal.concatBytes(chunks[1])) };
    } catch (error) {
      native.hostChildKill(spec.handle, 9);
      // Selection can precede completion publication. Observe the winner before closing it.
      while ((exitCode = native.hostChildWait(spec.handle)) === AGAIN) native.hostPoll(1);
      if (exitCode < 0) throw hostError(spec.handle);
      const signalCode = finalSignal(spec.handle);
      return { pid: spec.handle, success: false, exitCode: signalCode === null ? exitCode : null, signalCode,
        stdout: Buffer.from(internal.concatBytes(chunks[0])), stderr: Buffer.from(internal.concatBytes(chunks[1])), error };
    } finally {
      for (const pipe of spec.pipes) if (pipe > 0) native.hostClose(pipe);
      native.hostClose(spec.handle);
    }
  }

  // A deliberately small shell tokenizer. Shell operators and expansions never
  // escape into native executables; quoted JavaScript passed to bun -e is safe.
  function shellArgs(command) {
    const args = [];
    let token = "";
    let quote = "";
    let escaped = false;
    let active = false;
    for (const ch of String(command)) {
      if (escaped) { token += ch; escaped = false; active = true; continue; }
      if (ch === "\\" && quote !== "'") { escaped = true; active = true; continue; }
      if (quote) {
        if (ch === quote) quote = "";
        else token += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; active = true; continue; }
      if (/\s/.test(ch)) {
        if (active) args.push(token);
        token = ""; active = false;
        continue;
      }
      if (/[|&;<>()$`*?{}\[\]~]/.test(ch)) throw unsupported("Shell operators and expansion");
      token += ch; active = true;
    }
    if (quote || escaped) throw new TypeError("Unterminated shell quote");
    if (active) args.push(token);
    return args;
  }

  function nodeChildProcess() {
    const EventEmitter = internal.require("events");
    const { Readable, Writable } = internal.builtin("node:stream");

    function spawnError(error, command, args, sync) {
      if (!error || typeof error !== "object" || (error.code !== "ENOENT" && error.code !== "EACCES")) return error;
      const path = String(command);
      const syscall = `${sync ? "spawnSync" : "spawn"} ${path}`;
      return Object.assign(new Error(`${syscall} ${error.code}`), {
        code: error.code, errno: error.code === "ENOENT" ? -2 : -13, syscall, path, spawnargs: args.map(String),
      });
    }

    function nodeOptions(options = {}) {
      const io = options.stdio === undefined ? "pipe" : options.stdio;
      const stdio = Array.isArray(io) ? io : [io, io, io];
      if (stdio.includes("ipc")) throw unsupported("Child process IPC");
      return Object.assign({}, options, { stdio });
    }

    function nodeArgv(command, args, options) {
      if (options.shell) return shellArgs([command].concat(args).join(" "));
      return [command].concat(args);
    }

    function nodeReadable(stream) {
      if (!stream) return null;
      const readable = new Readable({ read() {} });
      readable._childDrained = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { readable.push(null); return; }
          readable.push(Buffer.from(value));
        }
      })().catch((error) => readable.destroy(error));
      return readable;
    }

    function nodeWritable(sink) {
      if (!sink) return null;
      return new Writable({
        write(chunk, encoding, callback) {
          try { sink.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk); callback(); }
          catch (error) { callback(error); }
        },
        final(callback) { sink.end(); callback(); },
      });
    }

    class ChildProcess extends EventEmitter {
      constructor() {
        super();
        this.pid = undefined;
        this.exitCode = null;
        this.signalCode = null;
        this.killed = false;
        this.connected = false;
        this.stdin = null;
        this.stdout = null;
        this.stderr = null;
        this.stdio = [null, null, null];
      }
      kill(signal = "SIGTERM") {
        if (!this._child || this.exitCode !== null || this.signalCode !== null) return false;
        this._child.kill(signal);
        this.killed = signalNumber(signal) !== 0;
        return true;
      }
      ref() { if (this._child) this._child.ref(); return this; }
      unref() { if (this._child) this._child.unref(); return this; }
      send() { throw unsupported("Child process IPC"); }
      disconnect() { throw unsupported("Child process IPC"); }
    }

    function reportStartFailure(child, options, error) {
      const streams = options.stdio.map((mode, fd) => {
        if (mode !== "pipe") return null;
        if (fd === 0) return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        return new Readable({ read() {} });
      });
      child.stdin = streams[0];
      child.stdout = streams[1];
      child.stderr = streams[2];
      child.stdio = streams;
      const closed = streams.filter(Boolean).map((stream) => new Promise((resolve) => stream.once("close", resolve)));
      const errno = error && typeof error === "object" && Number.isInteger(error.errno) ? error.errno : -2;
      internal.nextTick(() => {
        child.exitCode = errno;
        if (child.stdin) child.stdin.destroy();
        if (child.stdout) { child.stdout.push(null); child.stdout.resume(); }
        if (child.stderr) { child.stderr.push(null); child.stderr.resume(); }
        child.emit("error", error);
        Promise.all(closed).then(() => child.emit("close", errno, null));
      });
    }

    function reportExit(child, code) {
      child.signalCode = child._child.signalCode;
      child.exitCode = child.signalCode === null ? code : null;
      child.emit("exit", child.exitCode, child.signalCode);
      // Web stream completion schedules Node stream end callbacks as immediates.
      // Give those callbacks a turn before close, including unread output pipes.
      Promise.all(child._drains).then(() => internal.realTimers.setImmediate(() => child.emit("close", child.exitCode, child.signalCode)));
    }

    function nodeSpawn(command, args, options) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = nodeOptions(options);
      const child = new ChildProcess();
      const argv = nodeArgv(command, args, options);
      child.spawnfile = String(command);
      child.spawnargs = argv;
      try { child._child = spawn(argv, options); } catch (error) {
        error = spawnError(error, command, args, false);
        reportStartFailure(child, options, error);
        return child;
      }
      child.pid = child._child.pid;
      child.stdin = nodeWritable(child._child.stdin);
      child.stdout = nodeReadable(child._child.stdout);
      child.stderr = nodeReadable(child._child.stderr);
      child.stdio = [child.stdin, child.stdout, child.stderr];
      child._drains = [child.stdout, child.stderr].filter(Boolean).map((stream) => stream._childDrained);
      internal.nextTick(() => child.emit("spawn"));
      if (options.signal) {
        const aborted = () => child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: options.signal.reason }));
        options.signal.addEventListener("abort", aborted, { once: true });
        child.once("close", () => options.signal.removeEventListener("abort", aborted));
      }
      child._child.exited.then((code) => reportExit(child, code), (error) => child.emit("error", error));
      return child;
    }

    function nodeSpawnSync(command, args, options) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = nodeOptions(options);
      const argv = nodeArgv(command, args, options);
      const config = Object.assign({}, options);
      if (options.input !== undefined) config.stdio = [options.input].concat(options.stdio.slice(1));
      const result = spawnSync(argv, config);
      if (result.error) result.error = spawnError(result.error, command, args, true);
      const missing = result.pid === 0 && result.error && (result.error.code === "ENOENT" || result.error.code === "EACCES");
      const signal = result.signalCode;
      if (result.exitedDueToTimeout) result.error = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT", errno: -110, syscall: "spawnSync", path: String(command) });
      const encoding = options.encoding;
      const stdout = missing ? undefined : options.stdio[1] === "inherit" || options.stdio[1] === "ignore" ? null : encoding && encoding !== "buffer" ? result.stdout.toString(encoding) : result.stdout;
      const stderr = missing ? undefined : options.stdio[2] === "inherit" || options.stdio[2] === "ignore" ? null : encoding && encoding !== "buffer" ? result.stderr.toString(encoding) : result.stderr;
      return { pid: result.pid, status: result.error || signal ? null : result.exitCode, signal,
        output: missing ? null : [null, stdout, stderr], stdout, stderr, error: result.error };
    }

    function failure(command, result) {
      const { error, ...details } = result;
      if (error) return Object.assign(error, details);
      return Object.assign(new Error(`Command failed: ${command}\n${result.stderr}`), result, { code: result.status });
    }

    function execFileSync(command, args, options) {
      const result = nodeSpawnSync(command, args, options);
      if (result.error || result.status !== 0) throw failure(command, result);
      return result.stdout;
    }

    function execSync(command, options) {
      const argv = shellArgs(command);
      return execFileSync(argv[0], argv.slice(1), options);
    }

    function execFile(command, args, options, callback) {
      if (typeof args === "function") { callback = args; args = []; options = {}; }
      else if (!Array.isArray(args)) { callback = options; options = args || {}; args = []; }
      if (typeof options === "function") { callback = options; options = {}; }
      options = Object.assign({ maxBuffer: 1024 * 1024 }, options);
      const child = nodeSpawn(command, args, options);
      const out = [];
      const err = [];
      let reported = false;
      const sizes = [0, 0];
      function collect(chunk, parts, fd) {
        sizes[fd] += chunk.length;
        if (sizes[fd] <= options.maxBuffer) { parts.push(Buffer.from(chunk)); return; }
        child.kill(options.killSignal);
        complete(Object.assign(new Error("Child process output exceeds maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      }
      if (child.stdout) child.stdout.on("data", (chunk) => collect(chunk, out, 0));
      if (child.stderr) child.stderr.on("data", (chunk) => collect(chunk, err, 1));
      function complete(error) {
        if (reported) return;
        reported = true;
        const encoding = options.encoding === undefined ? "utf8" : options.encoding;
        const stdout = encoding === "buffer" || encoding === null ? Buffer.concat(out) : Buffer.concat(out).toString(encoding);
        const stderr = encoding === "buffer" || encoding === null ? Buffer.concat(err) : Buffer.concat(err).toString(encoding);
        if (error) Object.assign(error, { stdout, stderr });
        if (typeof callback === "function") callback(error, stdout, stderr);
      }
      child.on("error", complete);
      child.on("close", (code, signal) => complete(code === 0 ? null : Object.assign(new Error(`Command failed: ${command}`), { code, signal, killed: child.killed })));
      return child;
    }

    function exec(command, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      const argv = shellArgs(command);
      return execFile(argv[0], argv.slice(1), options, callback);
    }

    function fork(modulePath, args, options) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = options || {};
      const execArgs = options.execArgv || globalThis.process.execArgv;
      const config = Object.assign({}, options, { stdio: options.stdio || (options.silent ? "pipe" : "inherit") });
      return nodeSpawn(options.execPath || globalThis.process.execPath, execArgs.concat([String(modulePath)], args), config);
    }

    const custom = Symbol.for("nodejs.util.promisify.custom");
    function promisified(fn) {
      return (...args) => {
        let child;
        const promise = new Promise((resolve, reject) => {
          child = fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        });
        promise.child = child;
        return promise;
      };
    }
    exec[custom] = promisified(exec);
    execFile[custom] = promisified(execFile);
    return { ChildProcess, spawn: nodeSpawn, spawnSync: nodeSpawnSync, exec, execSync, execFile, execFileSync, fork };
  }

  return { spawn, spawnSync(cmd, options) {
    const result = spawnSync(cmd, options);
    if (result.error && (result.error.code === "ENOENT" || result.error.code === "EACCES")) throw result.error;
    return result;
  }, nodeChildProcess };
})
