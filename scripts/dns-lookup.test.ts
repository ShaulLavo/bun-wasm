import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/dns.ts", import.meta.url), "utf8");
const calls: { hostname: string; family: number; hints: number }[] = [];
const context = {
  Array, Error, Map, Number, Object, Promise, RangeError, Set, String, Symbol, TypeError,
  queueMicrotask, setTimeout, clearTimeout,
};
const internal = {
  native: {
    hostLookup(hostname: string, family: 0 | 4 | 6, hints: number) {
      calls.push({ hostname, family, hints });
      if (hints !== 0) return Promise.reject(Object.assign(new Error("Lookup hints are not supported"), { code: "ENOTSUP", syscall: "getaddrinfo", hostname }));
      if (hostname === "missing.example") return Promise.reject(Object.assign(new Error("Lookup is not supported"), { code: "ENOTSUP", syscall: "getaddrinfo", hostname }));
      if (family === 4 && hostname === "localhost") return Promise.reject(Object.assign(new Error("No IPv4 address found"), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname }));
      return Promise.resolve([
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]);
    },
  },
  builtinFactories: {},
  describe(value: unknown) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object") return "an instance of Object";
    return String(value);
  },
  require(name: string) {
    if (name === "net_address") return { isIP(value: unknown) { return value === "127.0.0.1" ? 4 : value === "::1" ? 6 : 0; } };
    throw new Error(`Unexpected module ${name}`);
  },
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]) { queueMicrotask(() => callback(...args)); },
};
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), context);
const dnsFactory = factory(internal);
const dns = dnsFactory.module();
const promises = dnsFactory.promises();

function callbackLookup(...args: unknown[]): Promise<unknown[]> {
  return new Promise(resolve => dns.lookup(...args, (...result: unknown[]) => resolve(result)));
}

test("DNS modules share the promise facade and preserve Bun lookup ordering", async () => {
  expect(dns.promises).toBe(promises);
  expect(await promises.lookup("localhost")).toEqual({ address: "::1", family: 6 });
  expect(await promises.lookup("localhost", { all: true, verbatim: true })).toEqual([
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  expect(await promises.lookup("localhost", { all: true, verbatim: false })).toEqual([
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
});

test("DNS overloads keep literals local and map hints to the backing flags", async () => {
  calls.length = 0;
  expect(await promises.lookup("127.0.0.1", 6)).toEqual({ address: "127.0.0.1", family: 4 });
  expect(await promises.lookup("localhost")).toEqual({ address: "::1", family: 6 });
  expect(await callbackLookup("::1", { all: true })).toEqual([null, [{ address: "::1", family: 6 }]]);
  expect(calls).toEqual([{ hostname: "localhost", family: 0, hints: 0 }]);
});

test("DNS validation and backing failures retain structured errors", async () => {
  expect(() => promises.lookup({}, 4)).toThrow(/hostname/);
  expect(() => promises.lookup("localhost", { all: "yes" })).toThrow(/options.all/);
  expect(await promises.lookup("", { family: null as never })).toEqual({ address: null, family: 4 });
  await expect(promises.lookup("localhost", { hints: dns.ADDRCONFIG })).rejects.toMatchObject({ code: "ENOTSUP", syscall: "getaddrinfo", hostname: "localhost" });
  await expect(promises.lookup("localhost", { family: 4 })).rejects.toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" });
  await expect(new Promise(resolve => dns.lookup("missing.example", (...result: unknown[]) => resolve(result)))).resolves.toEqual([
    expect.objectContaining({ code: "ENOTSUP", syscall: "getaddrinfo", hostname: "missing.example" }),
    undefined,
    undefined,
  ]);
});

test("prepared Waffle exports keep the native worker lookup control green", () => {
  const workerUrl = new URL("../node_modules/waffle/dist/browser/fs-worker.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createRuntime, RuntimeNetworkLookupError } from "waffle";
    const runtime = createRuntime({
      filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(workerUrl)}) },
      processHost() { throw Error("lookup control must not activate processes"); },
    });
    const network = await runtime.network();
    try {
      assert.deepEqual(network.lookup("localhost", { family: 0, hints: 0 }), [{ address: "127.0.0.1", family: 4 }]);
      assert.throws(() => network.lookup("localhost", { family: 6 }), (error) => error instanceof RuntimeNetworkLookupError && error.code === "ENOTFOUND");
    } finally {
      await runtime.dispose();
    }
    console.log("prepared Waffle lookup control passed");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("prepared Waffle lookup control passed");
});

for (const kind of ["callback", "promise"]) test(`${kind} lookup rejects unknown hints before literals or provider calls`, () => {
  calls.length = 0;
  for (const hostname of ["127.0.0.1", "localhost"]) {
    const lookup = kind === "callback"
      ? () => dns.lookup(hostname, { hints: 1 }, () => {})
      : () => promises.lookup(hostname, { hints: 1 });
    expect(lookup).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
  }
  expect(calls).toEqual([]);
});

test.each(["", null, undefined, false, 0])("falsy host %p preserves asynchronous callback null and all results", async hostname => {
  calls.length = 0;
  let synchronous = true;
  const pending = new Promise(resolve => dns.lookup(hostname, (...result: unknown[]) => {
    expect(synchronous).toBe(false);
    resolve(result);
  }));
  synchronous = false;
  expect(await pending).toEqual([null, null, 4]);
  expect(await callbackLookup(hostname, { all: true })).toEqual([null, []]);
  expect(await promises.lookup(hostname)).toEqual({ address: null, family: 4 });
  expect(calls).toEqual([]);
});
