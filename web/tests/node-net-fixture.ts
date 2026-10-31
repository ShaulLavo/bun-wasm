import { Buffer } from "node:buffer";
import EventEmitter from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type * as NodeNet from "node:net";
import { STATUS_CODES } from "node:http";
import type * as NodeHttp from "node:http";
import { Readable, Writable, Duplex, getDefaultHighWaterMark } from "node:stream";
import { runInNewContext } from "node:vm";
import { NetHost } from "../src/net/host";
import { createRing } from "../src/net/ring";

// Real Node adapters, waiter scheduler, streams and Waffle TCP pipes.
// No host ports or workers are opened.
export function networkFixture(overrides: Record<string, unknown> = {}) {
  const host = new NetHost(createRing(), () => {});
  const closed: number[] = [];
  const natives = host.engineNet().natives;
  const invoke = (name: string, ...args: unknown[]): unknown => {
    const fn = natives[name];
    if (!fn) throw new Error(`Missing native ${name}`);
    return Reflect.apply(fn, null, args);
  };
  const native = new Proxy({ hostCaps: { connect: true }, wake() {} }, {
    get(target, name: string) {
      if (name in overrides) return overrides[name];
      if (name === "latin1Decode") return (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
      if (name === "cwd") return () => "/work/project";
      if (name in target) return Reflect.get(target, name);
      if (name === "hostClose") return (handle: number) => { closed.push(handle); return invoke(name, handle); };
      return (...args: unknown[]) => invoke(name, ...args);
    },
  });
  const cache = new Map<string, unknown>();
  const internal = {
    native, web: { Request, Response, Headers }, builtinFactories: {}, nextTick: queueMicrotask,
    toUint8: (value: Uint8Array) => value, printError: (error: unknown) => { throw error; },
    realTimers: { setImmediate }, concatBytes: (parts: readonly Uint8Array[]) => Buffer.concat(parts),
    ioPending: () => 0, pumpIo: () => false,
    builtin: (name: string) => {
      if (name === "node:stream") return { Readable, Writable, Duplex, getDefaultHighWaterMark: () => getDefaultHighWaterMark(false) };
      if (name === "node:net") return net;
      if (name === "node:http") return { ...http, STATUS_CODES, maxHeaderSize: 16384 };
      throw new Error(`Unexpected builtin ${name}`);
    },
    require(name: string): unknown {
      if (name === "buffer") return { Buffer };
      if (name === "events") return EventEmitter;
      if (name === "websocket") return { clientClass: () => class {} };
      if (cache.has(name)) return cache.get(name);
      const path = new URL(`../../crates/bunwasm-runtime/src/js/${name}.js`, import.meta.url);
      const typed = new URL(`../../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url);
      const source = existsSync(path) ? readFileSync(path, "utf8") : new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }).transformSync(readFileSync(typed, "utf8"));
      const factory = runInNewContext(source, { Uint8Array, Buffer, TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout });
      const value = factory(internal);
      cache.set(name, value);
      return value;
    },
  };
  const transport = internal.require("net");
  if (!transport || typeof transport !== "object" || !("nodeNet" in transport) || typeof transport.nodeNet !== "function") throw new Error("Missing node:net adapter");
  const net: typeof NodeNet = transport.nodeNet();
  if (!("nodeHttp" in transport) || typeof transport.nodeHttp !== "function") throw new Error("Missing node:http adapter");
  const http: typeof NodeHttp = transport.nodeHttp("http:");
  const resources = new Set<NodeNet.Socket | NodeNet.Server>();
  const own = <T extends NodeNet.Socket | NodeNet.Server>(resource: T): T => { resources.add(resource); return resource; };
  async function pump() {
    for (let cycle = 0; cycle < 8; cycle++) { internal.pumpIo(); await new Promise<void>(resolve => setImmediate(resolve)); }
  }
  async function dispose() {
    for (const resource of resources) {
      if (resource instanceof net.Socket) resource.destroy();
      else resource.close();
    }
    http.globalAgent.destroy();
    await pump();
    if (internal.ioPending() !== 0) throw new Error("Network waiters survived fixture cleanup");
  }
  function port(server: NodeNet.Server): number {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP listener address");
    return address.port;
  }
  return { net, http, own, pump, dispose, closed, port, invoke };
}
