import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type * as NodeNet from "node:net";
import * as util from "node:util";
import { runInNewContext } from "node:vm";
import { netAddressSource } from "./net-address-source";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const invalidNames = ["this is not a hostname", "localhost:80", "a..b", "[127.0.0.1]", "[]", "[example.invalid]", "::1/64", "[::1/64]", "::ffff:127.1", "127.0.0.1\n", "a".repeat(64) + ".com"];
type Callback = (...args: unknown[]) => void;
type Socket = Pick<NodeNet.Socket, "connect" | "on" | "destroyed" | "closed" | "connecting">;
type BunOptions = { hostname?: unknown; port: number; socket: { connectError(socket: unknown, error: unknown): void; close?(): void } };

function fixture(connect = true) {
  const ticks: (() => void)[] = [];
  const immediates: (() => void)[] = [];
  const calls: { hostname: string; port: number }[] = [];
  const held = () => { throw new Error("Unexpected transport, real timer or listener operation"); };
  const nextTick = (callback: Callback, ...args: unknown[]) => { ticks.push(() => callback(...args)); };
  const native = {
    hostCaps: { connect },
    hostConnect(hostname: string, port: number) { calls.push({ hostname, port }); return -1; },
  };
  const context = { Buffer, AbortController, AbortSignal, TextEncoder, Error, TypeError, Uint8Array, clearTimeout() {}, setTimeout: held };
  function factory(name: string, extension = "js") {
    if (name === "net_address") return runInNewContext(netAddressSource(), context);
    const source = readFileSync(new URL(`${name}.${extension}`, runtime), "utf8");
    const text = extension === "ts" ? new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace("(function", "globalThis.__factory = (function")) : source;
    return runInNewContext(text, context);
  }
  const ports = factory("net_port", "ts")();
  const address = factory("net_address")({ require: () => ports });
  const processStub = { nextTick, env: {}, emitWarning: held };
  const { Stream } = factory("node_stream_core")({
    builtin(name: string) {
      if (name === "node:process") return processStub;
      if (name === "node:buffer") return { Buffer };
      if (name === "node:events") return EventEmitter;
      if (name === "node:util") return util;
      return held();
    },
    require: held,
  });
  const internal = {
    native, nextTick,
    realTimers: { setImmediate(callback: () => void) { immediates.push(callback); } },
    builtin(name: string) {
      if (name === "node:stream") return Stream;
      if (name === "node:net") return net;
      return held();
    },
    require(name: string): unknown {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net_address") return address;
      if (name === "net_hostname" || name === "node_net_server" || name === "node_net_socket_options" || name === "node_net_socket_state" || name === "node_net_onread") return factory(name, "ts")(internal);
      return held();
    },
  };
  // Checked-in Socket and stream core, with a refusing record stub at the host boundary.
  const net: { Socket: new() => Socket } = factory("node_net")(internal)({
    Connection: held, addWaiter: held, waiters: new Set(),
    hostError: () => Object.assign(new Error("synthetic host refusal"), { code: "ECONNREFUSED" }),
    listenOrThrow: held, acceptLoop: held, trackServerConnection: held,
    closeNodeServer: held, disposeNodeServer: held,
  });
  const bun: { connect(options: BunOptions): Promise<unknown> } = factory("bun_tcp", "ts")(internal)({ listenOrThrow: held, acceptLoop: held, waiters: new Set() });
  function drain() {
    for (let count = 0; count < 32 && (ticks.length || immediates.length); count++) (ticks.shift() ?? immediates.shift())!();
    expect(ticks.length + immediates.length).toBe(0);
  }
  return { net, bun, calls, drain, ticks, immediates };
}

function expectResolverError(error: unknown, hostname: string) {
  expect(error).toMatchObject({ name: "Error", code: "ENOTFOUND", syscall: "getaddrinfo", hostname, message: `getaddrinfo ENOTFOUND ${hostname}` });
}

function nodeFailure(host: unknown, expectedCode: string, connect = true) {
  const state = fixture(connect);
  const socket = new state.net.Socket();
  const events: string[] = [];
  let failure: unknown;
  socket.on("error", error => { failure = error; events.push("error"); });
  socket.on("close", () => { events.push("close"); });
  let connected = false;
  expect(Reflect.apply(socket.connect, socket, [{ port: 80, host }, () => { connected = true; }])).toBe(socket);
  expect(failure).toBeUndefined();
  expect(socket.destroyed).toBe(false);
  expect(state.ticks.length).toBeGreaterThanOrEqual(1);
  state.drain();
  expect(failure).toMatchObject({ code: expectedCode });
  expect(events).toEqual(["error", "close"]);
  expect(socket.destroyed).toBe(true);
  expect(socket.closed).toBe(true);
  expect(connected).toBe(false);
  return { state, failure };
}

async function bunFailure(hostname: unknown, expectedCode: string) {
  const state = fixture();
  const events: string[] = [];
  let callbackError: unknown;
  let settled = false;
  const promise = state.bun.connect({ hostname, port: 80, socket: {
    connectError(_socket, error) { callbackError = error; events.push("connectError"); },
    close() { events.push("close"); },
  } });
  const observed = promise.then(() => { throw new Error("A refusing host must not connect"); }, error => { settled = true; events.push("rejected"); return error; });
  expect(callbackError).toBeUndefined();
  expect(settled).toBe(false);
  expect(state.ticks.length).toBeGreaterThanOrEqual(1);
  state.drain();
  const failure = await observed;
  expect(failure).toBe(callbackError);
  expect(failure).toMatchObject({ code: expectedCode });
  expect(events).toEqual(["connectError", "close", "rejected"]);
  return { state, failure };
}

test("node:net rejects malformed and bracketed names on nextTick before the host call", () => {
  for (const hostname of invalidNames.concat(["[::1]"])) {
    const { state, failure } = nodeFailure(hostname, "ENOTFOUND");
    expectResolverError(failure, hostname);
    expect(state.calls).toEqual([]);
  }
});

test("node:net host type errors stay synchronous, even without a networking host", () => {
  for (const connect of [true, false]) checkHostTypes(connect);
});

function checkHostTypes(connect: boolean) {
  const state = fixture(connect);
  for (const host of [123, true, {}, [], 1n, Symbol("host")]) {
    const socket = new state.net.Socket();
    expect(() => Reflect.apply(socket.connect, socket, [{ host, port: 80 }])).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(socket.destroyed).toBe(false);
  }
  expect(state.calls).toEqual([]);
  expect(state.ticks).toEqual([]);
  expect(state.immediates).toEqual([]);
}

test("node:net keeps falsy defaults and valid hostname, IPv4 and IPv6 spellings", () => {
  for (const host of [undefined, null, false, 0, "", "localhost", "fixture.invalid.", "127.1", "0x7f000001", "127.0.0.1", "::1", "2001:db8::1"]) {
    const { state } = nodeFailure(host, "ECONNREFUSED");
    expect(state.calls).toEqual([{ hostname: typeof host === "string" && host ? host : "localhost", port: 80 }]);
  }
});

test("Bun.connect preserves malformed names and defers connectError and rejection", async () => {
  for (const hostname of invalidNames) {
    const { state, failure } = await bunFailure(hostname, "ENOTFOUND");
    expectResolverError(failure, hostname);
    expect(state.calls).toEqual([]);
  }
});

test("only Bun.connect removes valid IPv6 brackets before the recorded host call", async () => {
  const cases: readonly (readonly [string, string])[] = [["[::1]", "::1"], ["[2001:db8::1]", "2001:db8::1"], ["[fe80::1%zone]", "fe80::1%zone"]];
  for (const [hostname, normalized] of cases) {
    const { state } = await bunFailure(hostname, "ECONNREFUSED");
    expect(state.calls).toEqual([{ hostname: normalized, port: 80 }]);
  }
});

test("Bun.connect keeps falsy defaults and valid names and reports truthy type errors asynchronously", async () => {
  for (const hostname of [undefined, null, false, 0, "", "fixture.invalid.", "127.1", "::1"]) {
    const { state } = await bunFailure(hostname, "ECONNREFUSED");
    expect(state.calls).toEqual([{ hostname: typeof hostname === "string" && hostname ? hostname : "localhost", port: 80 }]);
  }
  for (const hostname of [123, true, {}, []]) {
    const { state } = await bunFailure(hostname, "ERR_INVALID_ARG_TYPE");
    expect(state.calls).toEqual([]);
  }
});
