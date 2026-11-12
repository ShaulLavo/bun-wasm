import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { netAddressSource } from "./net-address-source";

type Family = 4 | 6;
type AddressFamily = "ipv4" | "ipv6";
type ErrorWithCode = Error & { code: string };
type PortModule = {
  error<T extends Error>(Ctor: new(message: string) => T, code: string, message: string): T & { code: string };
  port(value?: unknown): number;
};
type SocketAddressOptions = { address?: string; family?: unknown; flowlabel?: unknown; port?: unknown };
type SocketAddressValue = { address: string; port: number; family: AddressFamily; flowlabel: number };
type BlockList = {
  readonly rules: string[];
  addAddress(address: string, type?: unknown): void;
  addRange(start: string, end: string, type?: unknown): void;
  addSubnet(network: string, prefix: number, type?: unknown): void;
  check(address: string, type?: unknown): boolean;
};
type SocketAddress = SocketAddressValue & { toJSON(): SocketAddressValue };
type AddressModule = {
  isIP(value: string): 0 | Family;
  isIPv4(value: string): boolean;
  isIPv6(value: string): boolean;
  BlockList: { new(): BlockList; isBlockList(value: unknown): value is BlockList };
  SocketAddress: {
    new(options?: SocketAddressOptions): SocketAddress;
    isSocketAddress(value: unknown): value is SocketAddress;
    parse(input: unknown): SocketAddress | undefined;
  };
  _normalizeArgs(args: unknown[]): unknown[];
  isTcpListenOptions(value: { path?: unknown; port?: unknown }): boolean;
  port(value?: unknown): number;
  error<T extends Error>(Ctor: new(message: string) => T, code: string, message: string): T & { code: string };
  getDefaultAutoSelectFamily(): boolean;
  setDefaultAutoSelectFamily(value: unknown): void;
  getDefaultAutoSelectFamilyAttemptTimeout(): number;
  setDefaultAutoSelectFamilyAttemptTimeout(value: unknown): void;
};

const portSource = await Bun.file(new URL("../crates/bunwasm-runtime/src/js/net_port.ts", import.meta.url)).text();
const ports: PortModule = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${portSource}`))();
const address: AddressModule = runInNewContext(netAddressSource(), { URL })({ require: () => ports });

function thrownBy(callback: () => unknown): unknown {
  try { callback(); } catch (error) { return error; }
  throw new Error("Expected an error");
}

function checkActualFactoryTypes() {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-net-address-types-"));
  try {
    const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
    const text = readFileSync(new URL("net_address.ts", runtime), "utf8").replace("(function (internal:", "const factory = (function (internal:");
    const probe = join(scratch, "type-probe.ts");
    writeFileSync(probe, `${text};
declare const ports: BunWasm.NetPort;
const address = factory({ require: () => ports });
address._normalizeArgs([undefined]);
address._normalizeArgs([null]);
address._normalizeArgs([3137, (error: Error | null) => {}]);
`);
    const config = join(scratch, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      extends: new URL("../crates/bunwasm-runtime/tsconfig.json", import.meta.url).pathname,
      include: [], files: [new URL("net_port_types.d.ts", runtime).pathname, probe],
    }));
    const result = Bun.spawnSync([join(import.meta.dir, "../node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the actual factory accepts nullish arguments and parameterized callbacks at compile time", () => {
  const result = checkActualFactoryTypes();
  expect(result.status, result.output).toBe(0);
});

test("IPv4 predicates accept only four uncompressed decimal segments", () => {
  for (const value of ["0.0.0.0", "127.0.0.1", "255.255.255.255"]) {
    expect(address.isIPv4(value)).toBe(true);
    expect(address.isIP(value)).toBe(4);
  }
  for (const value of ["", "127.1", "01.2.3.4", "256.0.0.1", "1.2.3.4.5", "::1"]) {
    expect(address.isIPv4(value)).toBe(false);
    expect(address.isIP(value)).not.toBe(4);
  }
});

test("IPv6 predicates cover compressed, embedded IPv4 and scoped addresses", () => {
  for (const value of ["::", "::1", "2001:db8::1", "::ffff:192.0.2.128", "fe80::1%zone", "fe80::1%eth0.1"]) {
    expect(address.isIPv6(value)).toBe(true);
    expect(address.isIP(value)).toBe(6);
  }
  for (const value of ["", "2001:db8:::1", "12345::", "::ffff:127.1", "127.0.0.1", "fe80::1%"]) {
    expect(address.isIPv6(value)).toBe(false);
    expect(address.isIP(value)).not.toBe(6);
  }
});

test("BlockList combines addresses, ranges and subnets with reverse-ordered rules", () => {
  const blocks = new address.BlockList();
  blocks.addAddress("127.0.0.1");
  blocks.addRange("192.0.2.10", "192.0.2.20");
  blocks.addSubnet("2001:db8::", 32, "ipv6");
  blocks.addAddress("fe80::1%zone", "IPv6");
  expect(blocks.check("127.0.0.1")).toBe(true);
  expect(blocks.check("127.0.0.2")).toBe(false);
  expect(blocks.check("192.0.2.15")).toBe(true);
  expect(blocks.check("2001:db8:ffff::1", "ipv6")).toBe(true);
  expect(blocks.check("2001:db9::1", "ipv6")).toBe(false);
  expect(blocks.check("fe80::1%other", "ipv6")).toBe(true);
  expect(blocks.check("::ffff:127.0.0.1", "ipv6")).toBe(true);
  expect(blocks.check("127.0.0.1", "ipv6")).toBe(false);
  expect(blocks.rules).toEqual([
    "Address: IPv6 fe80::1%zone",
    "Subnet: IPv6 2001:db8::/32",
    "Range: IPv4 192.0.2.10-192.0.2.20",
    "Address: IPv4 127.0.0.1",
  ]);
  expect(address.BlockList.isBlockList(blocks)).toBe(true);
  expect(address.BlockList.isBlockList({ rules: blocks.rules })).toBe(false);
});

test("BlockList reports invalid addresses, families, ranges and prefixes", () => {
  const blocks = new address.BlockList();
  expect(thrownBy(() => blocks.addAddress("127.1"))).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ADDRESS" });
  expect(thrownBy(() => blocks.addAddress("127.0.0.1", "ipv5"))).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_VALUE" });
  expect(thrownBy(() => blocks.addRange("192.0.2.20", "192.0.2.10"))).toMatchObject({ code: "ERR_INVALID_ARG_VALUE", message: "start must come before end" });
  for (const prefix of [-1, 33, 1.5]) {
    expect(thrownBy(() => blocks.addSubnet("127.0.0.1", prefix))).toMatchObject({ name: "RangeError", code: "ERR_OUT_OF_RANGE" });
  }
});

test("SocketAddress keeps defaults, normalizes IPv6 and copies JSON data", () => {
  const defaults = new address.SocketAddress();
  expect(defaults.toJSON()).toEqual({ address: "127.0.0.1", port: 0, family: "ipv4", flowlabel: 0 });
  const ipv6 = new address.SocketAddress({ address: "2001:0db8::1", family: "ipv6", port: "3137", flowlabel: 42 });
  expect(ipv6.address).toBe("2001:db8::1");
  expect(ipv6.port).toBe(3137);
  expect(ipv6.family).toBe("ipv6");
  expect(ipv6.flowlabel).toBe(42);
  const json = ipv6.toJSON();
  expect(json).toEqual({ address: "2001:db8::1", port: 3137, family: "ipv6", flowlabel: 42 });
  expect(json).not.toBe(ipv6);
  expect(address.SocketAddress.isSocketAddress(ipv6)).toBe(true);
  expect(address.SocketAddress.isSocketAddress(json)).toBe(false);
});

test("SocketAddress.parse handles IPv4, bracketed IPv6 and invalid input", () => {
  expect(address.SocketAddress.parse("127.0.0.1:8080")?.toJSON()).toEqual({ address: "127.0.0.1", port: 8080, family: "ipv4", flowlabel: 0 });
  expect(address.SocketAddress.parse("[2001:db8::1]:443")?.toJSON()).toEqual({ address: "2001:db8::1", port: 443, family: "ipv6", flowlabel: 0 });
  expect(address.SocketAddress.parse("[::1]")?.toJSON()).toEqual({ address: "::1", port: 0, family: "ipv6", flowlabel: 0 });
  for (const value of [undefined, null, {}, "", "host.invalid", "127.0.0.1:65536", "::1", "[::1", "/127.0.0.1"]) {
    expect(address.SocketAddress.parse(value)).toBeUndefined();
  }
});

test("SocketAddress rejects invalid addresses, ports and flow labels", () => {
  expect(thrownBy(() => new address.SocketAddress({ address: "127.1" }))).toMatchObject({ code: "ERR_INVALID_ADDRESS" });
  expect(thrownBy(() => new address.SocketAddress({ port: 65536 }))).toMatchObject({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" });
  expect(thrownBy(() => new address.SocketAddress({ family: "ipv6", flowlabel: 0x100000 }))).toMatchObject({ name: "RangeError", code: "ERR_OUT_OF_RANGE" });
});

test("listen overload selection keeps port presence ahead of a false socket path", () => {
  expect(address.isTcpListenOptions({})).toBe(true);
  expect(address.isTcpListenOptions({ path: "/tmp/bun.sock" })).toBe(false);
  expect(address.isTcpListenOptions({ path: false, port: "3137" })).toBe(true);
  expect(address.isTcpListenOptions({ path: "/tmp/bun.sock", port: undefined })).toBe(true);
  expect(address.isTcpListenOptions({ path: "/tmp/bun.sock", port: false })).toBe(false);
  expect(address.isTcpListenOptions({ path: undefined })).toBe(true);
});

test("argument normalization preserves socket paths, ports, hosts and callbacks", () => {
  const callback = () => undefined;
  const normalized = address._normalizeArgs([3137, "127.0.0.1", callback]);
  expect(normalized[0]).toEqual({ port: 3137, host: "127.0.0.1" });
  expect(normalized[1]).toBe(callback);
  expect(address._normalizeArgs([normalized])).toBe(normalized);
  expect(address._normalizeArgs(["/tmp/bun.sock", callback])[0]).toEqual({ path: "/tmp/bun.sock" });
  expect(address._normalizeArgs([undefined])[0]).toEqual({});
});

test("port validation and auto-family defaults retain their error contracts", () => {
  for (const value of [0, 65535, "3137", undefined]) expect(address.port(value)).toBe(Number(value ?? 0));
  for (const value of [-1, 65536, 1.5, "", {}, true]) {
    expect(thrownBy(() => address.port(value))).toMatchObject({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" });
  }
  expect(address.getDefaultAutoSelectFamily()).toBe(true);
  expect(address.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(500);
  address.setDefaultAutoSelectFamily(false);
  address.setDefaultAutoSelectFamilyAttemptTimeout(1);
  expect(address.getDefaultAutoSelectFamily()).toBe(false);
  expect(address.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(10);
  expect(thrownBy(() => address.setDefaultAutoSelectFamily("false"))).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  for (const value of [0, -1, 1.5, 2147483648]) {
    expect(thrownBy(() => address.setDefaultAutoSelectFamilyAttemptTimeout(value))).toMatchObject({ name: "RangeError", code: "ERR_OUT_OF_RANGE" });
  }
  address.setDefaultAutoSelectFamily(true);
  address.setDefaultAutoSelectFamilyAttemptTimeout(500);
});

test("the shared error helper preserves the constructor and code", () => {
  const failure: ErrorWithCode = address.error(TypeError, "ERR_TEST", "invalid argument");
  expect(failure).toBeInstanceOf(TypeError);
  expect(failure.message).toBe("invalid argument");
  expect(failure.code).toBe("ERR_TEST");
});
