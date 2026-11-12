import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute this checkout's I/O core, ending at its next function boundary.
export function selector(native: Record<string, unknown>) {
  const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/net.js", import.meta.url), "utf8");
  const end = source.indexOf("  // Run each waiter once;");
  if (end < 0) throw new Error("Missing I/O core boundary");
  const internal = {
    native, web: {},
    concatBytes: (parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => Array.from(part))),
    addIoWaiter: (_waiter: object) => {},
    ioWait: (_timeout: number): boolean => false,
  };
  runInNewContext(source.slice(0, end) + "})(internal);", { internal });
  return internal;
}

test("current mixed selector waits on selected process subscriptions with a referenced socket", () => {
  const bytes = new Uint8Array(16);
  const calls: unknown[] = [];
  const io = selector({
    hostCaps: { poll_io: true },
    hostPollIo: (subscriptions: Uint8Array, timeout: number) => { calls.push([subscriptions, timeout]); return 1; },
    procPoll: () => { throw new Error("Mixed wait chose process-only polling"); },
  });
  io.addIoWaiter({ ref: true, subscriptions: () => bytes });
  io.addIoWaiter({ ref: true });
  expect(io.ioWait(100)).toBe(true);
  expect(calls).toEqual([[bytes, 100]]);
});

test("absent combined capability avoids serialization; process-only and network-only keep their paths", () => {
  let serialized = 0, processCalls = 0;
  const io = selector({ hostCaps: {}, procPoll: () => { processCalls++; return new Uint8Array(); } });
  io.concatBytes = () => { serialized++; return new Uint8Array(); };
  io.addIoWaiter({ ref: true });
  expect(io.ioWait(0)).toBe(false);
  io.addIoWaiter({ ref: true, subscriptions: () => new Uint8Array(16) });
  expect(io.ioWait(0)).toBe(false);
  expect(serialized).toBe(0);
  const only = selector({ hostCaps: {}, procPoll: () => { processCalls++; return new Uint8Array(); } });
  only.addIoWaiter({ ref: true, subscriptions: () => new Uint8Array(16) });
  only.addIoWaiter({ ref: false });
  expect(only.ioWait(0)).toBe(true);
  expect(processCalls).toBe(1);
});

test("combined unsupported selects the network path and a native error unwinds", () => {
  const native = { hostCaps: { poll_io: true }, hostPollIo: () => -4 };
  const io = selector(native);
  io.addIoWaiter({ ref: true });
  io.addIoWaiter({ ref: true, subscriptions: () => new Uint8Array(16) });
  expect(io.ioWait(0)).toBe(false);
  native.hostPollIo = () => { throw new Error("poll_io errno 8"); };
  expect(() => io.ioWait(0)).toThrow("poll_io errno 8");
});
