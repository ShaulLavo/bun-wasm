import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

const hostRequire = createRequire(import.meta.url);

interface Connection {
  bufferedAmount: number;
  closed: boolean;
  write(bytes: Uint8Array, callback?: (error?: Error | null) => void): void;
  destroy(error?: Error): void;
}
interface Http {
  request(options: object, callback?: (response: IncomingMessage) => void): ClientRequest;
  ServerResponse: new (connection: Connection, request: object, keepAlive: boolean, done: () => void) => ServerResponse;
}
interface Networking {
  nodeHttp(protocol: string): Http;
  nodeNet(): { Connection: new (handle: number) => Connection; connect(options: object): Duplex };
}

function drain(response: IncomingMessage, chunks: Buffer[]) {
  for (;;) {
    const chunk = response.read();
    if (chunk !== null) { chunks.push(chunk); continue; }
    response.socket?.resume();
    const socketChunk = response.socket?.read();
    if (socketChunk === null || socketChunk === undefined) return;
  }
}

// Actual HTTP, Connection, Socket and fetch factories; only the host ABI is modeled.
function fixture() {
  const packets: (Uint8Array | number)[] = [];
  const closed: number[] = [];
  const writes: Uint8Array[] = [];
  const timers = new Map<object, { at: number; callback: () => void }>();
  const ticks: (() => void)[] = [];
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
    return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), context);
  }
  const native = {
    hostCaps: { connect: true }, platformInfo: { version: "test" },
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
  const modules: Record<string, unknown> = {
    events: EventEmitter, buffer: { Buffer }, websocket: { clientClass: () => undefined },
    http_common: load("http_common")(), http_body: load("http_body")(), http_agent: load("http_agent")(),
    net_address: load("net_address", "js")(), node_net_socket_options: load("node_net_socket_options")(),
    fetch_body: load("fetch_body")(), compression_streams: { decode: (body: ReadableStream) => body },
  };
  modules.net_hostname = load("net_hostname")({ require: (name: string) => modules[name] });
  modules.node_net_socket_state = load("node_net_socket_state")();
  const internal = {
    native, web: { Request, Response: class extends Response { static _setNetwork() {} }, Headers }, builtinFactories: {}, realTimers: { setImmediate: (fn: () => void) => ticks.push(fn) },
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
    pumpIo: () => false,
  };
  modules.fetch_lifetime = load("fetch_lifetime")(internal);
  modules.node_net_onread = load("node_net_onread")(internal);
  core = load("node_stream_core", "js")(internal).Stream;
  const socketFactory = load("node_net", "js")(internal);
  modules.node_net_server = load("node_net_server")(internal);
  modules.node_net = (args: object) => Object.assign(socketFactory(args), { Connection: Reflect.get(args, "Connection") });
  net = load("net", "js")(internal);
  const http = net.nodeHttp("http:");
  const https = net.nodeHttp("https:");
  function flush() { while (ticks.length) ticks.shift()?.(); }
  async function pump() {
    for (let turn = 0; turn < 64; turn++) { flush(); internal.pumpIo(); await Promise.resolve(); }
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
    const response = new http.ServerResponse(connection, { method: "GET", httpVersion: "1.1" }, false, () => {});
    response.sendDate = false;
    return { connection, response };
  }
  return { http, request, server, packets, closed, writes, pump, flush, advance, timers,
    block(value: boolean) { blocked = value; }, reads: () => reads,
    socket() { const socket = new (net.nodeNet().Connection)(9); return socket; },
  };
}

async function expectResumableBody(state: ReturnType<typeof fixture>, currentResponse: () => IncomingMessage | undefined) {
  await state.pump();
  const response = currentResponse();
  expect(response).toBeDefined();
  expect(response!.readableLength).toBeLessThanOrEqual(response!.readableHighWaterMark + 4096);
  expect(response!.complete).toBe(false);
  const chunks: Buffer[] = [];
  for (let round = 0; round < 8 && !response!.complete; round++) {
    drain(response!, chunks);
    await state.pump();
  }
  drain(response!, chunks);
  expect(Buffer.concat(chunks).equals(Buffer.concat(Array.from({ length: 32 }, (_, i) => Buffer.alloc(4096, i))))).toBe(true);
  expect(response!.complete).toBe(true);
}

test("HTTPS exposes its first chunk before EOF and releases the reader on destroy", async () => {
  const state = fixture();
  let response: IncomingMessage | undefined;
  const chunks: string[] = [];
  const req = state.request(msg => { response = msg; msg.on("data", chunk => chunks.push(String(chunk))); msg.resume(); msg.read(); });
  state.packets.push(Buffer.from("data: first\n\n"));
  try {
    await state.pump();
    expect(chunks).toEqual(["data: first\n\n"]);
    expect(response?.complete).toBe(false);
  } finally { req.destroy(); await state.pump(); }
  expect(state.closed).toEqual([7]);
});

test("HTTPS unread body stops pulling and resumes in order", async () => {
  const state = fixture();
  let response: IncomingMessage | undefined;
  const req = state.request(msg => { response = msg; });
  for (let i = 0; i < 32; i++) state.packets.push(Buffer.alloc(4096, i));
  state.packets.push(0);
  try {
    await expectResumableBody(state, () => response);
    expect(state.closed).toEqual([7]);
  } finally { req.destroy(); await state.pump(); }
});

test("raw HTTP unread body pauses the socket and resumes in order", async () => {
  const state = fixture();
  let response: IncomingMessage | undefined;
  const req = state.http.request({ hostname: "localhost", port: 80, agent: false }, msg => { response = msg; });
  req.on("error", () => {});
  req.end();
  state.packets.push(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"));
  for (let i = 0; i < 32; i++) {
    state.packets.push(Buffer.concat([Buffer.from("1000\r\n"), Buffer.alloc(4096, i), Buffer.from("\r\n")]));
  }
  state.packets.push(Buffer.from("0\r\nX-Flow: done\r\n\r\n"), 0);
  try {
    await expectResumableBody(state, () => response);
    expect(response!.trailers["x-flow"]).toBe("done");
  } finally { req.destroy(); await state.pump(); }
});

test("raw HTTP setTimeout emits without aborting and can be disabled", async () => {
  const state = fixture();
  const req = state.http.request({ hostname: "localhost", port: 80, agent: false }, () => {});
  req.on("error", () => {});
  req.end();
  let timeouts = 0;
  req.setTimeout(20, () => timeouts++);
  state.packets.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n"));
  try {
    await state.pump();
    state.advance(20);
    expect(timeouts).toBe(1);
    expect(req.destroyed).toBe(false);
    req.setTimeout(10);
    req.setTimeout(0);
    state.advance(30);
    expect(timeouts).toBe(1);
  } finally { req.destroy(); await state.pump(); }
});

test("server writes wait for Connection completion and emit one drain", async () => {
  const state = fixture();
  const { connection, response } = state.server();
  const results: (Error | null | undefined)[] = [];
  let drains = 0;
  response.on("drain", () => drains++);
  state.block(true);
  try {
    for (let i = 0; i < 16; i++) {
      expect(response.write(Buffer.alloc(65536, "x"), error => results.push(error))).toBe(false);
    }
    state.flush();
    expect(results).toEqual([]);
    expect(drains).toBe(0);
    expect(response.writableLength).toBe(16 * 65536);
    state.block(false);
    await state.pump();
    expect(results).toEqual(Array.from({ length: 16 }, () => undefined));
    expect(drains).toBe(1);
    expect(response.writableLength).toBe(0);
    expect(Buffer.concat(state.writes).toString()).toContain("10000\r\n" + "x".repeat(65536) + "\r\n");
  } finally { connection.destroy(); state.flush(); }
});

test("server cancellation settles queued write and end callbacks once", async () => {
  const state = fixture();
  const { connection, response } = state.server();
  const writes: unknown[] = [];
  const ends: unknown[] = [];
  let finishes = 0;
  response.on("finish", () => finishes++);
  state.block(true);
  response.write("body", error => writes.push(error));
  response.end((error?: Error) => ends.push(error));
  connection.destroy(new Error("cancelled"));
  await state.pump();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toHaveProperty("message", "cancelled");
  expect(ends).toHaveLength(1);
  expect(ends[0]).toHaveProperty("message", "cancelled");
  expect(finishes).toBe(0);
});

test("setTimeout updates, disables and resets on HTTPS activity without aborting", async () => {
  const state = fixture();
  let response: IncomingMessage | undefined;
  const req = state.request(msg => { response = msg; msg.resume(); });
  let timeouts = 0;
  req.setTimeout(20, () => timeouts++);
  try {
    await state.pump();
    state.advance(15);
    state.packets.push(Buffer.from("activity"));
    await state.pump();
    state.advance(15);
    expect(timeouts).toBe(0);
    state.advance(6);
    expect(timeouts).toBe(1);
    expect(req.destroyed).toBe(false);
    expect(response?.complete).toBe(false);
    req.setTimeout(10);
    req.setTimeout(0);
    state.advance(30);
    expect(timeouts).toBe(1);
    req.setTimeout(10, () => timeouts++);
    state.packets.push(0);
    await state.pump();
    state.advance(30);
    expect(timeouts).toBe(1);
    expect(state.timers.size).toBe(0);
  } finally { req.destroy(); await state.pump(); }
});

test("raw HTTP completion clears a timeout configured before send", async () => {
  const state = fixture();
  let response: IncomingMessage | undefined;
  const req = state.http.request({ hostname: "localhost", agent: false }, msg => { response = msg; msg.resume(); });
  let timeouts = 0;
  req.on("timeout", () => timeouts++);
  req.on("error", () => {});
  req.setTimeout(20);
  req.end();
  state.packets.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  try {
    await state.pump();
    expect(response?.complete).toBe(true);
    expect(state.timers.size).toBe(0);
    state.advance(30);
    expect(timeouts).toBe(0);
    expect(req.socket?.listenerCount("timeout")).toBe(0);
  } finally { req.destroy(); await state.pump(); }
});

test("raw HTTP hands a pre-send timeout to the socket activity timer", async () => {
  const state = fixture();
  const req = state.http.request({ hostname: "localhost", agent: false }, msg => msg.resume());
  let timeouts = 0;
  req.on("timeout", () => timeouts++);
  req.on("error", () => {});
  req.setTimeout(20);
  req.end();
  state.packets.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"));
  try {
    await state.pump();
    expect(state.timers.size).toBe(1);
    state.advance(15);
    state.packets.push(Buffer.from("a"));
    await state.pump();
    state.advance(15);
    expect(timeouts).toBe(0);
    state.advance(5);
    expect(timeouts).toBe(1);
    expect(req.destroyed).toBe(false);
  } finally { req.destroy(); await state.pump(); }
  expect(state.timers.size).toBe(0);
});

test("raw HTTP duration updates forward one timeout event", async () => {
  const state = fixture();
  const req = state.http.request({ hostname: "localhost", agent: false });
  let timeouts = 0;
  let callbacks = 0;
  req.on("timeout", () => timeouts++);
  req.on("error", () => {});
  req.end();
  req.setTimeout(20, () => callbacks++);
  req.setTimeout(10, () => callbacks++);
  try {
    await state.pump();
    expect(req.socket?.listenerCount("timeout")).toBe(1);
    state.advance(10);
    expect(timeouts).toBe(1);
    expect(callbacks).toBe(2);
    expect(req.destroyed).toBe(false);
  } finally { req.destroy(); await state.pump(); }
  expect(state.timers.size).toBe(0);
});

for (const terminal of ["complete", "destroy"] as const) {
  test(`raw HTTP ${terminal} removes timeout forwarding after disabling`, async () => {
    const state = fixture();
    const req = state.http.request({ hostname: "localhost", agent: false }, msg => msg.resume());
    let timeouts = 0;
    req.on("timeout", () => timeouts++);
    req.on("error", () => {});
    req.end();
    req.setTimeout(20);
    req.setTimeout(10);
    req.setTimeout(0);
    const socket = req.socket;
    try {
      if (terminal === "complete") state.packets.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
      else req.destroy();
      await state.pump();
      expect(socket?.listenerCount("timeout")).toBe(0);
      socket?.emit("timeout");
      state.advance(30);
      expect(timeouts).toBe(0);
      expect(state.timers.size).toBe(0);
    } finally { req.destroy(); await state.pump(); }
  });
}

test("ServerResponse implicit headers support compression response wrappers", async () => {
  const state = fixture();
  const { connection, response } = state.server();
  const end = response.end;
  Reflect.set(response, "end", function (this: ServerResponse, chunk?: string, encoding?: BufferEncoding) {
    if (!Reflect.get(this, "_header")) Reflect.get(this, "_implicitHeader").call(this);
    return Reflect.apply(end, this, [chunk, encoding]);
  });
  try {
    response.setHeader("Content-Type", "text/plain");
    response.end("hello");
    await state.pump();
    const header = Reflect.get(response, "_header");
    const wire = Buffer.concat(state.writes).toString("latin1");
    expect(header).toContain("HTTP/1.1 200 OK\r\n");
    expect(header).toContain("Content-Type: text/plain\r\n");
    expect(header).toContain("Transfer-Encoding: chunked\r\n");
    expect(response.headersSent).toBe(true);
    expect(wire).toBe(`${header}5\r\nhello\r\n0\r\n\r\n`);
  } finally { connection.destroy(); state.flush(); }
});
