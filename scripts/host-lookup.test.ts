import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as hostStreams from "node:stream/web";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { netAddressSource } from "./net-address-source";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/host_lookup.ts", import.meta.url), "utf8");
const context = { Array, Error, JSON, Object, Promise, TypeError };
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), context);

type Waiter = {
  ref: boolean;
  step(): boolean;
  fail(error: unknown): void;
  cancel?(): void;
};
type Address = { address: string; family: 4 | 6 };
type FixtureOptions = {
  caps?: Record<string, boolean>;
  head?: string | number;
  start?: () => number;
  hostError?: string;
  addWaiter?: (waiter: Waiter) => Waiter;
};

const completeCaps = { poll: true, lookup_start: true, lookup_head: true, error: true, close: true };

function bootstrapFixture(caps: Record<string, boolean> = completeCaps, provider?: (hostname: string, family: number, hints: number) => Promise<Address[]>) {
  const realm = createContext({ ...hostStreams });
  const loaded: string[] = [];
  const closed: number[] = [];
  const started: [string, number, number][] = [];
  let head: string | number = -2;
  const native = {
    engine: "host",
    platformInfo: { version: "1.4.4", revision: "startup-test", arch: "wasm32" },
    hostCaps: caps,
    hostLookup: provider,
    hostLookupStart(hostname: string, family: number, hints: number) {
      started.push([hostname, family, hints]);
      return 17;
    },
    hostLookupHead: () => head,
    hostError: () => JSON.stringify({ name: "Error", message: "getaddrinfo ENOTFOUND localhost", code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" }),
    hostClose(handle: number) { closed.push(handle); return 0; },
    hostSignal: () => 0,
    mainPath: () => "/startup.ts",
    env: () => ({}),
    argv: () => ["bun", "/startup.ts"],
    execArgv: () => [],
    execPath: () => "/bun",
    isatty: () => false,
    now: () => 0,
    timeOrigin: () => 0,
    utf8Encode: (text: string) => new TextEncoder().encode(text),
    utf8Decode: (bytes: Uint8Array, fatal: boolean) => new TextDecoder("utf-8", { fatal, ignoreBOM: true }).decode(bytes),
    getAsyncContext: () => undefined,
    setAsyncContext() {},
    tlsDispose() {},
    closeAllDirs() {},
    streams: {},
    loadPolyfill(name: string): unknown {
      loaded.push(name);
      const typed = new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url);
      const path = existsSync(typed) ? typed : new URL(`../crates/bunwasm-runtime/src/js/${name}.js`, import.meta.url);
      if (name === "net_address") return runInContext(netAddressSource(), realm, { filename: path.pathname });
      const text = readFileSync(path, "utf8");
      const code = path.pathname.endsWith(".ts") ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${text}`) : text;
      return runInContext(code, realm, { filename: path.pathname });
    },
  };
  realm.native = native;
  const bootstrap = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  runInContext(`globalThis.runtime = ${bootstrap}(native)`, realm, { filename: "bootstrap.js" });
  return {
    evaluate(code: string): unknown { return runInContext(code, realm); },
    loaded, closed, started, native,
    setHead(value: string | number) { head = value; },
  };
}

test("whole bootstrap with real factories keeps missing lookup capability absent", () => {
  const state = bootstrapFixture({});
  expect(state.evaluate("typeof runtime.native.hostLookup")).toBe("undefined");
  expect(state.loaded).not.toContain("host_lookup");
  expect(state.evaluate("runtime.ioPending()")).toBe(0);
});

test("whole bootstrap installs native lookup after its real factory dependencies", async () => {
  const state = bootstrapFixture();
  expect(state.loaded).toContain("net");
  expect(state.loaded).toContain("websocket");
  const pending = state.evaluate("runtime.builtin('node:dns/promises').lookup('localhost', { all: true })");
  await Promise.resolve();
  expect(state.started).toEqual([["localhost", 0, 0]]);
  expect(state.evaluate("runtime.ioPending()")).toBe(1);
  expect(state.evaluate("runtime.pumpIo()")).toBe(false);
  state.setHead(JSON.stringify({ addresses: [{ address: "127.0.0.1", family: 4 }] }));
  expect(state.evaluate("runtime.pumpIo()")).toBe(true);
  await expect(pending).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
  expect(state.evaluate("runtime.ioPending()")).toBe(0);
  expect(state.closed).toEqual([17]);
});

test("whole bootstrap preserves an existing Promise provider", async () => {
  const provider = async (): Promise<Address[]> => [{ address: "::1", family: 6 }];
  const state = bootstrapFixture({}, provider);
  expect(state.native.hostLookup).toBe(provider);
  await expect(state.evaluate("runtime.builtin('node:dns/promises').lookup('localhost', { all: true })")).resolves.toEqual([{ address: "::1", family: 6 }]);
  expect(state.started).toEqual([]);
});

test("whole bootstrap exit cancels the real lookup waiter exactly once", async () => {
  const state = bootstrapFixture();
  state.evaluate("globalThis.settled = false; runtime.native.hostLookup('localhost', 0, 0).then(() => { settled = true; }, () => { settled = true; })");
  expect(state.evaluate("runtime.ioPending()")).toBe(1);
  state.evaluate("runtime.emitExit(0); runtime.emitExit(0)");
  state.setHead(JSON.stringify({ addresses: [{ address: "127.0.0.1", family: 4 }] }));
  expect(state.evaluate("runtime.pumpIo()")).toBe(false);
  await Promise.resolve();
  expect(state.evaluate("settled")).toBe(false);
  expect(state.evaluate("runtime.ioPending()")).toBe(0);
  expect(state.closed).toEqual([17]);
});

function fixture(options: FixtureOptions = {}) {
  const waiters = new Set<Waiter>();
  let head = options.head ?? -2;
  const closed: number[] = [];
  const errors: number[] = [];
  const native: Record<string, unknown> = {
    hostCaps: options.caps ?? completeCaps,
    hostLookupStart: options.start ?? (() => 17),
    hostLookupHead: () => head,
    hostClose(handle: number) { closed.push(handle); return 0; },
    hostError(handle: number) {
      errors.push(handle);
      return options.hostError ?? JSON.stringify({ name: "Error", message: "synthetic lookup failure", code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" });
    },
  };
  const net = {
    addWaiter(waiter: Waiter) {
      if (options.addWaiter) return options.addWaiter(waiter);
      waiters.add(waiter);
      return waiter;
    },
    removeWaiter(waiter: Waiter) { waiters.delete(waiter); },
    cancelIoWaiters() {
      for (const waiter of Array.from(waiters)) waiter.cancel?.();
    },
    hostError(handle: number, fallback: string) {
      const text = native.hostError as (handle: number) => string;
      const value = JSON.parse(text(handle)) as { name?: string; message?: string; code?: string; syscall?: string; hostname?: string };
      const error = new Error(value.message ?? fallback);
      Object.assign(error, value);
      return error;
    },
    pump() {
      let progress = false;
      for (const waiter of Array.from(waiters)) {
        if (waiter.step()) {
          waiters.delete(waiter);
          progress = true;
        }
      }
      return progress;
    },
    pending() { return Array.from(waiters).filter(waiter => waiter.ref).length; },
  };
  const internal = {
    native,
    require(name: string) {
      if (name === "net") return net;
      throw new Error(`unexpected module ${name}`);
    },
  };
  const adapter = factory(internal);
  adapter.install();
  return {
    adapter,
    native: native as { hostLookup?: (hostname: string, family: 0 | 4 | 6, hints: number) => Promise<Address[]> },
    net,
    setHead(value: string | number) { head = value; },
    closed,
    errors,
  };
}

test("native lookup waits on one referenced waiter and closes exactly once on success", async () => {
  const state = fixture();
  const pending = state.native.hostLookup!("localhost", 0, 0);
  expect(state.net.pending()).toBe(1);
  expect(state.net.pump()).toBe(false);
  state.setHead(JSON.stringify({ addresses: [{ address: "127.0.0.1", family: 4 }] }));
  expect(state.net.pump()).toBe(true);
  await expect(pending).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
  expect(state.net.pending()).toBe(0);
  expect(state.closed).toEqual([17]);
});

test("native lookup preserves structured resolver errors and closes on rejection", async () => {
  const state = fixture({ head: -1 });
  const pending = state.native.hostLookup!("localhost", 0, 0);
  expect(state.net.pump()).toBe(true);
  await expect(pending).rejects.toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" });
  expect(state.errors).toEqual([17]);
  expect(state.closed).toEqual([17]);
});

test("malformed native lookup results reject as protocol errors and still close", async () => {
  const state = fixture({ head: JSON.stringify({ addresses: [{ address: "127.0.0.1", family: 9 }] }) });
  const pending = state.native.hostLookup!("localhost", 0, 0);
  expect(state.net.pump()).toBe(true);
  await expect(pending).rejects.toMatchObject({ code: "ERR_INVALID_HOST_LOOKUP" });
  expect(state.closed).toEqual([17]);
});

test("cancelling lookup waiters removes the waiter and closes without settling user code", async () => {
  const state = fixture();
  const pending = state.native.hostLookup!("localhost", 0, 0);
  state.adapter.cancel();
  expect(state.net.pending()).toBe(0);
  expect(state.closed).toEqual([17]);
  state.setHead(JSON.stringify({ addresses: [] }));
  expect(state.net.pump()).toBe(false);
  await Promise.race([pending.then(() => "settled"), Promise.resolve("pending")]).then(result => expect(result).toBe("pending"));
});

test("lookup capability stays absent unless every native boundary is present", () => {
  const state = fixture({ caps: { ...completeCaps, error: false } });
  expect(state.native.hostLookup).toBeUndefined();
});

test("an existing Promise lookup provider remains the owner", () => {
  const existing = () => Promise.resolve([{ address: "::1", family: 6 as const }]);
  const state = fixture();
  state.native.hostLookup = existing;
  state.adapter.install();
  expect(state.native.hostLookup).toBe(existing);
});

test("startup failure closes an already-created host handle", async () => {
  const state = fixture({ addWaiter() { throw new Error("waiter setup failed"); } });
  const pending = state.native.hostLookup!("localhost", 0, 0);
  await expect(pending).rejects.toThrow("waiter setup failed");
  expect(state.closed).toEqual([17]);
});
