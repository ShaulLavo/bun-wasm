declare namespace Tcp {
  type Buffer = BunWasm.BufferBytes & Uint8Array<ArrayBuffer>;
  type BinaryData = ArrayBufferView | (ArrayBufferLike & { buffer?: undefined; byteOffset?: undefined });
  type Payload = string | BinaryData;
  type BinaryType = "arraybuffer" | "buffer" | "uint8array";
  type ReceivedData<Binary extends BinaryType | null | undefined> = Binary extends "arraybuffer" ? ArrayBuffer : Binary extends "uint8array" ? Uint8Array<ArrayBuffer> : Buffer;
  type AnyReceivedData = ReceivedData<BinaryType>;
  type Dispatch<Data> = (socket: Socket<Data>, data: AnyReceivedData) => unknown;
  type CommonHandlers<Data> = {
    open?: ((socket: Socket<Data>) => unknown) | null;
    end?: ((socket: Socket<Data>) => unknown) | null;
    drain?: ((socket: Socket<Data>) => unknown) | null;
    timeout?: ((socket: Socket<Data>) => unknown) | null;
    error?: ((socket: Socket<Data>, error: Error) => unknown) | null;
    close?: ((socket: Socket<Data>, code: 0 | 1) => unknown) | null;
    connectError?: ((socket: Socket<Data>, error: Error) => unknown) | null;
  };
  type Handlers<Data, Binary extends BinaryType | null | undefined> = CommonHandlers<Data> & {
    binaryType?: Binary;
    data?: ((socket: Socket<Data>, data: ReceivedData<Binary>) => unknown) | null;
  };
  type AnyHandlers<Data> = Handlers<Data, "buffer" | null | undefined> |
    (Handlers<Data, "uint8array"> & { binaryType: "uint8array" }) |
    (Handlers<Data, "arraybuffer"> & { binaryType: "arraybuffer" });
  type Options<Data = undefined> = {
    hostname?: string | false | 0 | null;
    port?: number | string;
    tls?: boolean | object | null;
    unix?: unknown;
    socket: AnyHandlers<NoInfer<Data>>;
  } & (undefined extends Data ? { data?: Data } : { data: Data });
  type Socket<Data = undefined> = {
    data: Data;
    listener: Listener<Data> | undefined;
    readonly remoteAddress: string | undefined;
    readonly localPort: number | undefined;
    readonly localAddress: string | undefined;
    readonly remotePort: number | undefined;
    readonly readyState: -2 | -1 | 0 | 1;
    readonly bytesWritten: number;
    write(data: Payload, byteOffset?: number, byteLength?: number): number;
    end(data?: Payload, byteOffset?: number, byteLength?: number): number;
    shutdown(half?: boolean): void;
    terminate(): void;
    flush(): 0;
    timeout(seconds: number): void;
    ref(): Socket<Data>;
    unref(): Socket<Data>;
    reload(options: Pick<Options<Data>, "socket">): void;
  };
  type OpenableSocket<Data> = Socket<Data> & { _open(): void };
  type Listener<Data = undefined> = {
    hostname: string;
    readonly port: number;
    data: Data;
    _sockets: Set<Socket<Data>>;
    stop(force?: boolean): void;
    ref(): Listener<Data>;
    unref(): Listener<Data>;
    reload(options: Partial<Options<Data>>): void;
    [Symbol.dispose](): void;
  };
  type NodeSocket = {
    readonly remoteAddress: string | undefined;
    readonly localPort: number | undefined;
    readonly localAddress: string | undefined;
    readonly remotePort: number | undefined;
    readonly bytesWritten: number;
    readonly destroyed: boolean;
    readonly connecting: boolean;
    readonly writableNeedDrain: boolean;
    _connected?: boolean;
    _attach(connection: unknown): void;
    connect(options: { host: string; port: number | string | undefined }, callback: () => void): unknown;
    write(data: Uint8Array): unknown;
    end(data?: Uint8Array): unknown;
    destroy(error?: unknown): unknown;
    setTimeout(milliseconds: number): unknown;
    ref(): unknown;
    unref(): unknown;
    on(event: "data", listener: (bytes: Buffer) => void): unknown;
    on(event: "end" | "drain" | "timeout", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "close", listener: (hadError: boolean) => void): unknown;
  };
  interface Internal extends Pick<BunWasm.Internal, "native" | "nextTick"> {
    native: BunWasm.Native & { hostLocalPort(handle: number): number };
    builtin(name: "node:net"): { Socket: new() => NodeSocket };
    require(name: "net_address"): {
      port(value?: unknown): number;
      error<T extends Error>(Ctor: new(message: string) => T, code: string, message: string): T & { code: string };
    };
    require(name: "net_hostname"): (hostname: string, allowBrackets?: boolean) => string;
  }
  type Transport = {
    listenOrThrow(hostname: string, port: number): number;
    acceptLoop(handle: number, onConnection: (connection: unknown) => void): { ref: boolean };
    waiters: Set<{ ref: boolean }>;
  };
}
(function (internal: Tcp.Internal) {
  "use strict";
  return function (transport: Tcp.Transport) {
    const { listenOrThrow, acceptLoop, waiters } = transport;
    const { Socket } = internal.builtin("node:net");
    const { port, error } = internal.require("net_address");
    const native = internal.native;
    const sockets = new Set<object>();

    function payload(data: Tcp.Payload, byteOffset = 0, byteLength?: number): Uint8Array {
      const bytes = typeof data === "string" ? (Buffer as BunWasm.BufferConstructor).from(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      return bytes.subarray(byteOffset, byteLength === undefined ? bytes.length : byteOffset + byteLength);
    }

    function wrap<Data>(socket: Tcp.NodeSocket, options: Tcp.Options<Data>, listener?: Tcp.Listener<Data>): Tcp.OpenableSocket<Data> {
      let handlers = options.socket;
      let ended = false;
      const result: Tcp.Socket<Data> & { _open?: () => void } = {
        data: options.data as Data,
        listener,
        get remoteAddress() { return socket.remoteAddress; },
        get localPort() { return socket.localPort; },
        get localAddress() { return socket.localAddress; },
        get remotePort() { return socket.remotePort; },
        get readyState() { return socket.destroyed ? -1 : socket.connecting ? 0 : ended ? -2 : 1; },
        get bytesWritten() { return socket.bytesWritten; },
        write(data, byteOffset = 0, byteLength) {
          if (socket.destroyed || ended) return -1;
          if (socket.writableNeedDrain) return 0;
          const part = payload(data, byteOffset, byteLength);
          socket.write(part);
          return part.length;
        },
        end(data, byteOffset, byteLength) {
          if (socket.destroyed || ended) return -1;
          const part = data === undefined ? undefined : payload(data, byteOffset, byteLength);
          ended = true;
          socket.end(part);
          return part ? part.length : 0;
        },
        shutdown(half = false) { if (half) { ended = true; socket.end(); } else socket.destroy(); },
        terminate() { socket.destroy(); },
        flush() { return 0; },
        timeout(seconds) { socket.setTimeout(seconds * 1000); },
        ref() { socket.ref(); return this; },
        unref() { socket.unref(); return this; },
        reload(options) { handlers = options.socket; },
      };
      sockets.add(result);
      socket.on("data", bytes => {
        let data: Tcp.AnyReceivedData = bytes;
        if (handlers.binaryType === "arraybuffer") data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        else if (handlers.binaryType === "uint8array") data = new Uint8Array(bytes);
        // The binaryType branches above pair each callback with its payload.
        if (handlers.data) (handlers.data as Tcp.Dispatch<Data>)(result, data);
      });
      socket.on("end", () => { if (handlers.end) handlers.end(result); });
      socket.on("drain", () => { if (handlers.drain) handlers.drain(result); });
      socket.on("timeout", () => { if (handlers.timeout) handlers.timeout(result); });
      socket.on("error", err => { if (handlers.error) handlers.error(result, err); });
      socket.once("close", hadError => {
        sockets.delete(result);
        if (listener) listener._sockets.delete(result);
        if (handlers.close) handlers.close(result, hadError ? 1 : 0);
      });
      result._open = () => { if (handlers.open) handlers.open(result); };
      return result as Tcp.OpenableSocket<Data>;
    }
    function validate<Data>(options: Tcp.Options<Data>): void {
      if (!options || typeof options.socket !== "object" || options.socket === null) throw error(TypeError, "ERR_INVALID_ARG_TYPE", "socket handlers are required");
      if (options.tls && options.tls !== true && typeof options.tls !== "object") throw new TypeError("TLSOptions must be an object");
      if (options.unix || options.tls) throw error(Error, "ENOTSUP", "Unix sockets and TLS sockets are not supported in bun-wasm");
      port(options.port);
    }
    function listen<Data = undefined>(options: Tcp.Options<Data>): Tcp.Listener<Data> {
      validate(options);
      const hostname = options.hostname || "0.0.0.0";
      const handle = listenOrThrow(hostname, port(options.port));
      const owned = new Set<Tcp.Socket<Data>>();
      const listener: Tcp.Listener<Data> = {
        hostname, port: native.hostLocalPort(handle), data: options.data as Data,
        _sockets: owned,
        stop(force = false) {
          waiters.delete(accepting);
          native.hostClose(handle);
          if (force) for (const socket of owned) socket.terminate();
        },
        ref() { accepting.ref = true; return this; },
        unref() { accepting.ref = false; return this; },
        reload(next) { options = Object.assign({}, options, next); },
        [Symbol.dispose]() { this.stop(true); },
      };
      const accepting = acceptLoop(handle, conn => {
        const socket = new Socket();
        socket._attach(conn);
        const wrapped = wrap(socket, options, listener);
        owned.add(wrapped);
        wrapped._open();
      });
      return listener;
    }
    function connect<Data = undefined>(options: Tcp.Options<Data>): Promise<Tcp.Socket<Data>> {
      validate(options);
      return new Promise((resolve, reject) => {
        const socket = new Socket();
        const result = wrap(socket, options);
        socket.once("error", err => {
          if (!socket.connecting && socket._connected) return;
          if (options.socket.connectError) options.socket.connectError(result, err);
          reject(err);
        });
        let hostname: string;
        try { hostname = internal.require("net_hostname")(options.hostname || "localhost", true); }
        catch (err) { internal.nextTick(() => socket.destroy(err)); return; }
        socket.connect({ host: hostname, port: options.port }, () => {
          socket._connected = true;
          result._open();
          resolve(result);
        });
      });
    }
    return { listen, connect };
  };
})
