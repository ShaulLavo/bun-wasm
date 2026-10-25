import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";

const source = readFileSync(process.env.IDENTITY_FACTORY ?? new URL("../crates/bunwasm-runtime/src/js/process.ts", import.meta.url), "utf8");
const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);

function create(identity: readonly [number, number]) {
  let reads = 0;
  const internal = {
    native: {
      platformInfo: {}, procIdentity() { reads++; return identity; },
      env: () => ({ PID: "999", PPID: "888" }), argv: () => ["bun"], execPath: () => "/bin/bun", hostSignal: () => 0,
    },
    require(name: string): unknown {
      if (name === "events") return EventEmitter;
      if (name === "process_signals") return () => () => false;
      throw new Error(`unexpected ${name}`);
    },
  };
  const guest = runInNewContext(emitted + ";globalThis.factory", { Error, TypeError })(internal);
  return { guest, reads: () => reads };
}

test("root identity comes from the native before factory boot completes, not environment", () => {
  const root = create([71, 0]);
  expect([root.guest.pid, root.guest.ppid]).toEqual([71, 0]);
  expect(root.reads()).toBe(1);
});

test("supplied child handles agree and siblings differ", () => {
  const firstHandle = { pid: 72 };
  const secondHandle = { pid: 73 };
  const first = create([firstHandle.pid, 71]);
  const second = create([secondHandle.pid, 71]);
  expect(first.guest.pid).toBe(firstHandle.pid);
  expect(second.guest.pid).toBe(secondHandle.pid);
  expect(first.guest.pid).not.toBe(second.guest.pid);
  expect([first.guest.ppid, second.guest.ppid]).toEqual([71, 71]);
  expect(first.guest.ppid).toBe(71);
  expect(first.reads()).toBe(1);
});

test("two engine factories given one process identity report the same pair", () => {
  // Does not prove that worker_threads currently receives a shared process capability.
  const identity: readonly [number, number] = [72, 71];
  const first = create(identity).guest;
  const second = create(identity).guest;
  expect([first.pid, first.ppid]).toEqual([second.pid, second.ppid]);
  expect(first.pid).toBe(72);
});
