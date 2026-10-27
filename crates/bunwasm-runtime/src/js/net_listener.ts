(function (internal: BunWasm.Internal) {
  type Waiter = { ref: boolean; step(): boolean | "progress" };
  type Startup = Waiter & { phase: "binding" | "announcing" };
  type Server = {
    listening: boolean;
    _listener: number;
    _referenced?: boolean;
    _starting: Startup | null;
    _accepting?: Waiter;
    emit(event: string, ...args: unknown[]): unknown;
  };
  type Options = {
    addWaiter(waiter: Waiter): Waiter;
    accept(): Waiter;
    hostError(handle: number, fallback: string): Error;
  };
  function step(server: Server, options: Options, startup: Startup): boolean {
    if (server._starting !== startup) return true;
    if (startup.phase === "announcing") return false;
    if (!server.listening) { server._starting = null; return true; }
    const address = internal.native.hostLocalAddr(server._listener);
    if (address === -2) return false;
    if (typeof address === "string") return ready(server, options, startup);
    server._starting = null;
    const error = options.hostError(server._listener, "listen failed");
    internal.native.hostClose(server._listener);
    server.listening = false;
    server.emit("error", error);
    return true;
  }
  function ready(server: Server, options: Options, startup: Startup): boolean {
    startup.phase = "announcing";
    server.emit("listening");
    if (server._starting !== startup) return true;
    server._starting = null;
    if (!server.listening) return true;
    server._accepting = options.accept();
    server._accepting.ref = server._referenced !== false;
    return true;
  }
  function start(server: Server, options: Options): void {
    const startup: Startup = {
      ref: server._referenced !== false,
      phase: "binding",
      step: () => step(server, options, startup),
    };
    server._starting = startup;
    options.addWaiter(startup);
  }
  return { start };
})
