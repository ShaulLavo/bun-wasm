(function (internal: Pick<BunWasm.Internal, "require">) {
  const { isIPv6 } = internal.require("net_address");
  const encoder = new TextEncoder();
  function missing(hostname: string): never {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname });
  }
  return function hostname(value: string): string {
    if (typeof value !== "string") throw Object.assign(new TypeError("hostname must be a string"), { code: "ERR_INVALID_ARG_TYPE" });
    const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    if (isIPv6(bare)) return bare;
    if (/[\s\[\]:/]/.test(value)) missing(value);
    const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
    if (labels.some(label => label.length === 0 || encoder.encode(label).length > 63)) missing(value);
    return value;
  };
})
