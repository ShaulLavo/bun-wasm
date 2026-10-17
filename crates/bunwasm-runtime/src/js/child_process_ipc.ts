(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const encoder = new TextEncoder();
  const { Buffer } = internal.require("buffer");
  const AGAIN = -2;
  const marker = "BUNWASM_CHILD_IPC";
  type Callback = (error: Error | null) => void;
  interface Target extends BunWasm.NodeEmitter {
    connected?: boolean;
    channel?: { ref(): unknown; unref(): unknown } | null;
    send?: (...args: unknown[]) => boolean;
    disconnect?: () => void;
  }
  interface Options { stdio?: unknown; ipc?: unknown; _ipc?: boolean; serialization?: unknown; silent?: boolean; }
  interface Child { _ipcClosed?: boolean; }
  const error = (code: string, text: string) => Object.assign(new Error(text), { code });
  function mode(options: Options): "json" | "advanced" {
    const value = options.serialization === undefined ? options._ipc ? "json" : "advanced" : options.serialization;
    if (value !== "json" && value !== "advanced") throw error("ERR_INVALID_ARG_VALUE", "Invalid IPC serialization mode");
    return value;
  }
  function options(value: Options = {}) {
    const io = value.stdio === undefined ? "pipe" : value.stdio;
    const stdio: unknown[] = Array.isArray(io) ? io.slice() : [io, io, io];
    const channels = stdio.filter(item => item === "ipc").length;
    if (channels > 1) throw error("ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe");
    if (stdio.slice(0, 3).includes("ipc")) throw error("ERR_INVALID_ARG_VALUE", "IPC requires an extra stdio entry");
    if (channels) mode(value);
    return Object.assign({}, value, { stdio, _ipc: channels === 1 });
  }
  function forkOptions(value: Options = {}) {
    const io = value.stdio === undefined ? value.silent ? "pipe" : "inherit" : value.stdio;
    const stdio = Array.isArray(io) ? io.slice() : [io, io, io, "ipc"];
    if (!stdio.includes("ipc")) throw error("ERR_CHILD_PROCESS_IPC_REQUIRED", "Forked processes must have an IPC channel");
    return Object.assign({}, value, { stdio });
  }
  function prepare(meta: { env: Record<string, string>; ipc?: boolean }, value: Options, sync: boolean) {
    delete meta.env[marker];
    if (value.ipc !== undefined && typeof value.ipc !== "function") throw new TypeError("ipc must be a function");
    if (!value._ipc && value.ipc === undefined) return;
    if (sync) throw error("ERR_IPC_SYNC_FORK", "IPC requires asynchronous spawn");
    meta.ipc = true;
    meta.env[marker] = mode(value);
  }
  function attach(target: Target, input: number, output: number, serialization: "json" | "advanced", parent: boolean, receive?: (value: unknown) => void, completed?: () => void) {
    const decoder = new TextDecoder();
    const queue: { bytes: Uint8Array; offset: number; callback?: Callback }[] = [];
    let incoming = "";
    let phase: "open" | "closing" | "closed" = "open";
    let explicitRef: boolean | undefined;
    let pendingBytes = 0;
    const codec = serialization === "advanced" ? internal.require("worker_codec").create({
      isPort: () => false,
      buffer: { is: value => Buffer.isBuffer(value), restore: (buffer, offset, length) => Buffer.from(buffer, offset, length) },
      prepare() { throw new TypeError("IPC cannot transfer MessagePorts"); },
      restore() { throw new TypeError("IPC cannot transfer MessagePorts"); },
      activate() {},
    }) : null;
    const schedule = (fn: () => void) => internal.nextTick(fn);
    function report(cause: Error, callback?: Callback) {
      schedule(() => callback ? callback(cause) : target.emit("error", cause));
    }
    function enqueue(frame: unknown, callback?: Callback) {
      const bytes = encoder.encode(JSON.stringify(frame) + "\n");
      queue.push({ bytes, offset: 0, callback });
      pendingBytes += bytes.length;
    }
    function beginClose() {
      if (phase !== "open") return;
      phase = "closing";
      target.connected = false;
      enqueue(["disconnect"]);
    }
    function close() {
      if (phase === "closed") return;
      phase = "closed";
      target.connected = false;
      native.hostClose(input);
      native.hostClose(output);
      for (const item of queue) if (item.callback) report(error("ERR_IPC_CHANNEL_CLOSED", "Channel closed"), item.callback);
      queue.length = 0;
      pendingBytes = 0;
      completed?.();
      schedule(() => { target.channel = null; target.emit("disconnect"); });
    }
    function flush() {
      let progress = false;
      for (let count = 0; count < 32 && queue.length; count++) {
        const item = queue[0];
        const written = native.hostWrite(output, item.bytes.subarray(item.offset));
        if (written === AGAIN || written === 0) break;
        if (written < 0) { close(); return true; }
        progress = true;
        item.offset += written;
        pendingBytes -= written;
        if (item.offset !== item.bytes.length) continue;
        queue.shift();
        if (item.callback) schedule(() => item.callback!(null));
      }
      return progress;
    }
    function dispatch(text: string) {
      const frame: unknown = JSON.parse(text);
      if (!Array.isArray(frame)) throw new Error("Invalid IPC frame");
      if (frame[0] === "disconnect") { beginClose(); return; }
      if (frame[0] !== "message") throw new Error("Invalid IPC message");
      const value = codec ? codec.decode(frame[1]) : frame[1];
      const command = value && typeof value === "object" && "cmd" in value ? value.cmd : undefined;
      if (receive && command !== "NODE_HANDLE") { receive(value); return; }
      const event = typeof command === "string" && command.startsWith("NODE_") ? "internalMessage" : "message";
      target.emit(event, value, undefined);
    }
    function read() {
      let progress = false;
      for (let count = 0; count < 32 && phase !== "closed"; count++) {
        const bytes = native.hostRead(input);
        if (bytes === AGAIN) break;
        if (typeof bytes === "number") { close(); return true; }
        progress = true;
        incoming += decoder.decode(bytes, { stream: true });
        let end = incoming.indexOf("\n");
        while (end >= 0) {
          const text = incoming.slice(0, end);
          incoming = incoming.slice(end + 1);
          dispatch(text);
          end = incoming.indexOf("\n");
        }
        if (incoming.length > 64 * 1024 * 1024) throw new RangeError("IPC message exceeds 64 MiB");
      }
      return progress;
    }
    const waiter = {
      get ref() { return phase !== "closed" && (pendingBytes > 0 || phase === "closing" || (explicitRef ?? (parent || target.listenerCount("message") > 0 || target.listenerCount("disconnect") > 0))); },
      step(): boolean | "progress" {
        if (phase === "closed") return true;
        const wrote = flush();
        const received = read();
        if (phase === "closing" && !queue.length) { close(); return true; }
        return wrote || received ? "progress" : false;
      },
      fail(cause: unknown) { close(); report(cause instanceof Error ? cause : new Error(String(cause))); },
    };
    target.connected = true;
    target.channel = {
      ref() { explicitRef = true; return this; },
      unref() { explicitRef = false; return this; },
    };
    target.send = function send(value: unknown, handle?: unknown, opts?: unknown, callback?: unknown) {
      const cb = [handle, opts, callback].find(item => typeof item === "function") as Callback | undefined;
      if (phase !== "open") { report(error("ERR_IPC_CHANNEL_CLOSED", "Channel closed"), cb); return false; }
      if (value === undefined) throw error("ERR_MISSING_ARGS", "The message argument must be specified");
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new TypeError("Invalid IPC message type");
      if (handle !== undefined && handle !== null && typeof handle !== "function") throw error("ERR_INVALID_HANDLE_TYPE", "IPC handle transfer is not supported");
      const payload = codec ? codec.encode(value) : value;
      enqueue(["message", payload], cb);
      flush();
      return pendingBytes < 128 * 1024;
    };
    target.disconnect = () => {
      if (phase !== "open") { report(error("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected")); return; }
      beginClose();
      flush();
    };
    internal.addIoWaiter(waiter);
    return target.channel;
  }
  function connectNode(target: Target, child: Child, handle: number, value: Options) {
    child._ipcClosed = false;
    attach(target, native.hostChildPipe(handle, 4), native.hostChildPipe(handle, 3), mode(value), true, undefined, () => { child._ipcClosed = true; });
  }
  function connectBun(child: Child, handle: number, value: Options) {
    child._ipcClosed = false;
    const target: Target = new (internal.require("events"))();
    const callback = value.ipc;
    attach(target, native.hostChildPipe(handle, 4), native.hostChildPipe(handle, 3), mode(value), true,
      typeof callback === "function" ? message => callback(message, child) : undefined, () => { child._ipcClosed = true; });
    Object.defineProperties(child, {
      connected: { get: () => target.connected },
      channel: { get: () => target.channel },
      send: { value: target.send },
      disconnect: { value: target.disconnect },
    });
  }
  function initialize() {
    internal.require("net");
    const process = internal.require("process");
    const serialization = process.env[marker];
    delete process.env[marker];
    if (serialization !== "json" && serialization !== "advanced") throw new Error("Invalid child IPC initialization");
    attach(process, native.hostChildPipe(0, 3), native.hostChildPipe(0, 4), serialization, false);
  }
  function sendClosed(target: Target, args: unknown[]) {
    const callback = args.find(value => typeof value === "function") as Callback | undefined;
    internal.nextTick(() => callback ? callback(error("ERR_IPC_CHANNEL_CLOSED", "Channel closed")) : target.emit("error", error("ERR_IPC_CHANNEL_CLOSED", "Channel closed")));
    return false;
  }
  return { options, forkOptions, prepare, connectNode, connectBun, initialize, sendClosed };
})
