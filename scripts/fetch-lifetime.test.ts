import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as streams from "node:stream/web";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type Server = { pendingRequests: number; stop(force?: boolean): Promise<void> };
type Net = { fetch(input: Request | string, init?: RequestInit): Promise<Response>; serve(options: { port: number; fetch(req: Request): Response | Promise<Response> }): Server };

function fixture() {
  const context = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, URL, URLSearchParams, ReadableStream, process, setTimeout, clearTimeout, performance };
  const load = (file: string) => {
    const source = readFileSync(new URL(file, runtime), "utf8");
    const code = file.endsWith(".ts") ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
    return runInNewContext(code, context);
  };
  const reads: (Uint8Array | number)[] = [];
  const writes: Uint8Array[] = [];
  const errors: unknown[] = [];
  const closed: number[] = [];
  const uploads: Uint8Array[] = [];
  let accept = false;
  let writeBudget = Infinity;
  let head: string | number = -2;
  let headReads = 0;
  let responseRead: Uint8Array | number = 0;
  const modules: Record<string, unknown> = {
    streams, buffer: { Buffer }, http_common: load("http_common.ts")(),
    websocket: { clientClass: () => undefined },
    html_server: { websocket: () => undefined, developmentEnabled: () => false, attach() {}, dispose() {}, upgrade: () => false, asset: () => null },
  };
  const native = {
    platformInfo: { version: "fixture", arch: "x64" }, hostCaps: { fetch: true },
    utf8Encode: (text: string) => new TextEncoder().encode(text),
    utf8Decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    latin1Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    now: () => 0, timeOrigin: () => 0,
    urlParse(input: string, base?: string) {
      const url = URL.parse(input, base);
      if (!url) return undefined;
      return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
    },
    hostFetch(_meta: string, bytes: Uint8Array) { uploads.push(bytes); return 30; },
    hostFetchHead() { headReads++; return head; },
    hostRead: (handle: number) => handle === 30 ? responseRead : reads.shift() ?? -2,
    hostClose(handle: number) { closed.push(handle); return 0; },
    hostError: () => JSON.stringify({ message: "connection reset", code: "ECONNRESET" }),
    hostListen: () => 10, hostLocalPort: () => 1234,
    hostPeerAddr: () => JSON.stringify({ address: "127.0.0.1", port: 1235, family: "IPv4" }),
    hostAccept() { if (!accept) return -2; accept = false; return 20; },
    hostWrite(_handle: number, bytes: Uint8Array) {
      if (writeBudget === 0) return -2;
      const accepted = Math.min(writeBudget, bytes.length);
      writes.push(bytes.slice(0, accepted));
      writeBudget -= accepted;
      return accepted;
    },
  };
  const internal = {
    native, web: { Request, Response, Headers, AbortController, DOMException },
    builtinFactories: {}, nextTick: queueMicrotask, printError(error: unknown) { errors.push(error); },
    pumpIo: () => false, ioPending: () => 0,
    toUint8: (value: ArrayBuffer) => new Uint8Array(value),
    concatBytes: (chunks: readonly Uint8Array[]) => new Uint8Array(Buffer.concat(chunks)),
    require(name: string): unknown {
      if (name in modules) return modules[name];
      const file = name === "net_address" ? `${name}.js` : `${name}.ts`;
      return modules[name] = load(file)(internal);
    },
  };
  load("web.js")(internal);
  const net: Net = load("net.js")(internal);
  async function pump() { internal.pumpIo(); await turn(); internal.pumpIo(); await turn(); }
  cleanups.push(() => { reads.length = 0; });
  return {
    net, web: internal.web, closed, uploads, writes, errors, pump, pending: () => internal.ioPending(),
    writeBudget(bytes = Infinity) { writeBudget = bytes; },
    get headReads() { return headReads; },
    head(value: string | number) { head = value; },
    responseRead(value: Uint8Array | number) { responseRead = value; },
    connect() { accept = true; reads.push(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n")); },
    request() { reads.push(new TextEncoder().encode("GET /next HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n")); },
    disconnect(error = -1) { reads.push(error); },
  };
}

async function turn() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

for (const reason of [null, false, 0, "", "cancelled", new Error("cancelled")]) {
  test(`open upload abort preserves ${String(reason)} and cancels its reader once`, async () => {
    const state = fixture();
    const controller = new state.web.AbortController();
    const cancellations: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(source) { source.enqueue(new Uint8Array([42])); },
      cancel(value) { cancellations.push(value); return new Promise<void>(() => {}); },
    });
    const req = new state.web.Request("http://fixture.invalid", { method: "POST", body, signal: controller.signal });
    const result: unknown[] = [];
    void state.net.fetch(req).then(() => result.push("resolved"), error => result.push(error));
    await turn();
    controller.abort(reason);
    await turn();
    expect(result).toEqual([reason]);
    expect(cancellations).toEqual([reason]);
    expect(body.locked).toBe(false);
    expect(state.uploads).toEqual([]);
    expect(state.closed).toEqual([]);
    expect(state.pending()).toBe(0);
  });
}

test("abort after finite body completion cannot dispatch a late host request", async () => {
  const state = fixture();
  const controller = new state.web.AbortController();
  const body = new ReadableStream({ start(source) { source.enqueue(new Uint8Array([1])); source.close(); } });
  const req = new state.web.Request("http://fixture.invalid", { method: "POST", body, signal: controller.signal });
  const result = state.net.fetch(req);
  controller.abort("late");
  await expect(result).rejects.toBe("late");
  expect(state.uploads).toEqual([]);
});

test("header abort closes its host handle once and removes the header waiter", async () => {
  const state = fixture();
  const controller = new state.web.AbortController();
  const result = state.net.fetch("http://fixture.invalid", { signal: controller.signal });
  await turn();
  expect(state.uploads).toHaveLength(1);
  controller.abort("headers");
  await expect(result).rejects.toBe("headers");
  await state.pump();
  expect(state.closed).toEqual([30]);
  expect(state.headReads).toBe(0);
  expect(state.pending()).toBe(0);
});

test("finite upload keeps its bytes and releases the host on response EOF", async () => {
  const state = fixture();
  state.head(JSON.stringify({ status: 200, headers: [] }));
  const body = new ReadableStream({ start(source) { source.enqueue(new Uint8Array([1, 2])); source.enqueue(new Uint8Array([3])); source.close(); } });
  const req = new state.web.Request("http://fixture.invalid", { method: "POST", body });
  const result = state.net.fetch(req);
  await turn();
  await state.pump();
  const response = await result;
  const text = response.text();
  await state.pump();
  expect(await text).toBe("");
  expect(state.uploads.map(bytes => Array.from(bytes))).toEqual([[1, 2, 3]]);
  expect(body.locked).toBe(false);
  expect(state.closed).toEqual([30]);
});

for (const mode of ["reset", "eof", "stop"] as const) {
  test(`serve ${mode} aborts one active request and releases pending accounting`, async () => {
    const state = fixture();
    let signal: AbortSignal | undefined;
    let events = 0;
    const server = state.net.serve({ port: 0, fetch(req) {
      signal = req.signal;
      return new Promise<Response>(resolve => req.signal.addEventListener("abort", () => { events++; resolve(new state.web.Response("cancelled")); }));
    } });
    cleanups.push(() => { void server.stop(true); });
    state.connect();
    await state.pump();
    expect(state.errors).toEqual([]);
    expect(server.pendingRequests).toBe(1);
    if (mode === "stop") await server.stop(true);
    else state.disconnect(mode === "eof" ? 0 : -1);
    await state.pump();
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason.name).toBe("AbortError");
    expect(events).toBe(1);
    expect(server.pendingRequests).toBe(0);
    await server.stop(true);
    await state.pump();
    expect(events).toBe(1);
    expect(state.closed.filter(handle => handle === 20)).toHaveLength(1);
    expect(state.writes).toHaveLength(0);
    expect(state.pending()).toBe(0);
  });
}

test("later keep-alive disconnect cannot abort a completed request", async () => {
  const state = fixture();
  const signals: AbortSignal[] = [];
  const server = state.net.serve({ port: 0, fetch(req) {
    signals.push(req.signal);
    if (signals.length === 1) return new state.web.Response("first");
    return new Promise<Response>(resolve => req.signal.addEventListener("abort", () => resolve(new state.web.Response("second"))));
  } });
  cleanups.push(() => { void server.stop(true); });
  state.connect();
  await state.pump();
  expect(server.pendingRequests).toBe(0);
  state.request();
  await state.pump();
  expect(state.errors).toEqual([]);
  expect(server.pendingRequests).toBe(1);
  state.disconnect();
  await state.pump();
  expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
  expect(server.pendingRequests).toBe(0);
});

test("already aborted fetch does not consume its body or allocate a host handle", async () => {
  const state = fixture();
  const controller = new state.web.AbortController();
  controller.abort("before");
  const req = new state.web.Request("http://fixture.invalid", { method: "POST", body: "unused", signal: controller.signal });
  await expect(state.net.fetch(req)).rejects.toBe("before");
  expect(req.bodyUsed).toBe(false);
  expect(state.uploads).toEqual([]);
  expect(state.pending()).toBe(0);
});

test("host header failure closes once and detaches the abort callback", async () => {
  const state = fixture();
  const controller = new state.web.AbortController();
  state.head(-1);
  const result = state.net.fetch("http://fixture.invalid", { signal: controller.signal });
  const outcome = result.then(() => null, error => error);
  await turn();
  await state.pump();
  expect(await outcome).toMatchObject({ code: "ECONNRESET" });
  controller.abort();
  expect(state.closed).toEqual([30]);
  expect(state.pending()).toBe(0);
});

test("abort after headers preserves the response reader reason and closes once", async () => {
  const state = fixture();
  const controller = new state.web.AbortController();
  state.head(JSON.stringify({ status: 200, headers: [] }));
  state.responseRead(-2);
  const result = state.net.fetch("http://fixture.invalid", { signal: controller.signal });
  await turn();
  await state.pump();
  const response = await result;
  const text = response.text();
  controller.abort(null);
  const outcome = text.then(() => "resolved", error => error);
  await state.pump();
  expect(await outcome).toBeNull();
  expect(state.closed).toEqual([30]);
  expect(state.pending()).toBe(0);
});

test("a disconnected handler's returned stream is cancelled without waiting for producer cleanup", async () => {
  const state = fixture();
  const cancellations: unknown[] = [];
  const server = state.net.serve({ port: 0,
    fetch: req => respondOnAbort(req, () => responseWithHangingCleanup(state.web, cancellations)),
  });
  cleanups.push(() => { void server.stop(true); });
  state.connect();
  await state.pump();
  state.disconnect();
  await state.pump();
  expect(cancellations).toEqual([undefined]);
  expect(server.pendingRequests).toBe(0);
  expect(state.writes).toHaveLength(0);
});

test("serve signal remains active during response streaming and detaches on normal completion", async () => {
  const state = fixture();
  let signal: AbortSignal | undefined;
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = state.net.serve({ port: 0, fetch(req) {
    signal = req.signal;
    return new state.web.Response(new ReadableStream({ start(controller) { source = controller; } }));
  } });
  cleanups.push(() => { void server.stop(true); });
  state.connect();
  await state.pump();
  expect(signal?.aborted).toBe(false);
  source?.close();
  await state.pump();
  state.disconnect();
  await state.pump();
  expect(signal?.aborted).toBe(false);
});

test("graceful stop leaves the busy handler's signal alone", async () => {
  const state = fixture();
  const response = Promise.withResolvers<Response>();
  let signal: AbortSignal | undefined;
  const server = state.net.serve({ port: 0, fetch(req) { signal = req.signal; return response.promise; } });
  cleanups.push(() => { void server.stop(true); });
  state.connect();
  await state.pump();
  await server.stop();
  expect(signal?.aborted).toBe(false);
  expect(server.pendingRequests).toBe(1);
  response.resolve(new state.web.Response("done"));
  await state.pump();
  expect(server.pendingRequests).toBe(0);
  expect(signal?.aborted).toBe(false);
  expect(state.closed).toEqual([10, 20]);
});

function respondOnAbort(req: Request, response: () => Response): Promise<Response> {
  return new Promise(resolve => req.signal.addEventListener("abort", () => resolve(response())));
}

function responseWithHangingCleanup(web: Pick<typeof globalThis, "Response">, cancellations: unknown[]): Response {
  const body = new ReadableStream({
    cancel(reason) { cancellations.push(reason); return new Promise<void>(() => {}); },
  });
  return new web.Response(body);
}

for (const mode of ["reset", "eof", "stop"] as const) {
  test(`blocked finite response ${mode} aborts its request once`, async () => {
    const state = fixture();
    state.writeBudget(0);
    let signal: AbortSignal | undefined;
    let events = 0;
    const aborted = () => { events++; };
    const server = state.net.serve({ port: 0, fetch(req) {
      signal = req.signal;
      signal.addEventListener("abort", aborted);
      return new state.web.Response("finite response");
    } });
    try {
      state.connect();
      await state.pump();
      expect(state.errors).toEqual([]);
      expect(state.writes).toHaveLength(0);
      expect(state.closed).toEqual([]);
      expect(state.pending()).toBeGreaterThan(1);
      if (mode === "stop") await server.stop(true);
      else state.disconnect(mode === "eof" ? 0 : -1);
      await state.pump();
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason.name).toBe("AbortError");
      expect(events).toBe(1);
      expect(server.pendingRequests).toBe(0);
      expect(state.closed.filter(handle => handle === 20)).toEqual([20]);
    } finally {
      await server.stop(true);
      await state.pump();
      expect(state.pending()).toBe(0);
    }
    expect(events).toBe(1);
  });
}

test("partly written finite response remains cancellable", async () => {
  const state = fixture();
  state.writeBudget(1);
  let signal: AbortSignal | undefined;
  const server = state.net.serve({ port: 0, fetch(req) {
    signal = req.signal;
    return new state.web.Response("finite response");
  } });
  try {
    state.connect();
    await state.pump();
    expect(Buffer.concat(state.writes).toString()).toBe("H");
    expect(signal?.aborted).toBe(false);
    state.disconnect();
    await state.pump();
    expect(signal?.aborted).toBe(true);
    expect(state.closed).toEqual([20]);
  } finally {
    await server.stop(true);
    await state.pump();
    expect(state.pending()).toBe(0);
  }
});

test("finite response drain releases the next keep-alive request without cross-request abort", async () => {
  const state = fixture();
  state.writeBudget(0);
  const signals: AbortSignal[] = [];
  const server = state.net.serve({ port: 0, fetch(req) {
    signals.push(req.signal);
    if (signals.length === 1) return new state.web.Response("first");
    return respondOnAbort(req, () => new state.web.Response("second"));
  } });
  try {
    state.connect();
    await state.pump();
    state.request();
    await state.pump();
    expect(signals).toHaveLength(1);
    state.writeBudget();
    await state.pump();
    expect(signals).toHaveLength(2);
    expect(Buffer.concat(state.writes).toString()).toEndWith("first");
    expect(server.pendingRequests).toBe(1);
    state.disconnect();
    await state.pump();
    expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
    expect(state.closed).toEqual([20]);
    expect(server.pendingRequests).toBe(0);
  } finally {
    await server.stop(true);
    await state.pump();
    expect(state.pending()).toBe(0);
  }
});

test("reset during blocked streamed response retains request cancellation and reader cleanup", async () => {
  const state = fixture();
  state.writeBudget(0);
  let signal: AbortSignal | undefined;
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations++; } });
  const server = state.net.serve({ port: 0, fetch(req) {
    signal = req.signal;
    return new state.web.Response(body);
  } });
  try {
    state.connect();
    await state.pump();
    expect(state.errors).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.disconnect();
    await state.pump();
    expect(signal?.aborted).toBe(true);
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
    expect(state.closed).toEqual([20]);
  } finally {
    await server.stop(true);
    await state.pump();
    expect(state.pending()).toBe(0);
  }
});

test("graceful stop waits for blocked finite output without aborting its request", async () => {
  const state = fixture();
  state.writeBudget(0);
  let signal: AbortSignal | undefined;
  const server = state.net.serve({ port: 0, fetch(req) {
    signal = req.signal;
    return new state.web.Response("finite response");
  } });
  try {
    state.connect();
    await state.pump();
    await server.stop();
    await state.pump();
    expect(signal?.aborted).toBe(false);
    expect(state.closed).toEqual([10]);
    state.writeBudget();
    await state.pump();
    expect(Buffer.concat(state.writes).toString()).toEndWith("finite response");
    expect(signal?.aborted).toBe(false);
    expect(state.closed).toEqual([10, 20]);
  } finally {
    await server.stop(true);
    await state.pump();
    expect(state.pending()).toBe(0);
  }
});
