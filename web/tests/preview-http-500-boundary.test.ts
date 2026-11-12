import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import type { PreviewHostExchange, PreviewHostInput, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { NativeHTTPExchange, type NativeExchangeTransport } from "../scripts/preview-exchanges";
import { PreviewOwnerHost, type OwnerSession } from "../scripts/preview-owner-host";
import { nativeBinding } from "./fixtures/preview-owner-relay";
import { nativeWebSocket } from "./fixtures/preview-native-websocket";
import { PreviewOwnerClient } from "../src/preview-owner-client";

const releases: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.reverse()) await release(); releases.length = 0; });

type Scenario = "complete" | "no-eof" | "close";
type Encoding = "gzip" | "identity";
interface RawFixture { origin: string; closed: Promise<void>; close(): Promise<void>; }
interface DirectExchange { response: Response; dataOutputs: number; pulls: number; errors: string[]; }

function ownerHosting() {
  const host = new PreviewOwnerHost();
  const server: Server<OwnerSession> = Bun.serve({
    hostname: "127.0.0.2", port: 0, websocket: host.websocket,
    fetch: (request, ownerServer) => host.fetch(request, ownerServer) ?? new Response("owner"),
  });
  releases.push(async () => { await host.close(); await server.stop(true); });
  return server;
}

function diagnosticBody(): Buffer {
  const suffix = Array.from({ length: 2823 }, (_, index) => String.fromCharCode(32 + ((index * 37) % 95))).join("");
  return Buffer.from(`Compile error diagnostic\n${suffix}`);
}

function responseHead(encoding: Encoding): string {
  return [
    "HTTP/1.1 500 Internal Server Error",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Encoding: ${encoding}`,
    "Transfer-Encoding: chunked",
    "Connection: keep-alive",
    "X-Diagnostic-Body: complete-gzip-chunked-500",
    "",
    "",
  ].join("\r\n");
}

function chunkFrame(bytes: Uint8Array, declaredSize = bytes.byteLength): Buffer {
  return Buffer.concat([Buffer.from(`${declaredSize.toString(16)}\r\n`), Buffer.from(bytes), Buffer.from("\r\n")]);
}

async function listen(server: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function expectClosed(target: RawFixture): Promise<void> {
  await Promise.race([target.closed, Bun.sleep(500).then(() => { throw new Error("Raw fixture did not close"); })]);
}

async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function rawFixture(scenario: Scenario, encoding: Encoding): Promise<RawFixture> {
  const body = encoding === "gzip" ? gzipSync(diagnosticBody()) : diagnosticBody();
  const middle = Math.max(1, Math.floor(body.byteLength / 3));
  const chunks = [body.subarray(0, middle), body.subarray(middle, middle * 2), body.subarray(middle * 2)];
  const closed = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); closed.resolve(); });
    socket.once("data", () => {
      socket.write(responseHead(encoding));
      for (const [index, chunk] of chunks.entries()) {
        if (scenario === "close" && index === 0) {
          socket.write(chunkFrame(chunk, chunk.byteLength + 8).subarray(0, -2));
          socket.end();
          return;
        }
        socket.write(chunkFrame(chunk));
      }
      if (scenario === "complete") socket.write("0\r\nX-Diagnostic-End: complete\r\n\r\n");
    });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Raw fixture did not expose a TCP port");
  const fixture: RawFixture = {
    origin: `http://127.0.0.1:${address.port}`,
    closed: closed.promise,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
  releases.push(fixture.close);
  return fixture;
}

async function ownerClient(server: Server<OwnerSession>, target: RawFixture) {
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({
    baseURL: server.url.origin,
    signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin: server.url.origin } }),
    webSocket: (url, protocols) => nativeWebSocket(url, protocols, server.url.origin),
    async bind({ origin, port, signal }) { return nativeBinding({ owner, origin, port, target: target.origin, signal }); },
  });
  releases.push(() => client.close());
  return { client, root: await client.register(3137) };
}

async function directExchange(target: RawFixture, encoding: Encoding): Promise<DirectExchange> {
  const lifetime = new AbortController();
  const owner = crypto.randomUUID();
  const binding = await nativeBinding({ owner, origin: target.origin, port: 3137, target: target.origin, signal: lifetime.signal });
  releases.push(() => { lifetime.abort(); binding.close(); });
  const channels = new Map<string, PreviewHostExchange>();
  const counts = { dataOutputs: 0, pulls: 0, errors: [] as string[] };
  const transport: NativeExchangeTransport = {
    open(open: PreviewHostOpen, output: (message: PreviewHostOutput) => void, fail: () => void) {
      const id = crypto.randomUUID();
      const channel: PreviewHostExchange = {
        onmessage: null,
        postMessage(message) {
          if (message.type === "data") counts.dataOutputs++;
          if (message.type === "error") counts.errors.push(message.message);
          output(message);
        },
        close() { channels.delete(id); },
      };
      channels.set(id, channel);
      void binding.dispatcher.dispatch(open, channel).catch(fail);
      return id;
    },
    input(id: string, message: PreviewHostInput) {
      if (message.type === "pull") counts.pulls++;
      channels.get(id)?.onmessage?.(message);
    },
    retire(id: string) { channels.delete(id); },
    connected() { return true; },
  };
  const request = new Request(`${target.origin}/`, { headers: { "accept-encoding": encoding } });
  const exchange = new NativeHTTPExchange(request, transport);
  const response = await exchange.start({
    type: "http", authorization: binding.authorization, url: request.url,
    method: request.method, headers: Array.from(request.headers), body: null,
  });
  return { response, get dataOutputs() { return counts.dataOutputs; }, get pulls() { return counts.pulls; }, errors: counts.errors };
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) return Buffer.concat(parts.map(part => Buffer.from(part)));
    parts.push(result.value);
  }
}

test("owned preview carries a complete gzip chunked HTTP 500 through Waffle and EOF", async () => {
  const target = await rawFixture("complete", "gzip");
  const server = ownerHosting();
  const { root } = await ownerClient(server, target);
  const response = await fetch(root);
  expect(response.status).toBe(500);
  expect(diagnosticBody().byteLength).toBe(2848);
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("x-diagnostic-body")).toBe("complete-gzip-chunked-500");
  expect(Buffer.from(await readAll(response.body!.getReader())).toString()).toBe(diagnosticBody().toString());
  await expectClosed(target);
});

test("NativeHTTPExchange holds pull credit on an unfinished 500 and cancellation closes it", async () => {
  const target = await rawFixture("no-eof", "identity");
  const direct = await directExchange(target, "identity");
  expect(direct.response.status).toBe(500);
  const reader = direct.response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await Bun.sleep(20);
  expect(direct.dataOutputs).toBe(1);
  expect((await reader.read()).done).toBe(false);
  await Bun.sleep(20);
  expect(direct.dataOutputs).toBe(2);
  expect(direct.pulls).toBeGreaterThan(0);
  await reader.cancel("deliberate cancellation");
  await expectClosed(target);
});

test("NativeHTTPExchange rejects a deliberately closed gzip chunked 500 without EOF", async () => {
  const target = await rawFixture("close", "gzip");
  const direct = await directExchange(target, "gzip");
  expect(direct.response.status).toBe(500);
  const reader = direct.response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await expect(reader.read()).rejects.toThrow();
  expect(direct.errors).toHaveLength(1);
  expect(direct.errors[0]).toMatch(/mid-response|closed/i);
  await expectClosed(target);
});

function throwingEndExchange() {
  const events: string[] = [];
  const sendError = new Error("Preview owner queue limit");
  let output: (message: PreviewHostOutput) => void = () => { throw new Error("Exchange has not opened"); };
  const transport: NativeExchangeTransport = {
    open(_open, onOutput) { output = onOutput; return "exchange"; },
    input(_id, message) {
      events.push(message.type);
      if (message.type === "end") throw sendError;
    },
    retire() { events.push("retire"); },
    connected() { return true; },
  };
  const request = new Request("http://127.0.0.1:3137/");
  const pending = new NativeHTTPExchange(request, transport).start({
    type: "http", authorization: { owner: "owner", port: 3137, origin: request.url, capability: "capability" },
    url: request.url, method: request.method, headers: [], body: null,
  });
  return { events, sendError, pending, output: (message: PreviewHostOutput) => output(message) };
}

test("cancellation retires exactly once when the end-send fails", async () => {
  const control = throwingEndExchange();
  control.output({ type: "head", status: 500, statusText: "Internal Server Error", headers: [] });
  const response = await control.pending;
  await expect(response.body!.cancel()).rejects.toBe(control.sendError);
  expect(control.events).toEqual(["end", "retire"]);
  control.output({ type: "end" });
  expect(control.events).toEqual(["end", "retire"]);
});

test("response completion settles its reader when the end-send fails", async () => {
  const control = throwingEndExchange();
  control.output({ type: "head", status: 500, statusText: "Internal Server Error", headers: [] });
  const response = await control.pending;
  const reader = response.body!.getReader();
  const pendingRead = reader.read();
  expect(() => control.output({ type: "end" })).toThrow(control.sendError);
  expect(control.events).toEqual(["end", "retire"]);
  expect(await pendingRead).toEqual({ done: true, value: undefined });
  reader.releaseLock();
});

test("a pre-header rejection settles its response when the end-send fails", async () => {
  const control = throwingEndExchange();
  const rejection = control.pending.catch((error: unknown) => error);
  expect(() => control.output({ type: "error", message: "upstream failed" })).toThrow(control.sendError);
  expect(control.events).toEqual(["end", "retire"]);
  expect(await rejection).toEqual(new Error("Preview dispatcher rejected request"));
});
