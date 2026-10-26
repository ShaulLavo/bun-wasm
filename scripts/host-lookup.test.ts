import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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
