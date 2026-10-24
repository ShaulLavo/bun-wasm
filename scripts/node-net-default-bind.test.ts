import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { getDefaultHighWaterMark } from "node:stream";
import { runInNewContext } from "node:vm";

function capturedBind(...args: unknown[]) {
  const held = () => { throw new Error("Transport or lifecycle operation invoked"); };
  const calls: [unknown, unknown][] = [];
  const deferred: (() => void)[] = [];
  const stopped = new Error("Stopped at bind boundary");
  class Duplex { constructor() { held(); } }
  function factory(name: string) {
    const extension = name === "node_net_server" ? "ts" : "js";
    const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
    const text = extension === "ts" ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
    return runInNewContext(text);
  }
  const address = factory("net_address")();
  const internal = {
    native: new Proxy({}, { get: held }),
    builtin(name: string) { if (name !== "node:stream") return held(); return { Duplex, getDefaultHighWaterMark }; },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net_address") return address;
      if (name === "node_net_server") return factory(name)(internal);
      return held();
    },
    nextTick(callback: () => void) { deferred.push(callback); },
  };
  const net: { Server: new() => { listen(...values: unknown[]): unknown; listening: boolean } } = factory("node_net")(internal)({
    Connection: Duplex, addWaiter: held, waiters: new Set(), hostError: held,
    listenOrThrow(host: unknown, port: unknown) { calls.push([host, port]); throw stopped; },
    acceptLoop: held, trackServerConnection: held, closeNodeServer: held, disposeNodeServer: held,
  });
  const server = new net.Server();
  expect(server.listen(...args)).toBe(server);
  expect(server.listening).toBe(false);
  expect(deferred).toHaveLength(1);
  return calls;
}

test("Server forwards unspecified listen hosts as IPv6 any before the bind boundary", () => {
  expect(capturedBind(0)).toEqual([["::", 0]]);
  expect(capturedBind({ port: 0 })).toEqual([["::", 0]]);
  expect(capturedBind({ port: 7, host: "" })).toEqual([["::", 7]]);
});

test("Server preserves explicit listen hosts before the bind boundary", () => {
  expect(capturedBind(3, "127.0.0.1")).toEqual([["127.0.0.1", 3]]);
  expect(capturedBind({ port: 4, host: "::1" })).toEqual([["::1", 4]]);
  expect(capturedBind({ port: 5, host: "0.0.0.0" })).toEqual([["0.0.0.0", 5]]);
});
