import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Waiter { ref: boolean; step(): boolean }
interface Server {
  listening: boolean;
  _listener: number;
  _referenced: boolean;
  _starting: Waiter | null;
  _accepting: Waiter;
  emit(event: string, error?: Error): void;
}
const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/net_listener.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`));

function fixture(referenced = true) {
  let address: string | number = -2;
  const closed: number[] = [];
  const events: unknown[][] = [];
  const error = Object.assign(new Error("bind failed"), { code: "EADDRINUSE" });
  const accepting: Waiter = { ref: referenced, step: () => false };
  const waiters = new Set([accepting]);
  const server: Server = {
    listening: true, _listener: 7, _referenced: referenced,
    _starting: null, _accepting: accepting,
    emit(event, error) { events.push(error ? [event, error] : [event]); },
  };
  const native = { hostLocalAddr: () => address, hostClose: (handle: number) => { closed.push(handle); return 0; } };
  factory({ native }).start(server, {
    addWaiter(waiter: Waiter) { waiters.add(waiter); return waiter; },
    waiters,
    hostError: () => error,
  });
  function pump() {
    for (const waiter of Array.from(waiters)) if (waiter.step()) waiters.delete(waiter);
  }
  return { server, accepting, waiters, events, error, closed, pump, ready(value: string | number) { address = value; } };
}

test("HTTP startup waits for the bound host address without timers", () => {
  const state = fixture();
  state.pump();
  expect(state.events).toEqual([]);
  expect(state.waiters.size).toBe(2);
  state.ready('{"address":"127.0.0.1","port":1234}');
  state.pump();
  state.pump();
  expect(state.events).toEqual([["listening"]]);
  expect(state.waiters.has(state.accepting)).toBe(true);
  expect(state.server._starting).toBeNull();
});

test("a late bind error closes its handle and removes both waiters", () => {
  const state = fixture();
  state.ready(-1);
  state.pump();
  expect(state.events).toEqual([["error", state.error]]);
  expect(state.closed).toEqual([7]);
  expect(state.server.listening).toBe(false);
  expect(state.waiters.size).toBe(0);
});

test("closing a pending listener prevents a late listening event", () => {
  const state = fixture();
  state.server.listening = false;
  state.ready("{}");
  state.pump();
  expect(state.events).toEqual([]);
  expect(state.server._starting).toBeNull();
});

test("an unreferenced startup waiter does not keep the guest alive", () => {
  const state = fixture(false);
  expect(state.server._starting?.ref).toBe(false);
});
