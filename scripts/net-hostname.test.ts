import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const netSource = readFileSync(new URL("net.js", runtime), "utf8");
const context = { TextEncoder, Error, TypeError };
const address = runInNewContext(readFileSync(new URL("net_address.js", runtime), "utf8"), context)();
const hostnameSource = readFileSync(new URL("net_hostname.ts", runtime), "utf8");
const hostnameFactory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${hostnameSource}`), context);
const hostname: (value: unknown, allowBrackets?: boolean) => string = hostnameFactory({
  require(name: string) {
    if (name === "net_address") return address;
    throw new Error(`Unexpected module ${name}`);
  },
});
const internal = {
  require(name: string) {
    if (name === "net_hostname") return hostname;
    throw new Error(`Unexpected module ${name}`);
  },
};

function sourceBetween(start: string, end: string): string {
  const first = netSource.indexOf(start);
  const last = netSource.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`Missing source boundary ${start}`);
  return netSource.slice(first, last);
}

const hostErrorSource = sourceBetween("  function hostError(", "\n  // --- fetch");
const listenSource = sourceBetween("  function listenOrThrow(", "\n  // Accept connections");
// Evaluate only the data wrapper. Never load net.js's event loop or call Bun networking APIs.
const wrapperFactory = runInNewContext(`(function (internal, native) {
  ${hostErrorSource}
  ${listenSource}
  return listenOrThrow;
})`, context);
const servePrefix = sourceBetween("  function serve(", "    const requested =");
const serveExpression = servePrefix.match(/^    const hostname = (.+);$/m)?.[1];
if (!serveExpression) throw new Error("Missing Bun.serve hostname expression");
const serveHostname: (runtimeInternal: typeof internal, options: { hostname?: unknown }) => string = runInNewContext(
  `(function (internal, options) { return ${serveExpression}; })`, context,
);

interface HostErrorRecord { name: string; message: string; code: string; syscall: string }
function wrapperFixture(result = 7, error: HostErrorRecord = {
  name: "Error", message: "synthetic host failure", code: "ENOTFOUND", syscall: "getaddrinfo",
}) {
  const calls: { hostname: string; port: number }[] = [];
  const errorHandles: number[] = [];
  const native = {
    hostListen(value: string, port: number) { calls.push({ hostname: value, port }); return result; },
    hostError(handle: number) { errorHandles.push(handle); return JSON.stringify(error); },
  };
  const validate: (value: unknown, port: number) => number = wrapperFactory(internal, native);
  return { validate, calls, errorHandles };
}

function thrownBy(callback: () => unknown): unknown {
  try { callback(); } catch (error) { return error; }
  throw new Error("Expected a synthetic error");
}

const invalidNames = [
  "", ".", "..", "fixture..invalid", ".fixture.invalid", "fixture.invalid..",
  "has space", " leading", "trailing\t", "line\nbreak", "fixture\u00a0invalid",
  "fixture/path", "fixture:1234", "[::1]", "[::1", "::1]", "[fixture.invalid]",
  "[127.0.0.1]", "[not:ipv6]", "1:2:3", "a".repeat(64), "é".repeat(32),
];

test("hostname syntax preserves names, legacy IPv4 spellings and bare IPv6", () => {
  for (const value of ["fixture.invalid", "fixture.invalid.", "localhost", "127.1", "0x7f000001", "127.0.0.1", "::1", "2001:db8::1", "fe80::1%zone", "a".repeat(63), "é".repeat(31) + "a"]) {
    expect(hostname(value)).toBe(value);
  }
});

test("invalid hostname errors retain the exact input and getaddrinfo metadata", () => {
  for (const value of invalidNames) {
    const error = thrownBy(() => hostname(value));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "Error", message: `getaddrinfo ENOTFOUND ${value}`,
      code: "ENOTFOUND", syscall: "getaddrinfo", hostname: value,
    });
  }
});

test("only bracket opt-in unwraps valid IPv6 and rejects other bracketed input", () => {
  for (const value of ["::1", "2001:db8::1", "fe80::1%zone"]) {
    expect(hostname(`[${value}]`, true)).toBe(value);
    expect(thrownBy(() => hostname(`[${value}]`))).toMatchObject({ hostname: `[${value}]`, code: "ENOTFOUND" });
  }
  for (const value of ["[127.0.0.1]", "[fixture.invalid]", "[not:ipv6]", "[[::1]]", "[::1", "::1]"]) {
    expect(thrownBy(() => hostname(value, true))).toMatchObject({ hostname: value, code: "ENOTFOUND" });
  }
});

test("hostname type checks do not coerce non-string inputs", () => {
  let coerced = false;
  const object = { toString() { coerced = true; return "fixture.invalid"; } };
  for (const value of [undefined, null, false, true, 0, 1, 1n, Symbol("hostname"), object, ["fixture.invalid"]]) {
    const error = thrownBy(() => hostname(value));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "hostname must be a string", code: "ERR_INVALID_ARG_TYPE" });
  }
  expect(coerced).toBe(false);
});

test("the isolated wrapper rejects invalid input before reaching either record stub", () => {
  const state = wrapperFixture();
  for (const value of invalidNames.concat(["bad host"])) {
    expect(thrownBy(() => state.validate(value, 1234))).toMatchObject({ code: "ENOTFOUND", hostname: value });
  }
  expect(thrownBy(() => state.validate({ hostname: "fixture.invalid" }, 1234))).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  expect(state.calls).toEqual([]);
  expect(state.errorHandles).toEqual([]);
});

test("the isolated wrapper forwards valid data and returns the synthetic result", () => {
  const state = wrapperFixture(17);
  expect(state.validate("fixture.invalid.", 1234)).toBe(17);
  expect(state.calls).toEqual([{ hostname: "fixture.invalid.", port: 1234 }]);
  expect(state.errorHandles).toEqual([]);
});

test("ENOTFOUND copies hostname without replacing host error metadata", () => {
  const record = { name: "SyntheticError", message: "synthetic resolver record", code: "ENOTFOUND", syscall: "synthetic_lookup" };
  const state = wrapperFixture(-1, record);
  const error = thrownBy(() => state.validate("fixture.invalid.", 4321));
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ ...record, hostname: "fixture.invalid." });
  expect(state.calls).toEqual([{ hostname: "fixture.invalid.", port: 4321 }]);
  expect(state.errorHandles).toEqual([0]);
});

test("non-ENOTFOUND errors do not gain hostname and retain existing listen diagnostics", () => {
  const record = { name: "TypeError", message: "synthetic failure", code: "EACCES", syscall: "synthetic_bind" };
  const denied = wrapperFixture(-1, record);
  const error = thrownBy(() => denied.validate("fixture.invalid", 1234));
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject(record);
  expect(error).not.toHaveProperty("hostname");
  const occupied = wrapperFixture(-1, { ...record, name: "Error", code: "EADDRINUSE" });
  expect(thrownBy(() => occupied.validate("fixture.invalid", 1234))).toMatchObject({
    message: "Failed to start server. Is port 1234 in use?", code: "EADDRINUSE", syscall: "listen",
  });
});

test("Bun.serve's isolated hostname expression keeps defaulting and bracket normalization paired", () => {
  for (const value of [undefined, null, "", false, 0]) {
    expect(serveHostname(internal, { hostname: value })).toBe("0.0.0.0");
  }
  expect(serveHostname(internal, {})).toBe("0.0.0.0");
  expect(serveHostname(internal, { hostname: "[::1]" })).toBe("::1");
  expect(serveHostname(internal, { hostname: "[2001:db8::1]" })).toBe("2001:db8::1");
  expect(serveHostname(internal, { hostname: "fixture.invalid." })).toBe("fixture.invalid.");
  expect(thrownBy(() => serveHostname(internal, { hostname: "[fixture.invalid]" }))).toMatchObject({ code: "ENOTFOUND", hostname: "[fixture.invalid]" });
  expect(thrownBy(() => serveHostname(internal, { hostname: true }))).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
});
