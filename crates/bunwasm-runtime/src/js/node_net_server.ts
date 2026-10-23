(function () {
  function invalid(name: string, expected: string): never {
    throw Object.assign(new TypeError(`The "${name}" argument must be ${expected}`), { code: "ERR_INVALID_ARG_TYPE" });
  }
  function options(value: unknown) {
    if (value != null && typeof value !== "object") invalid("options", "an object or a function");
    const copy: Record<string, unknown> = { ...value };
    const delay = copy.keepAliveInitialDelay;
    if (delay !== undefined && typeof delay !== "number") invalid("options.keepAliveInitialDelay", "a number");
    return Object.assign(copy, {
      allowHalfOpen: copy.allowHalfOpen === undefined ? false : copy.allowHalfOpen,
      pauseOnConnect: Boolean(copy.pauseOnConnect), keepAlive: Boolean(copy.keepAlive),
      keepAliveInitialDelay: typeof delay === "number" ? Math.max(0, delay | 0) : 0,
      highWaterMark: copy.highWaterMark === undefined ? 65536 : copy.highWaterMark,
      noDelay: Boolean(copy.noDelay),
    });
  }
  function callable(implementation: Function, initialize: Function) {
    const Server = new Proxy(implementation, {
      apply(target, receiver, args) {
        if (!(receiver instanceof target)) return Reflect.construct(target, args);
        Reflect.apply(Object.getPrototypeOf(target), receiver, []);
        return Reflect.apply(initialize, receiver, args);
      },
    });
    Object.defineProperty(Server, "length", { value: 2, configurable: true });
    Object.defineProperty(Server.prototype, "constructor", { value: Server, writable: true, configurable: true });
    return Server;
  }
  return { options, callable };
})
