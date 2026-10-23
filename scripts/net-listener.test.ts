import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Waiter { ref: boolean; step(): boolean }
interface Server {
  listening: boolean;
  _listener: number;
  _referenced: boolean;
  _starting: Waiter | null;
  _accepting?: Waiter;
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
  const waiters = new Set<Waiter>();
  const server: Server = {
    listening: true, _listener: 7, _referenced: referenced,
    _starting: null,
    emit(event, error) { events.push(error ? [event, error] : [event]); },
  };
  const native = { hostLocalAddr: () => address, hostClose: (handle: number) => { closed.push(handle); return 0; } };
  factory({ native }).start(server, {
    addWaiter(waiter: Waiter) { waiters.add(waiter); return waiter; },
    accept() { waiters.add(accepting); return accepting; },
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
  expect(state.waiters.size).toBe(1);
  state.ready('{"address":"127.0.0.1","port":1234}');
  state.pump();
  state.pump();
  expect(state.events).toEqual([["listening"]]);
  expect(state.waiters.has(state.accepting)).toBe(true);
  expect(state.server._starting).toBeNull();
});

test("a late bind error closes its handle without starting acceptance", () => {
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

function httpFixture() {
  let address: string | number = -2;
  let accepts = 0;
  const connections = [8];
  const events: string[] = [];
  const load = (name: string) => {
    const text = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
    return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${text}`), { TextEncoder });
  };
  const native = {
    hostListen: () => 7, hostLocalPort: () => 1234, hostLocalAddr: () => address,
    hostAccept: () => { accepts++; return connections.shift() ?? -2; }, hostClose: () => 0,
  };
  const modules = {
    events: EventEmitter, buffer: { Buffer }, net_listener: factory({ native }),
    http_common: load("http_common.ts")(), http_agent: load("http_agent.ts")(), websocket: { clientClass: () => undefined },
  };
  const internal = {
    native,
    web: {}, builtinFactories: {},
    require: (name: keyof typeof modules) => modules[name],
    builtin: () => ({ Readable, Writable }), nextTick: (_callback: () => void) => {},
    pumpIo: () => false, ioPending: () => 0,
  };
  const { createServer } = load("net.js")(internal).nodeHttp("http:");
  const server = createServer();
  server._onConnection = () => server.emit("connection");
  server.on("connection", () => events.push("connection"));
  server.on("listening", () => events.push("listening"));
  return { server, events, internal, accepts: () => accepts, ready() { address = "{}"; } };
}

test("HTTP listening precedes delivery of an already queued connection", () => {
  const state = httpFixture();
  state.server.listen(1234);
  state.ready();
  state.internal.pumpIo();
  state.internal.pumpIo();
  expect(state.events).toEqual(["listening", "connection"]);
});

test("HTTP does not accept queued connections while the bind is pending", () => {
  const state = httpFixture();
  state.server.listen(1234);
  state.internal.pumpIo();
  expect(state.accepts()).toBe(0);
  expect(state.events).toEqual([]);
});

test("closing in the HTTP listen callback prevents queued connection delivery", () => {
  const state = httpFixture();
  state.server.listen(1234, () => state.server.close());
  state.ready();
  state.internal.pumpIo();
  state.internal.pumpIo();
  expect(state.events).toEqual(["listening"]);
  expect(state.accepts()).toBe(0);
  expect(state.internal.ioPending()).toBe(0);
});

test("unref in the HTTP listen callback also unreferences acceptance", () => {
  const state = httpFixture();
  state.server.listen(1234, () => state.server.unref());
  state.ready();
  state.internal.pumpIo();
  expect(state.events).toEqual(["listening"]);
  expect(state.internal.ioPending()).toBe(0);
});
