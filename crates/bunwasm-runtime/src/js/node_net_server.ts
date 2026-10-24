(function (internal: {
  builtin(name: "node:stream"): { getDefaultHighWaterMark(): number };
  require(name: "net_address"): { BlockList: { isBlockList(value: unknown): boolean } };
}) {
  const { getDefaultHighWaterMark } = internal.builtin("node:stream");
  const { BlockList } = internal.require("net_address");
  type Receiver = { on(event: "connection", listener: unknown): unknown };
  type Constructor = new (...args: unknown[]) => Receiver;

  function invalid(name: string, expected: string): never {
    throw Object.assign(new TypeError(`The "${name}" argument must be ${expected}`), { code: "ERR_INVALID_ARG_TYPE" });
  }
  function options(value: unknown) {
    if (value != null && typeof value !== "object") invalid("options", "an object or a function");
    const copy: Record<string, unknown> = { ...value };
    const highWaterMark = copy.highWaterMark === undefined ? getDefaultHighWaterMark() : copy.highWaterMark;
    const delay = copy.keepAliveInitialDelay;
    if (delay !== undefined && typeof delay !== "number") invalid("options.keepAliveInitialDelay", "a number");
    if (copy.blockList && !BlockList.isBlockList(copy.blockList)) invalid("options.blockList", "a net.BlockList");
    return Object.assign(copy, {
      allowHalfOpen: copy.allowHalfOpen === undefined ? false : copy.allowHalfOpen,
      pauseOnConnect: Boolean(copy.pauseOnConnect), keepAlive: Boolean(copy.keepAlive),
      keepAliveInitialDelay: typeof delay === "number" ? Math.max(0, delay | 0) : 0,
      highWaterMark, noDelay: Boolean(copy.noDelay),
    });
  }
  function initialize(receiver: Receiver, value?: unknown, listener?: unknown) {
    if (typeof value === "function") { listener = value; value = undefined; }
    const normalized = options(value);
    const server = Object.assign(receiver, {
      _options: normalized,
      allowHalfOpen: normalized.allowHalfOpen, pauseOnConnect: normalized.pauseOnConnect,
      keepAlive: normalized.keepAlive, keepAliveInitialDelay: normalized.keepAliveInitialDelay,
      highWaterMark: normalized.highWaterMark, noDelay: normalized.noDelay,
      _referenced: true, listening: false, _connections: new Set<unknown>(),
    });
    if (normalized.blockList) Object.assign(server, { blockList: normalized.blockList });
    if (typeof listener === "function") server.on("connection", listener);
    return server;
  }
  function callable(implementation: Constructor) {
    const Server = new Proxy(implementation, {
      apply(target, receiver: unknown, args: unknown[]) {
        if (!(receiver instanceof target)) return Reflect.construct(target, args);
        Reflect.apply(Object.getPrototypeOf(target), receiver, []);
        return initialize(receiver, args[0], args[1]);
      },
    });
    Object.defineProperty(Server, "length", { value: 2, configurable: true });
    Object.defineProperty(Server.prototype, "constructor", { value: Server, writable: true, configurable: true });
    return Server;
  }
  return { initialize, callable };
})
