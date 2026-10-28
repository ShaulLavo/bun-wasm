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

async function lifecycleClient(origin: string, target: ReturnType<typeof native>, frame: (value: OwnerFrame) => void = () => {}, created: (port: number, binding: ReturnType<typeof nativeBinding>) => Promise<void> = async () => {}) {
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const owner = crypto.randomUUID();
  const client = await PreviewOwnerClient.connect({ baseURL: origin, signal: lifetime.signal,
    fetch: (input, init) => fetch(input, { ...init, headers: { origin } }),
    webSocket(url, protocols) {
      const connection = nativeWebSocket(url, protocols, origin);
      connection.addEventListener("message", event => frame(ownerFrame(String(event.data))));
      return connection;
    },
    async bind({ origin, port, signal }) {
      const binding = nativeBinding({ owner, origin, port, target: target.url.href, signal });
      await created(port, binding);
      return binding;
    },
  });
  releases.push(() => client.close());
  return client;
}

test("pending unregister consumes only its late reservation and preserves the sibling and immediate replacement", async () => {
  const { origin } = hosting();
  const target = native();
  const reservations: Extract<OwnerFrame, { type: "reserved" }>[] = [];
  let extraBindings = 0;
  const client = await lifecycleClient(origin, target, frame => { if (frame.type === "reserved") reservations.push(frame); }, async port => { if (port === 49153) extraBindings++; });
  const stable = await client.register(3137);
  const pending = client.register(49153).then(() => "published", error => String(error));
  client.unregister(49153);
  const replacement = client.register(49153);
  expect(await pending).toContain("Preview binding closed");
  const current = await replacement;
  const extras = reservations.filter(frame => frame.port === 49153);
  expect(extras).toHaveLength(2);
  expect(current).toBe(extras[1]!.origin);
  expect(current).not.toBe(extras[0]!.origin);
  expect(extraBindings).toBe(1);
  expect((await fetch(stable)).status).toBe(201);
  expect((await fetch(current)).status).toBe(201);
  await expect(fetch(extras[0]!.origin)).rejects.toThrow();
  expect(await client.register(3138)).toMatch(/^http:/);
});

test("cancelled grant consumes its valid late bound reply without publishing or closing the replacement", async () => {
  const { origin } = hosting();
  const target = native();
  let extraId: string | undefined;
  let oldOrigin: string | undefined;
  let cancel = () => {};
  let oldClosed = 0;
  const replacement = Promise.withResolvers<string>();
  const client = await lifecycleClient(origin, target, frame => {
    if (frame.type === "reserved" && frame.port === 49153 && !extraId) { extraId = frame.id; oldOrigin = frame.origin; }
    if (frame.type === "bound" && frame.id === extraId) cancel();
  }, async (port, binding) => {
    if (port !== 49153 || oldOrigin !== binding.authorization.origin) return;
    const close = binding.close;
    binding.close = () => { oldClosed++; close(); };
  });
  const stable = await client.register(3137);
  cancel = () => {
    client.unregister(49153);
    void client.register(49153).then(replacement.resolve, replacement.reject);
  };
  const pending = client.register(49153).then(() => "published", error => String(error));
  expect(await pending).toContain("Preview binding closed");
  const current = await replacement.promise;
  expect(current).not.toBe(oldOrigin);
  expect(oldClosed).toBe(1);
  expect((await fetch(stable)).status).toBe(201);
  expect((await fetch(current)).status).toBe(201);
  if (!oldOrigin) throw new Error("Missing old reservation");
  await expect(fetch(oldOrigin)).rejects.toThrow();
});

test("a cancelled asynchronous binding settles against its old identity after immediate port reuse", async () => {
  const { origin } = hosting();
  const target = native();
  const entered = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>(), returned = Promise.withResolvers<void>();
  let first = true;
  let oldClosed = 0;
  const client = await lifecycleClient(origin, target, () => {}, async (port, binding) => {
    if (port !== 49153 || !first) return;
    first = false;
    const close = binding.close;
    binding.close = () => { oldClosed++; close(); returned.resolve(); };
    entered.resolve();
    await settle.promise;
  });
  releases.push(() => settle.resolve());
  const stable = await client.register(3137);
  const pending = client.register(49153).then(() => "published", error => String(error));
  await entered.promise;
  client.unregister(49153);
  const current = await client.register(49153);
  expect(await pending).toContain("Preview binding closed");
  expect((await fetch(stable)).status).toBe(201);
  expect((await fetch(current)).status).toBe(201);
  settle.resolve();
  await returned.promise;
  expect(oldClosed).toBe(1);
  expect((await fetch(stable)).status).toBe(201);
  expect((await fetch(current)).status).toBe(201);
});

for (const type of ["reserved", "bound"] as const) test(`unknown ${type} replies remain fatal to the client`, async () => {
  const host = new PreviewOwnerHost();
  const closed = Promise.withResolvers<void>();
  let peer: import("bun").ServerWebSocket<OwnerSession> | undefined;
  const server = Bun.serve<OwnerSession>({ hostname: "127.0.0.2", port: 0,
    websocket: { ...host.websocket,
      open(socket) { peer = socket; host.websocket.open?.(socket); },
      close(socket, code, reason) { host.websocket.close?.(socket, code, reason); closed.resolve(); },
    },
    fetch: (request, server) => host.fetch(request, server),
  });
  releases.push(async () => { await host.close(); await server.stop(true); });
  const client = await lifecycleClient(server.url.origin, native());
  await client.register(3137);
  if (!peer) throw new Error("Missing native peer");
  const id = crypto.randomUUID();
  peer.send(encode(type === "bound" ? { type, id } : { type, id, port: 49153, origin: "http://127.0.0.3:49153" }));
  await closed.promise;
  await expect(client.register(3138)).rejects.toThrow("closed");
});

for (const secondaryFirst of [false, true]) test(`owned root hostname routes secondary-port HTTP and native WebSocket, secondary first ${secondaryFirst}`, async () => {
  const { origin } = hosting();
  const target = native();
  const client = await lifecycleClient(origin, target);
  if (secondaryFirst) await client.register(49153);
  const root = await client.register(3137);
  if (!secondaryFirst) await client.register(49153);
  const sibling = await client.register(3138);
  const url = new URL("/_build/?token=unit-fixture", root);
  url.protocol = "ws:"; url.port = "49153";
  const connection = nativeWebSocket(url, ["fixture-hmr"], root);
  releases.push(() => connection.close());
  await new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Owned hostname secondary port refused")); });
  expect(connection.protocol).toBe("fixture-hmr");
  const echoed = new Promise<string>(resolve => { connection.onmessage = event => resolve(String(event.data)); });
  connection.send("root-host-secondary");
  expect(await echoed).toBe("root-host-secondary");
  const endpoint = new URL("/cookies", url); endpoint.protocol = "http:";
  const response = await fetch(endpoint, { headers: { origin: root } });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  const foreign = await lifecycleClient(origin, target);
  const foreignRoot = await foreign.register(3137);
  expect((await fetch(endpoint, { headers: { origin: foreignRoot } })).status).toBe(403);
  const denied = nativeWebSocket(url, ["fixture-hmr"], foreignRoot);
  releases.push(() => denied.close());
  await expect(new Promise<void>((resolve, reject) => { denied.onopen = () => resolve(); denied.onerror = () => reject(new Error("Foreign root rejected")); })).rejects.toThrow("Foreign root rejected");
  const closed = new Promise<void>(resolve => { connection.onclose = () => resolve(); });
  client.unregister(49153);
  await closed;
  expect((await fetch(sibling)).status).toBe(201);
  await expect(fetch(endpoint, { headers: { origin: root } })).rejects.toThrow();
  await client.register(49153);
  expect((await fetch(endpoint, { headers: { origin: root } })).status).toBe(200);
  client.unregister(3137);
  await expect(fetch(endpoint, { headers: { origin: sibling } })).rejects.toThrow();
  const siblingEndpoint = new URL(endpoint); siblingEndpoint.hostname = new URL(sibling).hostname;
  expect((await fetch(siblingEndpoint, { headers: { origin: sibling } })).status).toBe(200);
  expect((await fetch(sibling)).status).toBe(201);
});
