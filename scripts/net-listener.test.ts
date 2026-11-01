import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable, Duplex, getDefaultHighWaterMark } from "node:stream";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { netAddressSource } from "./net-address-source";

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

test("an unreferenced server keeps its bind request alive until completion", () => {
  const state = fixture(false);
  expect(state.server._starting?.ref).toBe(true);
  state.ready("{}");
  state.pump();
  expect(state.server._starting).toBeNull();
  expect(state.accepting.ref).toBe(false);
});

function httpFixture(protocol: "http" | "tcp" = "http") {
  let listener = 6;
  let accepts = 0;
  const listeners = new Map<number, { ready: boolean; open: boolean; connections: number[] }>();
  const delivered: number[] = [];
  const ticks: (() => void)[] = [];
  const events: string[] = [];
  const load = (name: string) => {
    const text = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
    const code = name === "net_address.ts" ? netAddressSource() : new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${text}`);
    return runInNewContext(code, { TextEncoder });
  };
  const native = {
    hostListen() { listeners.set(++listener, { ready: false, open: true, connections: [] }); return listener; },
    hostLocalPort: () => 1234,
    hostLocalAddr(handle: number) { return listeners.get(handle)?.ready ? "{}" : -2; },
    hostAccept(handle: number) {
      accepts++;
      const state = listeners.get(handle);
      if (!state?.open) return -1;
      return state.ready ? state.connections.shift() ?? -2 : -2;
    },
    hostClose(handle: number) { const state = listeners.get(handle); if (state) state.open = false; return 0; },
  };
  const ports = load("net_port.ts")();
  const addressModules = { net_address: load("net_address.ts")({ require: () => ports }) };
  const modules = {
    events: EventEmitter, buffer: { Buffer }, net_port: ports, net_address: addressModules.net_address, net_listener: factory({ native }),
    net_hostname: load("net_hostname.ts")({ require: (name: keyof typeof addressModules) => addressModules[name] }),
    http_common: load("http_common.ts")(), http_agent: load("http_agent.ts")(), websocket: { clientClass: () => undefined },
  };
  const internal = {
    native,
    web: {}, builtinFactories: {},
    require: (name: keyof typeof modules) => modules[name],
    builtin: () => ({ Readable, Writable, Duplex, getDefaultHighWaterMark }), nextTick(callback: () => void) { ticks.push(callback); },
    pumpIo: () => false, ioPending: () => 0,
  };
  Object.assign(modules, {
    http_server_response: load("http_server_response.ts")(internal),
    node_net_server: load("node_net_server.ts")(internal),
    node_net: load("node_net.js")(internal),
  });
  Object.assign(modules, { tls_transport: load("tls_transport.ts")(internal) });
  const transport = load("net.js")(internal);
  const { createServer } = protocol === "tcp" ? transport.nodeNet() : transport.nodeHttp("http:");
  const server = createServer();
  server._onConnection = (conn: { handle: number }) => { delivered.push(conn.handle); server.emit("connection"); };
  server.on("connection", () => events.push("connection"));
  server.on("listening", () => events.push("listening"));
  function ready(connections = [8]) {
    const state = listeners.get(listener);
    if (!state) throw new Error("Missing host listener");
    state.ready = true;
    state.connections = connections;
  }
  function pump() {
    while (ticks.length) ticks.shift()?.();
    internal.pumpIo();
    while (ticks.length) ticks.shift()?.();
  }
  return { server, events, internal, delivered, accepts: () => accepts, ready, pump };

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


test("HTTP close and relisten in the listen callback has one startup and no leaked waiter", () => {
  const state = httpFixture();
  state.server.listen(1234, () => { state.server.close(); state.server.listen(2345); });
  state.ready();
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening"]);
  expect(state.accepts()).toBe(0);
  expect(state.internal.ioPending()).toBe(1);
  state.ready([80, 81]);
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening", "listening", "connection", "connection"]);
  expect(state.delivered).toEqual([80, 81]);
  expect(state.internal.ioPending()).toBe(1);
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
});

test("TCP close and relisten in the listen callback has one startup and no leaked waiter", () => {
  const state = httpFixture("tcp");
  state.server.listen(1234, () => { state.server.close(); state.server.listen(2345); });
  state.ready([]);
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening"]);
  expect(state.internal.ioPending()).toBe(2);
  state.ready([]);
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening", "listening"]);
  expect(state.internal.ioPending()).toBe(1);
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
});

test("HTTP close after a callback relisten leaves no waiter keeping the guest alive", () => {
  const state = httpFixture();
  state.server.listen(1234, () => { state.server.close(); state.server.listen(2345); });
  state.ready();
  state.pump();
  state.ready([]);
  state.pump();
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
});

test("plain HTTP relisten delivers each queued connection once and closes cleanly", () => {
  const state = httpFixture();
  for (const connections of [[80, 81], [82, 83]]) {
    state.server.listen(1234);
    state.ready(connections);
    state.pump();
    state.pump();
    state.pump();
    expect(state.internal.ioPending()).toBe(1);
    state.server.close();
    state.pump();
    expect(state.internal.ioPending()).toBe(0);
  }
  expect(state.delivered).toEqual([80, 81, 82, 83]);
  expect(state.events).toEqual(["listening", "connection", "connection", "listening", "connection", "connection"]);
});

test("a nested I/O pump in the listen callback cannot announce the same startup twice", () => {
  const state = httpFixture();
  state.server.listen(1234, () => state.pump());
  state.ready();
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening", "connection"]);
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
});

test("a nested I/O pump in the TCP listen callback cannot announce the same startup twice", () => {
  const state = httpFixture("tcp");
  state.server.listen(1234, () => state.pump());
  state.ready([]);
  state.pump();
  state.pump();
  expect(state.events).toEqual(["listening"]);
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
});

function checkSiblingReplacement(protocol: "http" | "tcp") {
  const state = httpFixture(protocol);
  const second = new state.server.constructor();
  const events: string[] = [];
  second.on("listening", () => events.push("second-listening"));
  const listen = state.internal.native.hostListen;
  state.internal.native.hostListen = () => {
    const handle = listen();
    state.ready([]);
    return handle;
  };
  state.server.listen(1234, () => { second.close(); second.unref().listen(2345); });
  second.unref().listen(3456);
  state.pump();
  state.pump();
  expect(events).toEqual(["second-listening"]);
  second.close();
  state.server.close();
  state.pump();
  expect(state.internal.ioPending()).toBe(0);
}

for (const protocol of ["tcp", "http"] as const) {
  test(`a canceled ${protocol} startup cannot announce a sibling's replacement`, () => checkSiblingReplacement(protocol));
}

function checkUnreferencedProbe(protocol: "http" | "tcp") {
  const state = httpFixture(protocol);
  let closed = false;
  state.server.unref();
  state.server.listen(1234, () => state.server.close(() => { closed = true; }));
  expect(state.internal.ioPending()).toBe(1);
  state.pump();
  expect(state.events).toEqual([]);
  state.ready([]);
  state.pump();
  expect(state.events).toEqual(["listening"]);
  expect(closed).toBe(true);
  expect(state.internal.ioPending()).toBe(0);
}

function checkUnrefDuringBind(protocol: "http" | "tcp") {
  const state = httpFixture(protocol);
  state.server.listen(1234);
  state.server.unref();
  expect(state.internal.ioPending()).toBe(1);
  state.ready([]);
  state.pump();
  expect(state.events).toEqual(["listening"]);
  expect(state.internal.ioPending()).toBe(0);
  state.server.close();
  state.pump();
}

for (const protocol of ["tcp", "http"] as const) {
  test(`${protocol} unref-before-listen completes the get-port-please probe`, () => checkUnreferencedProbe(protocol));
  test(`${protocol} unref during bind affects acceptance without losing startup`, () => checkUnrefDuringBind(protocol));
}
