(function () {
  "use strict";
  function error<T extends Error>(Ctor: new(message: string) => T, code: string, message: string): T & { code: string } {
    return Object.assign(new Ctor(message), { code });
  }
  function port(value: unknown = 0): number {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "") || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 65535) {
      throw error(RangeError, "ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${String(value)}.`);
    }
    return Number(value);
  }
  function httpPort(value: unknown): number {
    if (value != null && typeof value !== "number" && typeof value !== "string") throw error(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'options.port' must be a number or string");
    return port(value ?? 0);
  }
  return { error, port, httpPort } satisfies BunWasm.NetPort;
})
