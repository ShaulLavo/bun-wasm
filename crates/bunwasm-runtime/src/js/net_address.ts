// IP predicates adapted from Bun src/js/internal/net/isIP.ts. See docs/bun-patches.md.
type NetAddressInternal = {
  require(name: "net_port"): BunWasm.NetPort;
};
(function (internal: NetAddressInternal) {
  "use strict";
type Family = 4 | 6;
type AddressFamily = "ipv4" | "ipv6";
type BlockEntry = {
  family: Family;
  start: bigint;
  end: bigint;
  rule: string;
};
type SocketAddressOptions = {
  address?: string;
  family?: unknown;
  flowlabel?: unknown;
  port?: unknown;
};
type SocketAddressValue = {
  address: string;
  port: number;
  family: AddressFamily;
  flowlabel: number;
};
const v4Seg = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
var IPv4Reg: RegExp | undefined;

const v6Seg = "(?:[0-9a-fA-F]{1,4})";
var IPv6Reg: RegExp | undefined;

function isIPv4(s: string): boolean {
  return (IPv4Reg ??= new RegExp(`^${v4Str}$`)).test(s);
}

function isIPv6(s: string): boolean {
  return (IPv6Reg ??= new RegExp(
    "^(?:" +
      `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
      `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
      `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
      `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
      `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
      `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
      `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
      `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
      ")(?:%[0-9a-zA-Z-.:]{1,})?$",
  )).test(s);
}

function isIP(s: string): 0 | Family {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}


  const { error, port } = internal.require("net_port");
  function ipNumber(address: unknown, family: Family): bigint {
    if (typeof address !== "string" || isIP(address) !== family) throw error(TypeError, "ERR_INVALID_ADDRESS", `Invalid IP address: ${String(address)}`);
    if (family === 4) return address.split(".").reduce((value, part) => (value << 8n) | BigInt(part), 0n);
    let text = address.split("%")[0];
    if (text.includes(".")) {
      const start = text.lastIndexOf(":") + 1;
      const v4 = ipNumber(text.slice(start), 4);
      text = text.slice(0, start) + (v4 >> 16n).toString(16) + ":" + (v4 & 65535n).toString(16);
    }
    const halves = text.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2 ? left.concat(Array<string>(8 - left.length - right.length).fill("0"), right) : left;
    return groups.reduce((value, part) => (value << 16n) | BigInt("0x" + part), 0n);
  }
  function familyNumber(type: unknown = "ipv4"): Family {
    if (typeof type !== "string" || !/^ipv[46]$/i.test(type)) throw error(TypeError, "ERR_INVALID_ARG_VALUE", `Invalid address family: ${String(type)}`);
    return type.toLowerCase() === "ipv6" ? 6 : 4;
  }
  function blockNumber(address: unknown, family: Family): bigint {
    const value = ipNumber(address, family);
    return family === 4 ? 0xffff00000000n | value : value;
  }
  class BlockList {
    #entries: BlockEntry[] = [];
    get rules(): string[] { return this.#entries.map(entry => entry.rule).reverse(); }
    addAddress(address: string, type: unknown = "ipv4"): void {
      const family = familyNumber(type);
      const start = blockNumber(address, family);
      this.#entries.push({ family, start, end: start, rule: `Address: IPv${family} ${address}` });
    }
    addRange(start: string, end: string, type: unknown = "ipv4"): void {
      const family = familyNumber(type);
      const first = blockNumber(start, family);
      const last = blockNumber(end, family);
      if (first > last) throw error(TypeError, "ERR_INVALID_ARG_VALUE", "start must come before end");
      this.#entries.push({ family, start: first, end: last, rule: `Range: IPv${family} ${start}-${end}` });
    }
    addSubnet(network: string, prefix: number, type: unknown = "ipv4"): void {
      const family = familyNumber(type);
      const bits = family === 4 ? 32 : 128;
      const value = blockNumber(network, family);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw error(RangeError, "ERR_OUT_OF_RANGE", "Invalid subnet prefix");
      const shift = BigInt(bits - prefix);
      const start = (value >> shift) << shift;
      this.#entries.push({ family, start, end: start + (1n << shift) - 1n, rule: `Subnet: IPv${family} ${network}/${prefix}` });
    }
    check(address: string, type: unknown = "ipv4"): boolean {
      const family = familyNumber(type);
      if (isIP(address) !== family) return false;
      const value = blockNumber(address, family);
      return this.#entries.some(entry => value >= entry.start && value <= entry.end);
    }
    static isBlockList(value: unknown): value is BlockList { return value instanceof BlockList; }
  }
  class SocketAddress {
    #value: SocketAddressValue;
    constructor(options: SocketAddressOptions = {}) {
      const family = familyNumber(options.family);
      const address = options.address === undefined ? (family === 4 ? "127.0.0.1" : "::") : options.address;
      ipNumber(address, family);
      const flowlabel = family === 4 ? 0 : Number(options.flowlabel || 0);
      if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) throw error(RangeError, "ERR_OUT_OF_RANGE", "Invalid flowlabel");
      this.#value = { address: family === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address, port: port(options.port), family: `ipv${family}`, flowlabel };
    }
    get address(): string { return this.#value.address; }
    get port(): number { return this.#value.port; }
    get family(): AddressFamily { return this.#value.family; }
    get flowlabel(): number { return this.#value.flowlabel; }
    toJSON(): SocketAddressValue { return Object.assign({}, this.#value); }
    static isSocketAddress(value: unknown): value is SocketAddress { return typeof value === "object" && value !== null && #value in value && Object.getPrototypeOf(value) === SocketAddress.prototype; }
    static parse(input: unknown): SocketAddress | undefined {
      if (typeof input !== "string" || !input || /[\s/@?#]/.test(input)) return undefined;
      try {
        const url = new URL(`http://${input}`);
        const address = url.hostname.replace(/^\[|\]$/g, "");
        if (!isIP(address)) return undefined;
        return new SocketAddress({ address, port: /:(\d+)$/.test(input) ? Number(input.match(/:(\d+)$/)![1]) : 0, family: `ipv${isIP(address)}` });
      } catch { return undefined; }
    }
  }
  const normalized = Symbol("normalizedArgs");
  type NormalizeCallback = ((...args: unknown[]) => unknown) & { [normalized]?: boolean };
  type NormalizeOptions = { host?: unknown; path?: unknown; port?: unknown; [normalized]?: boolean };
  type NormalizedArgs = [NormalizeOptions, NormalizeCallback | null] & { host?: unknown; [normalized]?: boolean };
  type NormalizePrimitive = (string | number | boolean | bigint | symbol | null | undefined) & { [normalized]?: boolean };
  type NormalizeValue = NormalizeOptions | NormalizeCallback | NormalizedArgs | NormalizePrimitive;
  type NormalizeInput = NormalizeValue[] & { [normalized]?: boolean };
  function _normalizeArgs(args: NormalizeInput): NormalizeInput | NormalizeValue {
    if (args[normalized]) return args;
    if (args[0]?.[normalized]) return args[0];
    let options = args[0];
    if (options === undefined || typeof options === "function") options = {};
    else if (options === null || typeof options !== "object") {
      options = typeof options === "string" && Number.isNaN(Number(options)) ? { path: options } : { port: options };
      if (typeof args[1] === "string") options.host = args[1];
    }
    const result: NormalizedArgs = [options, typeof args[args.length - 1] === "function" ? args[args.length - 1] as NormalizeCallback : null];
    result[normalized] = true;
    return result;
  }
  let autoSelectFamily = true;
  let autoSelectFamilyAttemptTimeout = 500;
  function setDefaultAutoSelectFamily(value: unknown): void {
    if (typeof value !== "boolean") throw error(TypeError, "ERR_INVALID_ARG_TYPE", "value must be a boolean");
    autoSelectFamily = value;
  }
  function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw error(RangeError, "ERR_OUT_OF_RANGE", "Invalid timeout");
    autoSelectFamilyAttemptTimeout = Math.max(10, value);
  }
  return { isIP, isIPv4, isIPv6, BlockList, SocketAddress, _normalizeArgs, port, error,
    getDefaultAutoSelectFamily: () => autoSelectFamily, setDefaultAutoSelectFamily,
    getDefaultAutoSelectFamilyAttemptTimeout: () => autoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout };
})
