// Guest processes resolve through the host executable registry, never arbitrary OS commands.
// Children run on the runtime_proc process ABI (docs/host-abi.md, "Process slots"): descriptors
// from `procPipe`, `procSpawn` bindings, nonblocking `procRead`/`procWrite`, `procWait`,
// `procWaitJob`, `procKill`/`procKillJob` and `procPoll`. No Bun-specific child handles remain.
// A child joins the caller's own job; only a `detached` child starts (and owns) a new one.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const { Buffer } = internal.require("buffer");
  // WASI errno values from runtime_proc, negated.
  const AGAIN = -6;
  const CHILD = -12;
  const SRCH = -71;
  // Subscription kinds of procPoll.
  const READABLE = 0;
  const WRITABLE = 1;
  const CHILD_EXIT = 2;
  const JOB_EMPTY = 4;
  const signals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };
  const errnoNames: Record<number, string> = {
    1: "E2BIG", 2: "EACCES", 6: "EAGAIN", 8: "EBADF", 12: "ECHILD", 21: "EFAULT", 27: "EINTR", 28: "EINVAL", 29: "EIO",
    33: "EMFILE", 44: "ENOENT", 48: "ENOMEM", 52: "ENOSYS", 63: "EPERM", 64: "EPIPE", 71: "ESRCH", 76: "ENOTCAPABLE",
  };
  const nodeErrnos: Record<string, number> = {
    EPERM: -1, ENOENT: -2, ESRCH: -3, EINTR: -4, EIO: -5, E2BIG: -7, EBADF: -9, ECHILD: -10, EAGAIN: -11,
    ENOMEM: -12, EACCES: -13, EFAULT: -14, EINVAL: -22, EMFILE: -24, EPIPE: -32, ENOSYS: -38, ENOTDIR: -20,
  };
  const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

  type StdioMode = "pipe" | "inherit" | "ignore";
  interface Exit { kind: number; code: number }
  interface SpawnOptions {
    cmd?: unknown;
    cwd?: string | URL;
    env?: Record<string, unknown>;
    stdio?: unknown;
    stdin?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    ipc?: unknown;
    signal?: AbortSignal;
    killSignal?: string | number;
    timeout?: number;
    maxBuffer?: number | string;
    onExit?: (child: unknown, exitCode: number | null, signalCode: string | number | null, error: unknown) => void;
    _worker?: unknown;
    [key: string]: unknown;
  }
  interface SpawnMeta {
    executable: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    stdin: StdioMode;
    stdout: StdioMode;
    stderr: StdioMode;
    worker?: unknown;
  }
  interface Spec { meta: SpawnMeta; options: SpawnOptions; input: unknown }
  interface Started extends Spec {
    pid: number;
    job: number;
    /** Parent ends, -1 when absent. Outputs are stdout then stderr. */
    stdinFd: number;
    outputFds: number[];
    discard: boolean[];
    worker: { input: number; output: number } | null;
  }
  interface Sink {
    write(chunk: unknown): number;
    flush(): boolean;
    destroy(): void;
    end(chunk?: unknown): void;
    watch(): Uint8Array;
    readonly closed: boolean;
    ref(): Sink;
    unref(): Sink;
  }
  interface OutputState {
    fd: number;
    size: number;
    discard: boolean;
    end(): void;
    error(error: unknown): void;
    consume(chunk: Uint8Array): void;
  }
  type Pipe = ReadableStream<Uint8Array> & { text(): Promise<string>; bytes(): Promise<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> };
  interface Child {
    pid: number;
    stdin: Sink | null;
    stdout: Pipe | null;
    stderr: Pipe | null;
    exited: Promise<number>;
    exitCode: number | null;
    signalCode: string | number | null;
    killed: boolean;
    exitedDueToTimeout: boolean;
    exitedDueToMaxBuffer: boolean;
    kill(signal?: string | number): void;
    ref(): Child;
    unref(): Child;
    resourceUsage(): undefined;
    [Symbol.asyncDispose](): Promise<void>;
    _finishWorker?: () => void;
    _abortWorker?: () => void;
    _workerChannel?: { input: number; output: number };
  }
  const web = internal.web as unknown as {
    ReadableStream: new(source: UnderlyingDefaultSource<Uint8Array>) => ReadableStream<Uint8Array>;
    Response: new(body: ReadableStream<Uint8Array>) => Response;
  };

  function unsupported(message: string) {
    return Object.assign(new Error(`${message} is not supported in bun-wasm`), { code: "ERR_NOT_SUPPORTED_IN_WASM" });
  }

  // A negative runtime_proc result becomes the Node error for its errno.
  function processError(result: number, syscall: string, path?: string) {
    const code = errnoNames[-result] || `E${-result}`;
    const error: Error & { code: string; errno?: number; syscall: string; path?: string } = Object.assign(
      new Error(path === undefined ? `${syscall} ${code}` : `${syscall} ${path} ${code}`),
      { code, errno: nodeErrnos[code], syscall });
    if (path !== undefined) error.path = path;
    return error;
  }

  function signalNumber(signal: string | number = "SIGTERM") {
    const number = typeof signal === "number" ? signal : signals[String(signal).toUpperCase()];
    if (!Number.isInteger(number) || number < 0 || number > 64) throw new TypeError(`Unknown signal: ${signal}`);
    return number;
  }

  function signalName(number: number) {
    return Object.keys(signals).find((name) => signals[name] === number) || number;
  }

  function bytes(value: unknown): Uint8Array {
    if (typeof value === "string") return Buffer.from(value);
    if (value && typeof (value as { _bytes?: unknown })._bytes === "function") return (value as { _bytes(): Uint8Array })._bytes();
    return internal.toUint8(value as ArrayBufferView);
  }

  // 16-byte procPoll subscriptions: u32 kind, u32 id, u64 userdata (unused here).
  function subscription(kind: number, id: number): Uint8Array {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, kind, true);
    view.setUint32(4, id >>> 0, true);
    return bytes;
  }

  function watching(list: Uint8Array[]): Uint8Array {
    return list.length ? internal.concatBytes(list) : new Uint8Array(0);
  }

  function stdioMode(value: unknown, fd: number, fallback: StdioMode): StdioMode {
    if (value === undefined) return fallback;
    if (value === null || value === "ignore") return "ignore";
    if (value === fd || value === "inherit") return "inherit";
    if (value === "pipe") return "pipe";
    if (fd === 0 && (typeof value !== "string" || value !== "ipc")) return "pipe";
    throw unsupported(`stdio redirection ${String(value)}`);
  }

  function validateCommandLength(cmd: unknown) {
    const argv = Array.isArray(cmd) ? cmd : cmd && (cmd as { cmd?: unknown[] }).cmd;
    if (Array.isArray(argv) && argv.length > 0xfffffffd) throw new TypeError("cmd array is too large");
  }

  function normalize(cmd: unknown, options: SpawnOptions | undefined, sync: boolean): Spec {
    if (!Array.isArray(cmd)) {
      options = (cmd || {}) as SpawnOptions;
      cmd = options.cmd;
    }
    options = options || {};
    if (!Array.isArray(cmd) || !cmd.length) throw new TypeError("cmd must be a non-empty array");
    validateCommandLength(cmd);
    if (options.ipc !== undefined) throw unsupported("Child process IPC");
    const argv = cmd.map(String);
    if (argv.some((arg) => arg.includes("\0"))) throw new TypeError("Command arguments cannot contain null bytes");
    const proc = process as unknown as BunWasm.GuestProcess;
    if (!native.hostCaps.proc_spawn) throw unsupported("Spawning a process without host process support");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env || proc.env)) if (value !== undefined) env[key] = String(value);
    const io = options.stdio;
    const input = Array.isArray(io) ? io[0] : options.stdin;
    const output = Array.isArray(io) ? io[1] : options.stdout;
    const error = Array.isArray(io) ? io[2] : options.stderr;
    const requestedCwd = options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : String(options.cwd || native.cwd());
    const cwd = internal.require("path").resolve(native.cwd(), requestedCwd);
    const meta: SpawnMeta = { executable: argv[0], argv, cwd, env,
      stdin: stdioMode(input, 0, "ignore"),
      stdout: stdioMode(output, 1, "pipe"),
      stderr: stdioMode(error, 2, sync ? "pipe" : "inherit") };
    if (options._worker) meta.worker = options._worker;
    return { meta, options, input };
  }

  // The process service starts children asynchronously, so a bad cwd would only show up as an exit
  // status. Like POSIX spawn, report it as the spawn error, before any descriptor or child exists.
  function checkCwd({ executable, cwd }: SpawnMeta) {
    let code = "";
    try {
      if ((native.stat(cwd, false).mode & 0o170000) !== 0o040000) code = "ENOTDIR";
    } catch (error) {
      code = (error as { code?: string }).code || "EIO";
    }
    if (!code) return;
    throw Object.assign(new Error(`spawn ${executable} ${code}`), { code, errno: nodeErrnos[code], syscall: "spawn", path: executable });
  }

  // Every descriptor the call creates is released again if the spawn fails. Child ends are
  // closed here once procSpawn has taken its own references, so the child sees EOF or EPIPE
  // as soon as the last parent copy goes.
  function start(cmd: unknown, options: SpawnOptions | undefined, sync: boolean): Started {
    const spec = normalize(cmd, options, sync);
    if (spec.options.signal && spec.options.signal.aborted) throw spec.options.signal.reason;
    if (spec.options.killSignal !== undefined) signalNumber(spec.options.killSignal);
    checkCwd(spec.meta);
    const held = new Set<number>();
    const release = (fd: number) => { if (held.delete(fd)) native.procClose(fd); };
    const pipe = (): [number, number] => {
      const ends = native.procPipe();
      if (typeof ends === "number") throw processError(ends, "pipe");
      held.add(ends[0]);
      held.add(ends[1]);
      return ends;
    };
    const bindings: { child: number; parent: number }[] = [];
    const childEnds: number[] = [];
    try {
      let stdinFd = -1;
      const outputFds = [-1, -1];
      const discard = [false, false];
      let worker: Started["worker"] = null;
      [spec.meta.stdin, spec.meta.stdout, spec.meta.stderr].forEach((mode, fd) => {
        if (mode === "inherit") { bindings.push({ child: fd, parent: fd }); return; }
        const [read, write] = pipe();
        if (fd === 0) {
          // Ignored stdin is a pipe whose only writer is already gone: the child reads EOF.
          bindings.push({ child: 0, parent: read });
          childEnds.push(read);
          if (mode === "pipe") stdinFd = write; else release(write);
          return;
        }
        // Ignored output is drained and dropped; there is no /dev/null descriptor.
        bindings.push({ child: fd, parent: write });
        childEnds.push(write);
        outputFds[fd - 1] = read;
        discard[fd - 1] = mode === "ignore";
      });
      const { executable, argv, cwd } = spec.meta;
      let env = spec.meta.env;
      if (spec.options._worker) {
        // Control channels are two more ordinary bindings. Each child number is the parent's own
        // descriptor number for that end, so it cannot collide with another binding, and the child
        // learns both from its environment. Only listed descriptors reach a child: grandchildren
        // inherit nothing implicitly.
        const toWorker = pipe();
        const fromWorker = pipe();
        bindings.push({ child: toWorker[0], parent: toWorker[0] }, { child: fromWorker[1], parent: fromWorker[1] });
        childEnds.push(toWorker[0], fromWorker[1]);
        worker = { input: fromWorker[0], output: toWorker[1] };
        env = Object.assign({}, env, { BUNWASM_WORKER_CONTROL: JSON.stringify({ input: toWorker[0], output: fromWorker[1] }) });
      }
      // Children join the caller's own job so job-wide signals and waits reach them; a detached
      // child starts a new foreground job instead. Failing to name the caller's job is an error.
      const detached = Boolean(spec.options.detached);
      let inherited = 0;
      if (!detached) {
        inherited = native.procJobOf(0);
        if (inherited <= 0) throw processError(inherited < 0 ? inherited : -28, "spawn", executable);
      }
      const request: Record<string, unknown> = { executable, argv, env, cwd, job: inherited, fds: bindings };
      if (spec.meta.worker) request.worker = spec.meta.worker;
      const pid = native.procSpawn(JSON.stringify(request));
      if (pid < 0) throw processError(pid, "spawn", executable);
      for (const fd of childEnds) release(fd);
      held.clear();
      // Only a job this child owns is ours to reap or kill; an inherited group belongs to its owner.
      const job = detached ? native.procJobOf(pid) : 0;
      return Object.assign(spec, { pid, job: job > 0 ? job : 0, stdinFd, outputFds, discard, worker });
    } catch (error) {
      for (const fd of Array.from(held)) release(fd);
      throw error;
    }
  }

  // Completion of a direct child, repeatable until its job is reaped; null while it runs.
  function waitChild(pid: number): Exit | null {
    const result = native.procWait(pid);
    if (result === AGAIN) return null;
    if (typeof result === "number") throw processError(result, "wait");
    return { kind: result[0], code: result[1] };
  }

  // Reaps the child's job once every member has quiesced. A job already gone is reaped.
  function reapJob(job: number): boolean {
    if (!job) return true;
    return native.procWaitJob(job, 1) !== AGAIN;
  }

  function terminate(pid: number, job: number) {
    if (job && native.procKillJob(job, 9) >= 0) return;
    native.procKill(pid, 9);
  }

  // The synchronous paths sleep on exactly what they wait for; bounded so timeouts still fire.
  function sleepOn(list: Uint8Array[], timeout: number) {
    native.procPoll(watching(list), timeout);
  }

  // Bounded steps let the synchronous path drain all pipes while stdin is written.
  function readPipe(state: OutputState, consume: (chunk: Uint8Array) => void): boolean {
    if (state.fd < 0) return false;
    const chunk = native.procRead(state.fd, 65536);
    if (chunk === AGAIN) return false;
    if (typeof chunk !== "number") {
      if (!state.discard) consume(Buffer.from(chunk));
      return true;
    }
    const fd = state.fd;
    state.fd = -1;
    native.procClose(fd);
    if (chunk < 0) throw processError(chunk, "read");
    state.end();
    return true;
  }

  function writer(fd: number): Sink {
    const queue: Uint8Array[] = [];
    let closing = false;
    let closed = fd < 0;
    function flush() {
      if (closed) return true;
      if (queue.length) {
        const chunk = queue[0];
        const count = native.procWrite(fd, chunk);
        if (count === AGAIN || count === 0) return false;
        if (count < 0) {
          // A write to a pipe nobody reads fails like Node's stream write.
          if (-count === 64) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
          throw processError(count, "write");
        }
        if (count === chunk.length) queue.shift();
        else queue[0] = chunk.subarray(count);
      }
      if (!queue.length && closing) {
        native.procClose(fd);
        closed = true;
      }
      return closed || !queue.length;
    }
    const sink: Sink = {
      write(chunk) {
        if (closed || closing) throw Object.assign(new Error("write after end"), { code: "EPIPE", errno: -32, syscall: "write" });
        const data = bytes(chunk);
        if (data.length) queue.push(data.slice());
        flush();
        return data.length;
      },
      flush,
      destroy() { if (!closed) native.procClose(fd); closed = true; queue.length = 0; },
      end(chunk?: unknown) {
        if (chunk !== undefined) sink.write(chunk);
        closing = true;
        flush();
      },
      // Queued bytes wait for the pipe to drain.
      watch() { return !closed && queue.length ? subscription(WRITABLE, fd) : new Uint8Array(0); },
      get closed() { return closed; },
      ref() { return sink; },
      unref() { return sink; },
    };
    return sink;
  }

  function initialInput(input: unknown, sink: Sink) {
    if (input === undefined || input === null || input === "pipe" || input === "inherit" || input === "ignore" || input === 0) return;
    const stream = input as { getReader?: unknown } & AsyncIterable<unknown>;
    if (stream && typeof stream.getReader === "function") {
      (async () => { for await (const chunk of stream) sink.write(chunk); sink.end(); })().catch(() => sink.end());
      return;
    }
    sink.end(input);
  }

  function spawn(cmd: unknown, options?: SpawnOptions): Child {
    const spec = start(cmd, options, false);
    internal.require("net");
    const sink = writer(spec.stdinFd);
    const outputs: (Pipe | null)[] = [];
    const maxBuffer = spec.options.maxBuffer === undefined ? DEFAULT_MAX_BUFFER : Number(spec.options.maxBuffer);
    const states = spec.outputFds.map((fd, index): OutputState => {
      const state: OutputState = { fd, size: 0, discard: spec.discard[index], end() {}, error() {}, consume() {} };
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let wake: (() => void) | null = null;
      let cancelled = false;
      let ended = false;
      const notify = () => { if (wake) wake(); wake = null; };
      const stream = fd >= 0 && !state.discard ? new web.ReadableStream({
        start(c) { controller = c; },
        pull() { if (state.fd >= 0) return new Promise<void>((resolve) => { wake = resolve; }); },
        cancel() { cancelled = true; if (state.fd >= 0) native.procClose(state.fd); state.fd = -1; notify(); },
      }) : null;
      state.end = () => { if (controller && !cancelled && !ended) controller.close(); ended = true; notify(); };
      state.error = (error) => { if (controller && !cancelled && !ended) controller.error(error); ended = true; notify(); };
      state.consume = (chunk) => {
        if (!cancelled) controller!.enqueue(chunk);
        notify();
        state.size += chunk.length;
        if (state.size <= maxBuffer) return;
        child.exitedDueToMaxBuffer = true;
        child.kill(spec.options.killSignal);
        native.procClose(state.fd);
        state.fd = -1;
        state.end();
      };
      outputs.push(stream && Object.assign(stream, {
        text: () => new web.Response(stream).text(),
        bytes: () => (globalThis as unknown as { Bun: { readableStreamToBytes(stream: unknown): Promise<Uint8Array> } }).Bun.readableStreamToBytes(stream),
        arrayBuffer: () => new web.Response(stream).arrayBuffer(),
        json: () => new web.Response(stream).json(),
      }));
      return state;
    });
    let resolveExit!: (code: number) => void;
    let rejectExit!: (error: unknown) => void;
    let timer: unknown;
    let abort: (() => void) | undefined;
    let closed = false;
    let settled = false;
    let reaped = false;
    let result: Exit | null = null;
    const exited = new Promise<number>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    const child: Child = {
      pid: spec.pid, stdin: spec.stdinFd >= 0 ? sink : null, stdout: outputs[0], stderr: outputs[1],
      exited, exitCode: null, signalCode: null, killed: false,
      exitedDueToTimeout: false, exitedDueToMaxBuffer: false,
      kill(signal) {
        if (settled) return;
        const number = signalNumber(signal);
        if (waitChild(spec.pid)) return;
        // Signal 0 only asks whether the child is still alive.
        if (!number) return;
        const status = native.procKill(spec.pid, number);
        if (status < 0) {
          if (waitChild(spec.pid)) return;
          throw processError(status, "kill");
        }
        child.killed = true;
        // Requests do not classify completion; even SIGKILL may lose to an already selected exit.
      },
      ref() { waiter.ref = true; return child; },
      unref() { waiter.ref = false; return child; },
      resourceUsage() { return undefined; },
      async [Symbol.asyncDispose]() { if (!settled) child.kill(); await exited; },
    };
    function finish(status: Exit) {
      result = status;
      const signalCode = status.kind === 1 ? signalName(status.code) : null;
      const code = status.kind === 1 ? 128 + status.code : status.code;
      settled = true;
      child.exitCode = signalCode === null ? code : null;
      child.signalCode = signalCode;
      if (timer) internal.realTimers.clearTimeout(timer);
      if (abort) spec.options.signal!.removeEventListener("abort", abort);
      resolveExit(code);
      if (typeof spec.options.onExit === "function") spec.options.onExit(child, child.exitCode, child.signalCode, null);
    }
    function close() {
      if (closed) return;
      closed = true;
      sink.destroy();
    }
    function step() {
      if (closed) return true;
      if (!settled) {
        const status = waitChild(spec.pid);
        if (status) { sink.destroy(); finish(status); }
      }
      if (!settled) sink.flush();
      let progress = false;
      for (const state of states) if (readPipe(state, state.consume)) progress = true;
      if (settled && !reaped) reaped = reapJob(spec.job);
      if (settled && reaped && states.every((state) => state.fd < 0)) { if (!spec.options._worker) close(); return true; }
      return progress ? "progress" : false;
    }
    // What the idle event loop sleeps on: output, a blocked stdin write, and the exit itself.
    function subscriptions() {
      const list: Uint8Array[] = [];
      for (const state of states) if (state.fd >= 0) list.push(subscription(READABLE, state.fd));
      if (!settled) {
        list.push(subscription(CHILD_EXIT, spec.pid));
        list.push(sink.watch());
      } else if (!reaped && spec.job) list.push(subscription(JOB_EMPTY, spec.job));
      return watching(list);
    }
    function fail(error: unknown) {
      for (const state of states) {
        if (state.fd >= 0) native.procClose(state.fd);
        state.fd = -1;
        state.error(error);
      }
      close();
      rejectExit(error);
    }
    Object.defineProperty(child, "_finishWorker", { value: close });
    const waiter: BunWasm.IoWaiter = internal.addIoWaiter({ step, fail, subscriptions, ref: true });
    if (spec.worker) Object.defineProperty(child, "_workerChannel", { value: spec.worker });
    Object.defineProperty(child, "_abortWorker", { value() {
      terminate(spec.pid, spec.job);
      for (const state of states) {
        if (state.fd >= 0) native.procClose(state.fd);
        state.fd = -1;
        state.end();
      }
      settled = true;
      resolveExit(1);
      close();
    } });
    initialInput(spec.input, sink);
    if (Number(spec.options.timeout) > 0) timer = internal.realTimers.setTimeout(() => { child.exitedDueToTimeout = true; child.kill(spec.options.killSignal); }, Number(spec.options.timeout));
    if (spec.options.signal) {
      abort = () => child.kill(spec.options.killSignal);
      spec.options.signal.addEventListener("abort", abort, { once: true });
    }
    return child;
  }

  function spawnSync(cmd: unknown, options?: SpawnOptions): Loose {
    validateCommandLength(cmd);
    let spec: Started;
    try { spec = start(cmd, options, true); } catch (error) {
      return { pid: 0, success: false, exitCode: 1, signalCode: null, stdout: Buffer.alloc(0), stderr: Buffer.from((error as Error).message + "\n"), error };
    }
    const chunks: Uint8Array[][] = [[], []];
    const states = spec.outputFds.map((fd, index): OutputState => ({ fd, size: 0, discard: spec.discard[index], end() {}, error() {}, consume() {} }));
    const sink = writer(spec.stdinFd);
    const started = native.now();
    const maxBuffer = spec.options.maxBuffer === undefined ? DEFAULT_MAX_BUFFER : Number(spec.options.maxBuffer);
    const timeout = Number(spec.options.timeout);
    const sizes = [0, 0];
    let status: Exit | null = null;
    let timedOut = false;
    function wait() {
      const list: Uint8Array[] = [];
      for (const state of states) if (state.fd >= 0) list.push(subscription(READABLE, state.fd));
      if (!status) list.push(subscription(CHILD_EXIT, spec.pid));
      list.push(sink.watch());
      const left = timeout > 0 && !timedOut ? started + timeout - native.now() : 25;
      sleepOn(list, Math.max(1, Math.min(25, Math.ceil(left))));
    }
    function outcome(extra: Record<string, unknown>) {
      const signalCode = status!.kind === 1 ? signalName(status!.code) : null;
      return Object.assign({ pid: spec.pid, success: false, exitCode: signalCode === null ? status!.code : null, signalCode,
        stdout: Buffer.from(internal.concatBytes(chunks[0])), stderr: Buffer.from(internal.concatBytes(chunks[1])) }, extra);
    }
    try {
      if (spec.input && typeof (spec.input as { getReader?: unknown }).getReader === "function") throw unsupported("Synchronous streaming stdin");
      initialInput(spec.input, sink);
      sink.end();
      while (!status || states.some((state) => state.fd >= 0)) {
        sink.flush();
        states.forEach((state, i) => readPipe(state, (chunk) => {
          sizes[i] += chunk.length;
          if (sizes[i] > maxBuffer) throw Object.assign(new Error("Child process output exceeds maxBuffer"), { code: "ENOBUFS" });
          chunks[i].push(chunk);
        }));
        if (!status) status = waitChild(spec.pid);
        if (!status && !timedOut && timeout > 0 && native.now() - started >= timeout) {
          timedOut = true;
          const requested = native.procKill(spec.pid, signalNumber(spec.options.killSignal));
          if (requested < 0 && !(status = waitChild(spec.pid))) throw processError(requested, "kill");
        }
        if (!status || states.some((state) => state.fd >= 0)) wait();
      }
      return outcome({ success: status.kind === 0 && status.code === 0, exitedDueToTimeout: timedOut });
    } catch (error) {
      terminate(spec.pid, spec.job);
      // Selection can precede completion publication. Observe the winner before reaping it.
      while (!(status = waitChild(spec.pid))) wait();
      return outcome({ error });
    } finally {
      for (const fd of [spec.stdinFd].concat(spec.outputFds)) if (fd >= 0) native.procClose(fd);
      const waiting = subscription(JOB_EMPTY, spec.job);
      while (!reapJob(spec.job)) sleepOn([waiting], 25);
    }
  }

  // A deliberately small shell tokenizer. Shell operators and expansions never
  // escape into native executables; quoted JavaScript passed to bun -e is safe.
  function shellArgs(command: unknown) {
    const args: string[] = [];
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

  // The Node wrappers are deliberately duck-typed: their option bags and emitters mirror Node's own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = any;

  function nodeChildProcess() {
    const EventEmitter = internal.require("events");
    const { Readable, Writable } = internal.builtin("node:stream");

    function nodeOptions(options: Loose = {}) {
      const io = options.stdio === undefined ? "pipe" : options.stdio;
      const stdio = Array.isArray(io) ? io : [io, io, io];
      if (stdio.includes("ipc")) throw unsupported("Child process IPC");
      return Object.assign({}, options, { stdio });
    }

    function nodeArgv(command: string, args: string[], options: Loose) {
      if (options.shell) return shellArgs([command].concat(args).join(" "));
      return [command].concat(args);
    }

    function nodeReadable(stream: Loose) {
      if (!stream) return null;
      const readable = new Readable({ read() {} });
      (readable as Loose)._childDrained = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { readable.push(null); return; }
          readable.push(Buffer.from(value));
        }
      })().catch((error) => readable.destroy(error));
      return readable;
    }

    function nodeWritable(sink: Loose) {
      if (!sink) return null;
      return new Writable({
        write(chunk, encoding, callback) {
          try { sink.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk); callback(); }
          catch (error) { callback(error); }
        },
        final(callback) { sink.end(); callback(); },
      });
    }

    class ChildProcess extends (EventEmitter as unknown as new() => Loose) {
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

    function reportExit(child: Loose, code: number) {
      child.signalCode = child._child.signalCode;
      child.exitCode = child.signalCode === null ? code : null;
      child.emit("exit", child.exitCode, child.signalCode);
      // Web stream completion schedules Node stream end callbacks as immediates.
      // Give those callbacks a turn before close, including unread output pipes.
      Promise.all(child._drains).then(() => internal.realTimers.setImmediate(() => child.emit("close", child.exitCode, child.signalCode)));
    }

    function nodeSpawn(command: string, args?: Loose, options?: Loose) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = nodeOptions(options);
      const child = new ChildProcess();
      const argv = nodeArgv(command, args, options);
      child.spawnfile = String(command);
      child.spawnargs = argv;
      try { child._child = spawn(argv, options); } catch (error) {
        internal.nextTick(() => { child.emit("error", error); child.emit("close", -2, null); });
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
      child._child.exited.then((code: number) => reportExit(child, code), (error: unknown) => child.emit("error", error));
      return child;
    }

    function nodeSpawnSync(command: string, args?: Loose, options?: Loose) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = nodeOptions(options);
      const argv = nodeArgv(command, args, options);
      const config = Object.assign({}, options);
      if (options.input !== undefined) config.stdio = [options.input].concat(options.stdio.slice(1));
      const result = spawnSync(argv, config);
      const signal = result.signalCode;
      if (result.exitedDueToTimeout) result.error = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT", errno: -110, syscall: "spawnSync", path: String(command) });
      const encoding = options.encoding;
      const stdout = options.stdio[1] === "inherit" || options.stdio[1] === "ignore" ? null : encoding && encoding !== "buffer" ? result.stdout.toString(encoding) : result.stdout;
      const stderr = options.stdio[2] === "inherit" || options.stdio[2] === "ignore" ? null : encoding && encoding !== "buffer" ? result.stderr.toString(encoding) : result.stderr;
      return { pid: result.pid, status: result.error || signal ? null : result.exitCode, signal,
        output: [null, stdout, stderr], stdout, stderr, error: result.error };
    }

    function failure(command: string, result: Loose) {
      const { error, ...details } = result;
      if (error) return Object.assign(error, details);
      return Object.assign(new Error(`Command failed: ${command}\n${result.stderr}`), result, { code: result.status });
    }

    function execFileSync(command: string, args?: Loose, options?: Loose) {
      const result = nodeSpawnSync(command, args, options);
      if (result.error || result.status !== 0) throw failure(command, result);
      return result.stdout;
    }

    function execSync(command: string, options?: Loose) {
      const argv = shellArgs(command);
      return execFileSync(argv[0], argv.slice(1), options);
    }

    function execFile(command: string, args?: Loose, options?: Loose, callback?: Loose) {
      if (typeof args === "function") { callback = args; args = []; options = {}; }
      else if (!Array.isArray(args)) { callback = options; options = args || {}; args = []; }
      if (typeof options === "function") { callback = options; options = {}; }
      options = Object.assign({ maxBuffer: 1024 * 1024 }, options);
      const child = nodeSpawn(command, args, options);
      const out: Loose[] = [];
      const err: Loose[] = [];
      let reported = false;
      const sizes = [0, 0];
      function collect(chunk: Loose, parts: Loose[], fd: number) {
        sizes[fd] += chunk.length;
        if (sizes[fd] <= options.maxBuffer) { parts.push(Buffer.from(chunk)); return; }
        child.kill(options.killSignal);
        complete(Object.assign(new Error("Child process output exceeds maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      }
      if (child.stdout) child.stdout.on("data", (chunk: Loose) => collect(chunk, out, 0));
      if (child.stderr) child.stderr.on("data", (chunk: Loose) => collect(chunk, err, 1));
      function complete(error?: Loose) {
        if (reported) return;
        reported = true;
        const encoding = options.encoding === undefined ? "utf8" : options.encoding;
        const stdout = encoding === "buffer" || encoding === null ? Buffer.concat(out) : Buffer.concat(out).toString(encoding);
        const stderr = encoding === "buffer" || encoding === null ? Buffer.concat(err) : Buffer.concat(err).toString(encoding);
        if (error) Object.assign(error, { stdout, stderr });
        if (typeof callback === "function") callback(error, stdout, stderr);
      }
      child.on("error", complete);
      child.on("close", (code: number, signal: string) => complete(code === 0 ? null : Object.assign(new Error(`Command failed: ${command}`), { code, signal, killed: child.killed })));
      return child;
    }

    function exec(command: string, options?: Loose, callback?: Loose) {
      if (typeof options === "function") { callback = options; options = {}; }
      const argv = shellArgs(command);
      return execFile(argv[0], argv.slice(1), options, callback);
    }

    function fork(modulePath: string, args?: Loose, options?: Loose) {
      if (!Array.isArray(args)) { options = args || {}; args = []; }
      options = options || {};
      const execArgs = options.execArgv || (process as unknown as BunWasm.GuestProcess).execArgv;
      const config = Object.assign({}, options, { stdio: options.stdio || (options.silent ? "pipe" : "inherit") });
      return nodeSpawn(options.execPath || (process as unknown as BunWasm.GuestProcess).execPath, execArgs.concat([String(modulePath)], args), config);
    }

    const custom = Symbol.for("nodejs.util.promisify.custom");
    function promisified(fn: Loose) {
      return (...args: Loose[]) => {
        let child: Loose;
        const promise: Loose = new Promise((resolve, reject) => {
          child = fn(...args, (error: Loose, stdout: Loose, stderr: Loose) => error ? reject(error) : resolve({ stdout, stderr }));
        });
        promise.child = child;
        return promise;
      };
    }
    exec[custom] = promisified(exec);
    execFile[custom] = promisified(execFile);
    return { ChildProcess, spawn: nodeSpawn, spawnSync: nodeSpawnSync, exec, execSync, execFile, execFileSync, fork };
  }

  return { spawn, spawnSync, nodeChildProcess };
})
