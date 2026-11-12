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
