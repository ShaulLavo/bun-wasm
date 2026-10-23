(function (internal: BunWasm.Internal) {
  type Waiter = { ref: boolean; step(): boolean | "progress" };
  type Server = {
    listening: boolean;
    _listener: number;
    _referenced?: boolean;
    _starting: Waiter | null;
    _accepting?: Waiter;
    emit(event: string, ...args: unknown[]): unknown;
  };
  type Options = {
    addWaiter(waiter: Waiter): Waiter;
    accept(): Waiter;
    hostError(handle: number, fallback: string): Error;
  };
  function step(server: Server, options: Options): boolean {
    if (!server.listening) { server._starting = null; return true; }
    const address = internal.native.hostLocalAddr(server._listener);
    if (address === -2) return false;
    server._starting = null;
    if (typeof address === "string") return ready(server, options);
    const error = options.hostError(server._listener, "listen failed");
    internal.native.hostClose(server._listener);
    server.listening = false;
    server.emit("error", error);
    return true;
  }
  function ready(server: Server, options: Options): boolean {
    server.emit("listening");
    if (!server.listening) return true;
    server._accepting = options.accept();
    server._accepting.ref = server._referenced !== false;
    return true;
  }
  function start(server: Server, options: Options): void {
    server._starting = options.addWaiter({
      ref: server._referenced !== false,
      step: () => step(server, options),
    });
  }
  return { start };
})
