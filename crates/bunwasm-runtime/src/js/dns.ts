// Bun-owned node:dns facade over the runtime-owned host lookup capability.
// The host owns address policy; this module owns Node/Bun overloads and errors.
(function (internal: BunWasm.Internal) {
  "use strict";

  type Family = 0 | 4 | 6;
  type AddressFamily = 4 | 6;
  type LookupResult = { address: string; family: AddressFamily };
  type LookupValue = LookupResult | { address: null; family: 4 };
  type LookupOptions = { family: Family; hints: number; all: boolean; order: ResultOrder };
  type ResultOrder = "ipv4first" | "ipv6first" | "verbatim";
  type LookupCallback = (error: unknown, address?: string | null | LookupResult[], family?: AddressFamily | undefined) => void;

  const NO_NETWORK = "WASI has no network access";
  const DNS_ALL = 16;
  const DNS_ADDRCONFIG = 32;
  const DNS_V4MAPPED = 8;
  let defaultResultOrder: ResultOrder = "verbatim";
  let moduleInstance: Record<string, unknown> | undefined;
  let promisesInstance: Record<string, unknown> | undefined;
  let bunInstance: Record<string, unknown> | undefined;

  function nodeError<T extends Error>(error: T, code: string): T {
    return Object.assign(error, { code });
  }

  function unsupportedError(what: string): Error {
    return nodeError(new Error(`${what} is not supported in bun-wasm: ${NO_NETWORK}`), "ERR_NOT_SUPPORTED_IN_WASM");
  }

  function unsupportedModule(name: string, keys: readonly string[]): Record<string, unknown> {
    const module: Record<string, unknown> = {};
    for (const key of keys) module[key] = () => { throw unsupportedError(`${name}.${key}`); };
    return module;
  }

  function invalidArgType(name: string, expected: string, value: unknown): TypeError {
    return nodeError(new TypeError(`The "${name}" argument must be of type ${expected}. Received ${internal.describe(value)}`), "ERR_INVALID_ARG_TYPE");
  }

  function invalidArgValue(name: string, value: unknown, message: string): TypeError {
    return nodeError(new TypeError(`The property '${name}' ${message}. Received ${internal.describe(value)}`), "ERR_INVALID_ARG_VALUE");
  }

  function isLookupCallback(value: unknown): value is LookupCallback {
    return typeof value === "function";
  }

  function validateHostname(hostname: unknown): asserts hostname is string {
    if (typeof hostname === "string" || !hostname) return;
    throw invalidArgType("hostname", "string", hostname);
  }

  function validateFamily(family: unknown): asserts family is Family {
    if (family === 0 || family === 4 || family === 6) return;
    throw invalidArgValue("family", family, "must be one of 0, 4 or 6");
  }

  function validateOrder(order: unknown): asserts order is ResultOrder {
    if (order === "ipv4first" || order === "ipv6first" || order === "verbatim") return;
    throw invalidArgValue("order", order, "is invalid");
  }

  function validateOptions(options: unknown): LookupOptions {
    const normalized = options == null ? {} : options;
    if (typeof normalized !== "object") throw invalidArgType("options", "object or integer", normalized);
    let family = Reflect.get(normalized, "family") ?? 0;
    if (family === "IPv4") family = 4;
    if (family === "IPv6") family = 6;
    validateFamily(family);
    const hints = Reflect.get(normalized, "hints") ?? 0;
    if (typeof hints !== "number" || !Number.isFinite(hints)) throw invalidArgType("options.hints", "number", hints);
    if ((hints & (DNS_ALL | DNS_ADDRCONFIG | DNS_V4MAPPED)) !== hints) throw invalidArgValue("hints", hints, "is invalid");
    const all = Reflect.get(normalized, "all") ?? false;
    if (typeof all !== "boolean") throw invalidArgType("options.all", "boolean", all);
    const verbatim = Reflect.get(normalized, "verbatim");
    if (verbatim !== undefined && verbatim !== null && typeof verbatim !== "boolean") {
      throw invalidArgType("options.verbatim", "boolean", verbatim);
    }
    let order = Reflect.get(normalized, "order");
    if (order === undefined && verbatim !== undefined && verbatim !== null) order = verbatim ? "verbatim" : "ipv4first";
    order ??= defaultResultOrder;
    validateOrder(order);
    return { family, hints, all, order };
  }

  function normalizePromiseOptions(options: unknown): unknown {
    if (typeof options === "number") {
      validateFamily(options);
      return { family: options };
    }
    if (options !== undefined && options !== null && typeof options !== "object") {
      throw invalidArgType("options", "object or integer", options);
    }
    return options;
  }

  function lookupError(error: unknown, hostname: string): unknown {
    if (!error || typeof error !== "object") return error;
    const syscall = Reflect.get(error, "syscall");
    const errorHostname = Reflect.get(error, "hostname");
    if (syscall === "getaddrinfo" && hostname && !errorHostname) {
      Object.assign(error, { hostname, message: `${syscall} ${Reflect.get(error, "code") ?? ""} ${hostname}`.trim() });
    }
    return error;
  }

  function sortResults(results: LookupResult[], order: ResultOrder): LookupResult[] {
    if (order === "ipv4first") results.sort((a, b) => a.family - b.family);
    if (order === "ipv6first") results.sort((a, b) => b.family - a.family);
    return results;
  }

  function bunLookup(hostname: string, options: { family?: Family; flags?: number } = {}): Promise<LookupResult[]> {
    const lookup = internal.native.hostLookup;
    if (typeof lookup !== "function") return Promise.reject(unsupportedError("Bun.dns.lookup"));
    const family = options.family ?? 0;
    const hints = options.flags ?? 0;
    return Promise.resolve().then(() => lookup(hostname, family, hints));
  }

  function rawLookup(hostname: string, options: LookupOptions): Promise<LookupResult[]> {
    return bunLookup(hostname, { family: options.family, flags: options.hints });
  }

  function lookupResult(hostname: string, options: LookupOptions): Promise<LookupValue | null | LookupResult[]> {
    if (!hostname) return Promise.resolve(options.all ? [] : { address: null, family: 4 });
    const family = internal.require("net_address").isIP(hostname);
    if (family) {
      const result = { address: hostname, family };
      return Promise.resolve(options.all ? [result] : result);
    }
    return rawLookup(hostname, options).then(results => {
      const sorted = sortResults(results, options.order);
      if (sorted.length === 0) {
        const error = Object.assign(new Error("No records found"), { name: "DNSException", code: "ENODATA", syscall: "getaddrinfo" });
        throw error;
      }
      return options.all ? sorted : sorted[0];
    }).catch(error => { throw lookupError(error, hostname); });
  }

  function callbackLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    lookupResult(hostname, options).then(result => {
      internal.nextTick(() => {
        if (options.all) return callback(null, Array.isArray(result) ? result : []);
        if (Array.isArray(result)) return callback(null, result[0]?.address, result[0]?.family);
        if (result === null || result.address === null) return callback(null, null, 4);
        callback(null, result.address, result.family);
      });
    }, error => internal.nextTick(callback, error, undefined, undefined));
  }

  function lookup(hostname: unknown, options?: unknown, callback?: unknown): void {
    validateHostname(hostname);
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    } else if (typeof options === "number") {
      if (!isLookupCallback(callback)) throw invalidArgType("callback", "function", callback);
      validateFamily(options);
      options = { family: options };
    } else if (options !== undefined && options !== null && typeof options !== "object") {
      if (!isLookupCallback(callback)) throw invalidArgType("callback", "function", callback ?? options);
      throw invalidArgType("options", "object or integer", options);
    }
    if (!isLookupCallback(callback)) throw invalidArgType("callback", "function", callback);
    callbackLookup(hostname, validateOptions(options), callback);
  }

  function promises(): Record<string, unknown> {
    if (promisesInstance) return promisesInstance;
    promisesInstance = Object.assign({
      lookup(hostname: unknown, options?: unknown) {
        validateHostname(hostname);
        return lookupResult(hostname, validateOptions(normalizePromiseOptions(options)));
      },
      getDefaultResultOrder: () => defaultResultOrder,
      setDefaultResultOrder(order: unknown) {
        validateOrder(order);
        defaultResultOrder = order;
      },
    }, unsupportedModule("dns.promises", ["resolve", "resolve4", "resolve6", "reverse", "Resolver", "lookupService"]));
    return promisesInstance;
  }

  function module(): Record<string, unknown> {
    if (moduleInstance) return moduleInstance;
    moduleInstance = Object.assign({
      lookup,
      promises: promises(),
      getDefaultResultOrder: () => defaultResultOrder,
      setDefaultResultOrder(order: unknown) {
        validateOrder(order);
        defaultResultOrder = order;
      },
      getServers: () => [],
      setServers() {},
      ALL: DNS_ALL,
      ADDRCONFIG: DNS_ADDRCONFIG,
      V4MAPPED: DNS_V4MAPPED,
    }, unsupportedModule("dns", ["resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt", "resolveSrv", "resolveNs", "resolveCname", "reverse", "lookupService", "Resolver"]));
    return moduleInstance;
  }

  function bun(): Record<string, unknown> {
    if (bunInstance) return bunInstance;
    bunInstance = { lookup: bunLookup, ALL: DNS_ALL, ADDRCONFIG: DNS_ADDRCONFIG, V4MAPPED: DNS_V4MAPPED, getServers: () => [], setServers() {} };
    return bunInstance;
  }

  return { module, promises, bun };
})
