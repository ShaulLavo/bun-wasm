(function (internal: BunWasm.Internal) {
  const { error } = internal.require("net_port");
  type SocketAddress = { address?: string; port?: number; family?: string };
  type NetworkError = Error & { code?: string; syscall?: string; address?: string; port?: number };
  function absolute(value: unknown): string {
    if (typeof value !== "string") throw error(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.path" property must be of type string');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw error(Error, "EINVAL", "Socket path contains invalid Unicode");
    // A leading NUL names Waffle's abstract namespace: classify before any cwd join.
    if (value.startsWith("\0")) return value;
    if (!value || value.startsWith("/")) return value;
    const cwd = internal.native.cwd();
    return `${cwd.endsWith("/") ? cwd : cwd + "/"}${value}`;
  }
  function failure(err: NetworkError, syscall: string, path: string): NetworkError {
    err.syscall = syscall;
    err.address = path;
    delete err.port;
    return err;
  }
  function local(text: string): SocketAddress | string {
    const address = JSON.parse(text);
    return address.family === "Unix" ? address.path || "" : address;
  }
  function peer(address: SocketAddress): SocketAddress {
    return address.family === "Unix" ? {} : address;
  }
  function listen(value: unknown, hostError: (handle: number, message: string) => NetworkError): number {
    const path = absolute(value);
    const handle = internal.native.hostListenPath(path, 1);
    if (handle >= 0) return handle;
    throw failure(hostError(0, "listen failed"), "listen", String(value));
  }
  type DialingSocket = {
    _conn: { handle: number } | null;
    _referenced: boolean;
    _connecting: unknown;
    _connectStep(name: string): boolean;
    destroy(error: Error): unknown;
  };
  type DialTransport = {
    Connection: new (handle: number) => { handle: number };
    addWaiter(waiter: { ref: boolean; step(): boolean; fail(error: Error): unknown }): unknown;
    hostError(handle: number, message: string): NetworkError;
  };
  function connect(socket: DialingSocket, path: string, name: string, transport: DialTransport): void {
    const handle = internal.native.hostConnectPath(path);
    if (handle < 0) {
      const err = failure(transport.hostError(0, "connect failed"), "connect", name);
      internal.nextTick(() => socket.destroy(err));
      return;
    }
    socket._conn = new transport.Connection(handle);
    socket._connecting = transport.addWaiter({ ref: socket._referenced,
      step: () => socket._connectStep(name), fail: err => socket.destroy(err),
    });
  }
  type PathServer = {
    _listener: number;
    _pipeName: string;
    _closeError?: NetworkError;
    emit(event: string, error: NetworkError): unknown;
  };
  function close(server: PathServer, hostError: DialTransport["hostError"], callback: boolean): void {
    const status = internal.native.hostClose(server._listener);
    server._closeError = undefined;
    if (status >= 0) return;
    const err = failure(hostError(0, "close failed"), "close", server._pipeName);
    server._closeError = err;
    if (!callback) internal.nextTick(() => server.emit("error", err));
  }
  return { absolute, failure, local, peer, listen, connect, close };
})
