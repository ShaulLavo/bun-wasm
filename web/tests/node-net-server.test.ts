import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";
import { runInNewContext } from "node:vm";

type ServerState = EventEmitter & {
  _options: Record<string, unknown>;
  _connections: Set<unknown>;
  _referenced: boolean;
  listening: boolean;
  allowHalfOpen: unknown;
  pauseOnConnect: boolean;
  keepAlive: boolean;
  keepAliveInitialDelay: number;
  highWaterMark: unknown;
  noDelay: boolean;
  blockList?: unknown;
};
interface ServerConstructor {
  (options?: unknown, listener?: unknown): ServerState;
  new(options?: unknown, listener?: unknown): ServerState;
  prototype: ServerState;
  length: number;
}

function fixture() {
  let defaultReads = 0;
  const held = () => { throw new Error("Held transport or lifecycle operation invoked"); };
  class Duplex { constructor() { held(); } }
  const stream = { Duplex, getDefaultHighWaterMark() { defaultReads++; return getDefaultHighWaterMark(false); } };
  function factory(name: string) {
    const extension = name === "node_net_server" ? "ts" : "js";
    const source = readFileSync(new URL(`../../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
    const text = extension === "ts" ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
    return runInNewContext(text);
  }
  const address = factory("net_address")();
  const internal = {
    native: new Proxy({}, { get: held }),
    builtin(name: string) { if (name !== "node:stream") return held(); return stream; },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net_address") return address;
      if (name === "node_net_server") return factory(name)(internal);
      return held();
    },
    nextTick: held,
  };
  const net: { Server: ServerConstructor; createServer(options?: unknown, listener?: unknown): ServerState } = factory("node_net")(internal)({
    Connection: Duplex, addWaiter: held, waiters: new Set(), hostError: held,
    listenOrThrow: held, acceptLoop: held, trackServerConnection: held,
    closeNodeServer: held, disposeNodeServer: held,
  });
  return { ...net, BlockList: address.BlockList, defaultReads: () => defaultReads };
}

test("Server is callable and keeps constructor, arity and subclass identity", () => {
  const { Server, createServer } = fixture();
  const server = Server();
  expect(server).toBeInstanceOf(Server);
  expect(server).toBeInstanceOf(EventEmitter);
  expect(server.constructor).toBe(Server);
  expect(Server.length).toBe(2);
  expect(createServer()).toBeInstanceOf(Server);
  expect(Server.call({}, {})).toBeInstanceOf(Server);
  class Derived extends Server {}
  const derived = new Derived({ highWaterMark: 17 });
  expect(derived).toBeInstanceOf(Derived);
  expect(derived.constructor).toBe(Derived);
  expect(derived.highWaterMark).toBe(17);
});

test("Server snapshots public options and normalizes constructor defaults", () => {
  const { Server } = fixture();
  const defaults = new Server(null);
  expect(defaults.allowHalfOpen).toBe(false);
  expect(defaults.pauseOnConnect).toBe(false);
  expect(defaults.keepAlive).toBe(false);
  expect(defaults.keepAliveInitialDelay).toBe(0);
  expect(defaults.noDelay).toBe(false);
  const options = { allowHalfOpen: "raw", pauseOnConnect: 1, keepAlive: "yes", keepAliveInitialDelay: 12.9, highWaterMark: 7, noDelay: 1 };
  const server = new Server(options);
  options.highWaterMark = 99;
  options.allowHalfOpen = "changed";
  expect(server._options).not.toBe(options);
  expect(server._options.highWaterMark).toBe(7);
  expect(server.allowHalfOpen).toBe("raw");
  expect(server.pauseOnConnect).toBe(true);
  expect(server.keepAlive).toBe(true);
  expect(server.keepAliveInitialDelay).toBe(12);
  expect(server.noDelay).toBe(true);
  expect(new Server({ keepAliveInitialDelay: -8 }).keepAliveInitialDelay).toBe(0);
  expect(new Server({ keepAliveInitialDelay: 2 ** 32 + 3 }).keepAliveInitialDelay).toBe(3);
  expect(new Server({ keepAliveInitialDelay: NaN }).keepAliveInitialDelay).toBe(0);
});

test("Server rejects primitive options and nonnumeric keepalive delays", () => {
  const { Server } = fixture();
  for (const value of [false, true, 0, 1, "", "text", 1n, Symbol("options")]) {
    expect(() => new Server(value)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  }
  expect(() => new Server({ keepAliveInitialDelay: "1" })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
});

test("Server obtains the current byte-stream default only for undefined highWaterMark", () => {
  const previous = getDefaultHighWaterMark(false);
  try {
    setDefaultHighWaterMark(false, 8192);
    const { Server, defaultReads } = fixture();
    expect(new Server().highWaterMark).toBe(8192);
    setDefaultHighWaterMark(false, 4096);
    expect(Server({ highWaterMark: undefined }).highWaterMark).toBe(4096);
    expect(defaultReads()).toBe(2);
    for (const highWaterMark of [0, null, 17]) expect(new Server({ highWaterMark }).highWaterMark).toBe(highWaterMark);
    expect(defaultReads()).toBe(2);
  } finally {
    setDefaultHighWaterMark(false, previous);
  }
});

test("Server validates only truthy blockList options and exposes valid identity", () => {
  const { Server, BlockList } = fixture();
  for (const blockList of [{}, { check() {} }, true, 1, "list", Symbol("list")]) {
    expect(() => new Server({ blockList })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", message: expect.stringContaining("options.blockList") }));
  }
  for (const blockList of [undefined, null, false, 0, "", NaN]) expect(new Server({ blockList }).blockList).toBeUndefined();
  const blockList = new BlockList();
  const options = { blockList };
  const server = new Server(options);
  expect(server.blockList).toBe(blockList);
  expect(server._options.blockList).toBe(blockList);
  options.blockList = new BlockList();
  expect(server.blockList).toBe(blockList);
});

test("Server.call initializes the inherited receiver and synthetic connection listener", () => {
  const { Server, BlockList } = fixture();
  const receiver: ServerState = Object.create(Server.prototype);
  const delivered: unknown[] = [];
  const blockList = new BlockList();
  const result = Server.call(receiver, { highWaterMark: 23, blockList }, (value: unknown) => delivered.push(value));
  expect(result).toBe(receiver);
  expect(receiver._connections.size).toBe(0);
  expect(receiver._referenced).toBe(true);
  expect(receiver.listening).toBe(false);
  expect(receiver.highWaterMark).toBe(23);
  expect(receiver.blockList).toBe(blockList);
  expect(receiver.listenerCount("connection")).toBe(1);
  const payload = { synthetic: true };
  receiver.emit("connection", payload);
  expect(delivered).toEqual([payload]);
  expect(new Server()._connections).not.toBe(receiver._connections);
});

test("the listener-only overload registers a plain synthetic event listener", () => {
  const { Server, createServer } = fixture();
  const delivered: unknown[] = [];
  const server = Server((value: unknown) => delivered.push(value));
  server.emit("connection", "synthetic");
  expect(delivered).toEqual(["synthetic"]);
  expect(server.listenerCount("connection")).toBe(1);
  expect(createServer({}, true).listenerCount("connection")).toBe(0);
});
