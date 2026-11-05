import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import type { ClientRequest, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { netAddressSource } from "./net-address-source";

const hostRequire = createRequire(import.meta.url);

interface Connection {
  bufferedAmount: number;
  closed: boolean;
  write(bytes: Uint8Array, callback?: (error?: Error | null) => void): void;
  destroy(error?: Error): void;
}
interface Http {
  createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
  request(options: object, callback?: (response: IncomingMessage) => void): ClientRequest;
  ServerResponse: new (connection: Connection, request: object, keepAlive: boolean, done: () => void) => ServerResponse;
}
interface Networking {
  nodeHttp(protocol: string): Http;
  nodeNet(): { Connection: new (handle: number) => Connection; Socket: new () => Socket; connect(options: object): Duplex };
}

// Actual HTTP, Connection, Socket and fetch factories; only the host ABI is modeled.
export function fixture() {
  const packets: (Uint8Array | number)[] = [];
  const closed: number[] = [];
  const writes: Uint8Array[] = [];
  const timers = new Map<object, { at: number; callback: () => void }>();
  const ticks: (() => void)[] = [];
  const immediates: (() => void)[] = [];
  let now = 0;
  let blocked = false;
  let reads = 0;
  let net: Networking;
  let core: typeof import("node:stream");
  const context = {
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, AbortController, AbortSignal, ReadableStream,
    setTimeout(callback: () => void, ms: number) {
      const handle = { ref() { return this; }, unref() { return this; } };
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(id: object) { timers.delete(id); },
  };
  Reflect.set(context, "self", context);
  function load(name: string, extension = "ts") {
    const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
    const code = name === "net_address" ? netAddressSource() : new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`);
    return runInNewContext(code, context);
  }
  const native = {
    hostCaps: { connect: true }, platformInfo: { version: "test" }, getAsyncContext: () => undefined,
    hostFetch: () => 7,
    hostConnect: () => 9,
    hostFetchHead: () => JSON.stringify({ status: 200, headers: [], url: "https://localhost/" }),
    hostRead() { reads++; return packets.shift() ?? -2; },
    hostWrite(_handle: number, bytes: Uint8Array) { if (blocked) return -2; writes.push(bytes.slice()); return bytes.length; },
    hostClose(handle: number) { closed.push(handle); return 0; },
    hostShutdown: () => 0,
    hostError: () => JSON.stringify({ message: "fixture transport failed", code: "ECONNRESET" }),
    latin1Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    hostPeerAddr: () => '{"address":"127.0.0.1","port":80,"family":"IPv4"}',
    hostLocalAddr: () => '{"address":"127.0.0.1","port":1234,"family":"IPv4"}',
  };
  const ports = load("net_port")();
  const modules: Record<string, unknown> = {
    events: EventEmitter, buffer: { Buffer }, websocket: { clientClass: () => undefined },
    http_common: load("http_common")(), http_body: load("http_body")(), http_agent: load("http_agent")(),
    net_port: ports, net_address: load("net_address")({ require: () => ports }), node_net_socket_options: load("node_net_socket_options")(),
    fetch_body: load("fetch_body")(), compression_streams: { decode: (body: ReadableStream) => body },
  };
  modules.net_hostname = load("net_hostname")({ require: (name: string) => modules[name] });
  modules.node_net_socket_state = load("node_net_socket_state")();
  const internal = {
    native, web: { Request, Response: class extends Response { static _setNetwork() {} }, Headers }, builtinFactories: {}, realTimers: { setImmediate: (fn: () => void) => immediates.push(fn) },
    runInContext: (_context: unknown, fn: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) => fn.apply(receiver, args),
    require(name: string): unknown { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    builtin(name: string): unknown {
      if (name === "node:process") return { env: {}, versions: process.versions, nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => ticks.push(() => fn(...args)), stderr: { write() {} }, emitWarning() {} };
      if (name === "node:stream") return core;
      if (name === "node:net") return net.nodeNet();
      if (name === "node:http") return { STATUS_CODES: { 200: "OK" }, maxHeaderSize: 16384 };
      return hostRequire(name);
    },
    nextTick(callback: () => void) { ticks.push(callback); },
    toUint8: (value: Uint8Array) => value,
    concatBytes: (parts: Uint8Array[]) => Buffer.concat(parts),
    pumpIo: () => false, ioPending: () => 0,
  };
  modules.tls_transport = load("tls_transport")(internal);
  modules.net_path = load("net_path")(internal);
  modules.http_server_response = load("http_server_response")(internal);
  modules.fetch_lifetime = load("fetch_lifetime")(internal);
  modules.node_net_onread = load("node_net_onread")(internal);
  core = load("node_stream_core", "js")(internal).Stream;
  const socketFactory = load("node_net", "js")(internal);
  modules.node_net_server = load("node_net_server")(internal);
  modules.node_net = (args: object) => Object.assign(socketFactory(args), { Connection: Reflect.get(args, "Connection") });
  net = load("net", "js")(internal);
  const http = net.nodeHttp("http:");
  const https = net.nodeHttp("https:");
  function flushTicks() { while (ticks.length) ticks.shift()?.(); }
  function flush() {
    flushTicks();
    for (const immediate of immediates.splice(0)) immediate();
    flushTicks();
  }
  async function pump() {
    for (let turn = 0; turn < 64; turn++) {
      flushTicks();
      internal.pumpIo();
      await new Promise<void>(resolve => setImmediate(resolve));
      flush();
    }
    flush();
  }
  function advance(ms: number) {
    now += ms;
    for (const [id, task] of Array.from(timers)) {
      if (task.at > now) continue;
      timers.delete(id);
      task.callback();
    }
  }
  function request(callback: (response: IncomingMessage) => void) {
    const req = https.request({ hostname: "localhost" }, callback);
    req.on("error", () => {});
    req.end();
    return req;
  }
  function server() {
    const connection = new (net.nodeNet().Connection)(8);
    const socket = new (net.nodeNet().Socket)();
    Reflect.set(socket, "_conn", connection);
    Reflect.set(socket, "_phase", "open");
    Reflect.set(connection, "onClose", () => socket.destroy());
    let completions = 0;
    const response = new http.ServerResponse(connection, { method: "GET", httpVersion: "1.1" }, false, () => { completions++; });
    Reflect.set(response, "socket", socket);
    const socketClosed = () => { if (!response.writableFinished) Reflect.get(response, "_emitClose").call(response); };
    Reflect.set(response, "_socketClosed", socketClosed);
    socket.once("close", socketClosed);
    response.sendDate = false;
    return { connection, response, socket, completions: () => completions };
  }
  return { http, request, server, packets, closed, writes, pump, flush, advance, timers, pending: () => internal.ioPending(),
    block(value: boolean) { blocked = value; }, reads: () => reads,
    socket() { const socket = new (net.nodeNet().Connection)(9); return socket; },
  };
}
