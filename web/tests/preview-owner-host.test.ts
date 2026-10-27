import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { PreviewOwnerHost, type OwnerSession } from "../scripts/preview-owner-host";
import { PreviewOwnerClient } from "../src/preview-owner-client";
import { encode, hostFrame, OWNER_PATH, ownerFrame, type HostFrame, type OwnerFrame } from "../src/preview-owner-protocol";
import { nativeWebSocket } from "./fixtures/preview-native-websocket";
import { nativeBinding } from "./fixtures/preview-owner-relay";

const releases: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.reverse()) await release(); releases.length = 0; });
function hosting() {
  const host = new PreviewOwnerHost();
  const server: Server<OwnerSession> = Bun.serve({ hostname: "127.0.0.2", port: 0, websocket: host.websocket,
    fetch: (request, server) => host.handles(new URL(request.url).pathname) ? host.fetch(request, server) : new Response("owner", { headers: { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } }),
  });
  releases.push(async () => { await host.close(); await server.stop(true); });
  return { host, server, origin: server.url.origin };
}
function native() {
  const server = Bun.serve({ hostname: "127.0.0.2", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/nested?from=redirect" } });
      if (url.pathname === "/cookies") {
        const headers = new Headers(); headers.append("set-cookie", "first=1; Path=/"); headers.append("set-cookie", "second=2; Path=/");
        return new Response("cookies", { headers });
      }
      if ((url.pathname === "/socket" || url.pathname === "/_build/")) { if (server.upgrade(request, { data: undefined, headers: request.headers.get("sec-websocket-protocol") ? { "sec-websocket-protocol": request.headers.get("sec-websocket-protocol")!.split(",")[0]!.trim() } : {} })) return; return new Response(null, { status: 426 }); }
      return new Response(`${request.method}:${url.pathname}${url.search}:${await request.text()}`, { status: 201, headers: { "x-echo": request.headers.get("x-echo") ?? "", "content-type": "text/plain" } });
    }, websocket: { message(socket, message) { socket.send(message); } },
  });
  releases.push(async () => { await server.stop(true); });
  return server;
}
function bootstrap(origin: string, headers: Record<string, string> = { origin }) {
  return fetch(`${origin}${OWNER_PATH}/bootstrap`, { method: "POST", headers });
}
async function ticket(origin: string): Promise<string> {
  const response = await bootstrap(origin);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("ticket" in value) || typeof value.ticket !== "string") throw new Error("Missing ticket");
  return value.ticket;
}
async function socket(origin: string, grant: string, actualOrigin = origin): Promise<WebSocket> {
  const connection = nativeWebSocket(`${origin.replace("http:", "ws:")}${OWNER_PATH}`, ["bun-preview-owner", grant], actualOrigin);
  await new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Owner authentication rejected")); });
  releases.push(() => connection.close());
  return connection;
}
function next(connection: WebSocket): Promise<OwnerFrame> {
  return new Promise(resolve => { connection.onmessage = event => resolve(ownerFrame(String(event.data))); });
}
async function reserve(connection: WebSocket, port = 3137) {
  const id = crypto.randomUUID();
  const response = next(connection);
  connection.send(encode({ type: "register", id, port }));
  const frame = await response;
  if (frame.type !== "reserved") throw new Error("Missing reservation");
  return frame;
}

test("bootstrap and private WebSocket reject foreign/missing origin, bad ticket and replay without cookies", async () => {
  const { origin } = hosting();
  expect((await bootstrap(origin, {})).status).toBe(403);
  expect((await bootstrap(origin, { origin: "http://127.0.0.1:1" })).status).toBe(403);
  expect((await bootstrap(origin, { origin, "sec-fetch-site": "same-site" })).status).toBe(403);
  const response = await bootstrap(origin);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(socket(origin, "invalid-ticket-0000")).rejects.toThrow();
  const valid = await ticket(origin);
  await expect(socket(origin, valid, "http://127.0.0.1:1")).rejects.toThrow();
  const connection = await socket(origin, valid);
  expect(connection.protocol).toBe("bun-preview-owner");
  await expect(socket(origin, valid)).rejects.toThrow();
});

test("fixed-owner dispatcher carries native HTTP bodies and raw WebSocket frames; disconnect removes roots", async () => {
  const { origin } = hosting();
  const target = native();
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket: (url, protocols) => nativeWebSocket(url, protocols, origin),
    async bind({ origin: root, port, signal }) {
      return nativeBinding({ owner, port, origin: root, target: target.url.href, signal });
    },
  });
  releases.push(() => client.close());
  const root = await client.register(3137);
  const response = await fetch(`${root}/nested?value=%2F`, { method: "POST", body: "binary\u0000body", headers: { "x-echo": "challenge" } });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-echo")).toBe("challenge");
  expect(await response.text()).toBe("POST:/nested?value=%2F:binary\u0000body");
  const redirect = await fetch(`${root}/redirect`, { redirect: "manual" });
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("/nested?from=redirect");
  expect((await fetch(`${root}/cookies`)).headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  const ws = new WebSocket(`${root.replace("http:", "ws:")}/socket`);
  releases.push(() => ws.close());
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Native socket failed")); });
  const echoed = new Promise<ArrayBuffer>(resolve => { ws.onmessage = event => resolve(event.data); });
  ws.binaryType = "arraybuffer";
  ws.send(new Uint8Array([0, 255, 42]));
  expect(new Uint8Array(await echoed)).toEqual(new Uint8Array([0, 255, 42]));
  const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); });
  lifetime.abort();
  await closed;
  await expect(fetch(root)).rejects.toThrow();
});

for (const wrong of ["port", "origin", "scheme"] as const) test(`a wrong ${wrong} grant revokes its owner and pending root`, async () => {
  const { origin } = hosting();
  const connection = await socket(origin, await ticket(origin));
  const reserved = await reserve(connection);
  const grant = { owner: crypto.randomUUID(), port: reserved.port, origin: reserved.origin, capability: crypto.randomUUID() };
  if (wrong === "port") grant.port++;
  if (wrong === "origin") grant.origin = origin;
  if (wrong === "scheme") grant.origin = reserved.origin.replace("http:", "ftp:");
  const closed = new Promise<void>(resolve => { connection.onclose = () => resolve(); });
  connection.send(encode({ type: "grant", id: reserved.id, authorization: grant }));
  await closed;
  await expect(fetch(reserved.origin)).rejects.toThrow();
});

test("another runtime owner cannot reuse the first owner's private grant or route id", async () => {
  const { origin } = hosting();
  const first = await socket(origin, await ticket(origin));
  const second = await socket(origin, await ticket(origin));
  const one = await reserve(first);
  const two = await reserve(second);
  const grant = { owner: crypto.randomUUID(), port: one.port, origin: one.origin, capability: crypto.randomUUID() };
  const bound = next(first);
  first.send(encode({ type: "grant", id: one.id, authorization: grant }));
  expect((await bound).type).toBe("bound");
  const closed = new Promise<void>(resolve => { second.onclose = () => resolve(); });
  second.send(encode({ type: "grant", id: one.id, authorization: grant }));
  await closed;
  await expect(fetch(two.origin)).rejects.toThrow();
  const firstClosed = new Promise<void>(resolve => { first.onclose = () => resolve(); });
  first.close();
  await firstClosed;
});

test("codec retains Waffle byte payloads and rejects wrong schemes and foreign authorization origins", () => {
  const authorization = { owner: crypto.randomUUID(), port: 3137, origin: "http://127.0.0.1:7777", capability: crypto.randomUUID() };
  const frame: HostFrame = { type: "output", id: "exchange", output: { type: "data", chunk: new Uint8Array([0, 255]) } };
  expect(hostFrame(encode(frame))).toEqual(frame);
  expect(() => ownerFrame(JSON.stringify({ type: "open", id: "exchange", open: { type: "socket", authorization, url: "file:///etc/passwd" } }))).toThrow();
  expect(() => ownerFrame(JSON.stringify({ type: "open", id: "exchange", open: { type: "socket", authorization, url: "ws://127.0.0.1:8888/" } }))).toThrow();
});


test("a second port cannot change the authenticated runtime owner", async () => {
  const { origin } = hosting();
  const connection = await socket(origin, await ticket(origin));
  const first = await reserve(connection);
  const grant = { owner: crypto.randomUUID(), port: first.port, origin: first.origin, capability: crypto.randomUUID() };
  const bound = next(connection);
  connection.send(encode({ type: "grant", id: first.id, authorization: grant }));
  expect((await bound).type).toBe("bound");
  const second = await reserve(connection, 3138);
  const closed = new Promise<void>(resolve => { connection.onclose = () => resolve(); });
  connection.send(encode({ type: "grant", id: second.id, authorization: { ...grant, owner: crypto.randomUUID(), port: second.port, origin: second.origin } }));
  await closed;
  await expect(fetch(first.origin)).rejects.toThrow();
  await expect(fetch(second.origin)).rejects.toThrow();
});

for (const kind of ["pending", "stream"] as const) test(`real dispatcher propagates ${kind} HTTP cancellation to the native fixture`, async () => {
  const { origin } = hosting();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const target = Bun.serve({ hostname: "127.0.0.2", port: 0, async fetch(request) {
    request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    if (kind === "stream") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("first")); } }));
    await cancelled.promise;
    return new Response("cancelled");
  } });
  releases.push(async () => { await target.stop(true); });
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket: (url, protocols) => nativeWebSocket(url, protocols, origin),
    async bind({ origin, port, signal }) { return nativeBinding({ owner, origin, port, target: target.url.href, signal }); },
  });
  releases.push(() => client.close());
  const root = await client.register(3137);
  const abort = new AbortController();
  const pending = fetch(root, { signal: abort.signal }).catch(() => undefined);
  await entered.promise;
  if (kind === "pending") abort.abort();
  else {
    const response = await pending;
    if (!response?.body) throw new Error("Missing fixture stream");
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await reader.cancel();
  }
  await pending;
  await cancelled.promise;
  expect(client).toBeDefined();
});

test("private bootstrap and owner route allocations are bounded and torn down on rejection", async () => {
  const first = hosting();
  for (let index = 0; index < 128; index++) expect((await bootstrap(first.origin)).status).toBe(200);
  expect((await bootstrap(first.origin)).status).toBe(503);
  const second = hosting();
  const connection = await socket(second.origin, await ticket(second.origin));
  const origins: string[] = [];
  for (let port = 4000; port < 4016; port++) origins.push((await reserve(connection, port)).origin);
  const closed = new Promise<void>(resolve => { connection.onclose = () => resolve(); });
  connection.send(encode({ type: "register", id: crypto.randomUUID(), port: 4016 }));
  await closed;
  for (const origin of origins) await expect(fetch(origin)).rejects.toThrow();
});

test("an in-flight open for a retired port rejects without closing another port", async () => {
  const { origin } = hosting();
  const target = native();
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  let retire = () => {};
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket(url, protocols) {
      const connection = nativeWebSocket(url, protocols, origin);
      connection.addEventListener("message", event => {
        const frame = ownerFrame(String(event.data));
        if (frame.type === "open" && frame.open.authorization.port === 3137) retire();
      });
      return connection;
    },
    async bind({ origin, port, signal }) { return nativeBinding({ owner, origin, port, target: target.url.href, signal }); },
  });
  releases.push(() => client.close());
  const first = await client.register(3137);
  const second = await client.register(3138);
  retire = () => client.unregister(3137);
  await fetch(first).catch(() => undefined);
  expect((await fetch(second)).status).toBe(201);
});


test("literal extra-port WebSockets select their registered runtime and outlive another owner's close", async () => {
  const { origin } = hosting();
  const target = native();
  async function ownerClient() {
    const lifetime = new AbortController();
    releases.push(() => lifetime.abort());
    const owner = crypto.randomUUID();
    const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
      fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
      webSocket: (url, protocols) => nativeWebSocket(url, protocols, origin),
      async bind({ origin, port, signal }) { return nativeBinding({ owner, origin, port, target: target.url.href, signal }); },
    });
    releases.push(() => client.close()); return client;
  }
  const first = await ownerClient(), second = await ownerClient();
  const firstRoot = await first.register(3137), secondRoot = await second.register(3137);
  await first.register(49153);
  async function exchange(source: string) {
    const connection = nativeWebSocket("ws://127.0.0.1:49153/_build/", ["fixture-hmr"], source);
    releases.push(() => connection.close());
    await new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Extra port rejected")); });
    expect(connection.protocol).toBe("fixture-hmr");
    const echoed = new Promise<string>(resolve => { connection.onmessage = event => resolve(String(event.data)); });
    connection.send(source);
    expect(await echoed).toBe(source);
    connection.close();
  }
  await exchange(firstRoot);
  await expect(exchange(secondRoot)).rejects.toThrow("Extra port rejected");
  await second.register(49153);
  await first.shutdown();
  await exchange(secondRoot);
  await second.shutdown();
  const closed = nativeWebSocket("ws://127.0.0.1:49153/_build/", [], secondRoot);
  await expect(new Promise<void>((resolve, reject) => { closed.onopen = () => resolve(); closed.onerror = () => reject(new Error("Alias closed")); })).rejects.toThrow("Alias closed");
});

test("an occupied native alias fails without replacing the existing listener", async () => {
  const existing = Bun.serve({ hostname: "127.0.0.1", port: 49153, fetch: () => new Response("existing listener") });
  releases.push(async () => { await existing.stop(true); });
  const { origin } = hosting();
  const target = native();
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket: (url, protocols) => nativeWebSocket(url, protocols, origin),
    async bind({ origin, port, signal }) { return nativeBinding({ owner, origin, port, target: target.url.href, signal }); },
  });
  releases.push(() => client.close());
  await expect(client.register(49153)).rejects.toThrow();
  expect(await (await fetch(existing.url)).text()).toBe("existing listener");
});

test("an owned extra-port upgrade waits for its first authenticated grant", async () => {
  const { origin } = hosting();
  const target = native();
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket: (url, protocols) => nativeWebSocket(url, protocols, origin),
    async bind({ origin, port, signal }) {
      if (port === 49153) { entered.resolve(); await ready.promise; }
      return nativeBinding({ owner, origin, port, target: target.url.href, signal });
    },
  });
  releases.push(() => { ready.resolve(); client.close(); });
  const root = await client.register(3137);
  const pending = client.register(49153);
  await entered.promise;
  const connection = nativeWebSocket("ws://127.0.0.1:49153/_build/", ["fixture-hmr"], root);
  releases.push(() => connection.close());
  const opened = new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Pending owned upgrade rejected")); });
  await Bun.sleep(1);
  ready.resolve();
  await pending;
  await opened;
  expect(connection.protocol).toBe("fixture-hmr");
});
