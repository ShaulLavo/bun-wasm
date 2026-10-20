(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const AGAIN = -6;
  const encoder = new TextEncoder();
  const HIGH_WATER_MARK = 128 * 1024;
  type Callback = (error: Error | null) => void;
  interface Write { bytes: Uint8Array; offset: number; callback?: Callback }

  function channelError(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }

  function subscription(kind: number, fd: number) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, kind, true);
    view.setUint32(4, fd, true);
    return bytes;
  }

  function callbackOf(handle: unknown, options: unknown, callback: unknown): Callback | undefined {
    const candidate = typeof handle === "function" ? handle : typeof options === "function" ? options : callback;
    if (candidate !== undefined && typeof candidate !== "function") throw new TypeError("IPC callback must be a function");
    if (typeof candidate !== "function") return undefined;
    return error => candidate(error);
  }

  function serialize(message: unknown) {
    const kind = typeof message;
    if (kind !== "object" && kind !== "string" && kind !== "number" && kind !== "boolean") {
      throw Object.assign(new TypeError("IPC message must be an object, string, number or boolean"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const json = JSON.stringify(message);
    if (json === undefined) throw Object.assign(new TypeError("IPC message is not JSON serializable"), { code: "ERR_INVALID_ARG_TYPE" });
    return encoder.encode(json + "\n");
  }

  function open(target: BunWasm.NodeEmitter, descriptors: BunWasm.IpcDescriptors, childSide = false): BunWasm.ChildIpc {
    internal.require("net");
    const decoder = new TextDecoder();
    const queue: Write[] = [];
    let state: "open" | "draining" | "closed" = "open";
    let incoming = "";
    let queuedBytes = 0;
    let explicitRef: boolean | undefined;
    function complete(callback: Callback | undefined, error: Error | null) {
      internal.nextTick(() => callback ? callback(error) : error && target.emit("error", error));
    }
    function close(error: Error = channelError("ERR_IPC_CHANNEL_CLOSED", "Channel closed")) {
      if (state === "closed") return;
      state = "closed";
      native.procClose(descriptors.input);
      native.procClose(descriptors.output);
      for (const write of queue.splice(0)) complete(write.callback, error);
      queuedBytes = 0;
      incoming = "";
      internal.nextTick(() => target.emit("disconnect"));
    }
    function flush() {
      let progressed = false;
      for (let turn = 0; turn < 32 && queue.length; turn++) {
        const write = queue[0];
        const count = native.procWrite(descriptors.output, write.bytes.subarray(write.offset));
        if (count === AGAIN || count === 0) break;
        if (count < 0) { close(channelError(count === -64 ? "EPIPE" : "ERR_IPC_CHANNEL_CLOSED", "IPC write failed")); return true; }
        progressed = true;
        queuedBytes -= count;
        write.offset += count;
        if (write.offset !== write.bytes.length) continue;
        queue.shift();
        if (write.callback) complete(write.callback, null);
      }
      if (state === "draining" && !queue.length) close();
      return progressed;
    }
    function deliverLines() {
      let end = incoming.indexOf("\n");
      while (end >= 0) {
        const message: unknown = JSON.parse(incoming.slice(0, end));
        incoming = incoming.slice(end + 1);
        internal.nextTick(() => target.emit("message", message, undefined));
        end = incoming.indexOf("\n");
      }
      if (incoming.length > 64 * 1024 * 1024) throw channelError("ERR_IPC_MESSAGE_TOO_LARGE", "IPC message exceeds 64 MiB");
    }
    function read() {
      let progressed = false;
      for (let turn = 0; turn < 32 && state !== "closed"; turn++) {
        const bytes = native.procRead(descriptors.input, 65536);
        if (bytes === AGAIN) break;
        if (typeof bytes === "number") {
          if (bytes < 0 || incoming.length) throw channelError("ERR_IPC_CHANNEL_CLOSED", "Invalid or incomplete IPC message");
          close(); return true;
        }
        progressed = true;
        incoming += decoder.decode(bytes, { stream: true });
        deliverLines();
      }
      return progressed;
    }
    const channel: BunWasm.ChildIpc = {
      get connected() { return state === "open"; },
      send(message, handle, options, callback) {
        const done = callbackOf(handle, options, callback);
        if (handle !== undefined && handle !== null && typeof handle !== "function") throw channelError("ERR_NOT_SUPPORTED_IN_WASM", "IPC handle passing is not supported in bun-wasm");
        if (state !== "open") { complete(done, channelError("ERR_IPC_CHANNEL_CLOSED", "Channel is closed")); return false; }
        const bytes = serialize(message);
        if (!channel.connected) { complete(done, channelError("ERR_IPC_CHANNEL_CLOSED", "Channel is closed")); return false; }
        queue.push({ bytes, offset: 0, callback: done });
        queuedBytes += bytes.length;
        const accepted = queuedBytes < HIGH_WATER_MARK;
        flush();
        return state === "open" && accepted;
      },
      disconnect() {
        if (state !== "open") { complete(undefined, channelError("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected")); return; }
        state = "draining";
        flush();
      },
      finish() { if (state !== "closed") read(); close(); },
      close,
      ref() { explicitRef = true; return channel; },
      unref() { explicitRef = false; return channel; },
    };
    Object.defineProperty(target, "connected", { configurable: true, get: () => channel.connected });
    Object.defineProperty(target, "channel", { configurable: true, value: channel });
    internal.addIoWaiter({
      get ref() { return queue.length > 0 || state !== "closed" && (explicitRef ?? (!childSide || target.listenerCount("message") > 0 || target.listenerCount("disconnect") > 0)); },
      step() {
        if (state === "closed") return true;
        const progress = read();
        return flush() || progress ? "progress" : false;
      },
      fail(error) { close(error instanceof Error ? error : new Error(String(error))); },
      subscriptions() {
        if (state === "closed") return new Uint8Array(0);
        const reading = subscription(0, descriptors.input);
        return queue.length ? internal.concatBytes([reading, subscription(1, descriptors.output)]) : reading;
      },
    });
    return channel;
  }

  function initialize() {
    const process = internal.require("process");
    const encoded = process.env.BUNWASM_IPC_CHANNEL;
    if (encoded === undefined) return;
    delete process.env.BUNWASM_IPC_CHANNEL;
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== "object" || !("input" in value) || !("output" in value)) throw new TypeError("Invalid IPC descriptors");
    const { input, output } = value;
    if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 3 || output < 3 || input === output) throw new TypeError("Invalid IPC descriptors");
    const channel = open(process, { input, output }, true);
    Object.assign(process, { send: channel.send, disconnect: channel.disconnect });
    process.once("exit", () => channel.close());
  }

  return { open, initialize };
})
