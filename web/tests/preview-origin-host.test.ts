import { afterEach, expect, test } from "bun:test";
import { request } from "node:http";
import { fixture } from "./fixtures/preview-origin-native";
import { LoopbackPreviewOrigins } from "../preview-origin-host";

const hosts: LoopbackPreviewOrigins[] = [];
afterEach(async () => { await Promise.all(hosts.map(host => host.close())); hosts.length = 0; });
function host(limit?: number) {
  const value = new LoopbackPreviewOrigins(limit);
  hosts.push(value);
  return value;
}


async function rawStatus(origin: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(origin, { headers }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

function socketAt(origin: string, path = "/socket"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + path);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("WebSocket rejected"));
  });
}

test("native HTTP keeps root paths, methods, body, headers and status on fixed owner/port origins", async () => {
  const registry = host();
  const firstOwner = {}, secondOwner = {};
  const first = await registry.bind(firstOwner, 3137, fixture("first"));
  const second = await registry.bind(secondOwner, 3137, fixture("second"));
  expect(first.origin).not.toBe(second.origin);
  expect(registry.originForPort(firstOwner, 3137)).toBe(first.origin);
  expect(() => registry.originForPort({}, 3137)).toThrow("Unregistered");
  expect(() => registry.originForPort(firstOwner, 3138)).toThrow("Unregistered");
  const response = await fetch(`${first.origin}/nested?value=%2F&targetURL=http://example.test`, {
    method: "POST", body: "body\u0000data", headers: { "x-challenge": "challenge" },
  });
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(response.headers.get("x-echo")).toBe("challenge");
  expect(response.headers.get("x-method")).toBe("POST");
  expect(response.headers.get("set-cookie")).toBe("fixture=1; Path=/");
  expect(await response.text()).toBe("first:/nested?value=%2F&targetURL=http://example.test:body\u0000data");
  expect(await (await fetch(second.origin)).text()).toBe("second:/:");
  const redirect = await fetch(`${first.origin}/redirect`, { redirect: "manual" });
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("/nested?value=redirect");
  expect((await fetch(`${first.origin}/empty`)).status).toBe(204);
  expect(await (await fetch(first.origin, { method: "HEAD" })).text()).toBe("");
});

test("foreign owner origins, wrong Host/port and cross-site requests never dispatch", async () => {
  const registry = host();
  const first = await registry.bind({}, 3137, fixture("first"));
  const second = await registry.bind({}, 3137, fixture("second"));
  expect((await fetch(first.origin, { headers: { origin: second.origin } })).status).toBe(403);
  expect((await fetch(first.origin, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect(await rawStatus(first.origin, { host: new URL(second.origin).host })).toBe(421);
  expect(await rawStatus(first.origin, { host: "example.test" })).toBe(421);
  expect((await fetch(first.origin, { headers: { origin: first.origin } })).status).toBe(201);
  const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  expect(await rawStatus(`${first.origin}/socket`, { ...upgrade, origin: second.origin })).toBe(403);
  expect(await rawStatus(`${first.origin}/socket`, { ...upgrade, host: new URL(second.origin).host })).toBe(421);
});

test("native WebSocket upgrades and binary frames work; owner close terminates sockets", async () => {
  const registry = host();
  const owner = {};
  const binding = await registry.bind(owner, 3137, fixture("socket"));
  const socket = await socketAt(binding.origin);
  try {
    const echoed = new Promise<ArrayBuffer>(resolve => { socket.onmessage = event => resolve(event.data); });
    socket.binaryType = "arraybuffer";
    socket.send(new Uint8Array([0, 1, 255]));
    expect(new Uint8Array(await echoed)).toEqual(new Uint8Array([0, 1, 255]));
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    await registry.closeOwner(owner);
    await closed;
    expect(() => registry.originForPort(owner, 3137)).toThrow("Unregistered");
    await expect(socketAt(binding.origin)).rejects.toThrow();
  } finally { socket.close(); }
});

test("late close cannot remove replacement route; teardown and lifetime allocations are bounded", async () => {
  const registry = host(2);
  const owner = {};
  let closes = 0;
  const endpoint = fixture("old");
  endpoint.close = () => { closes++; };
  const old = await registry.bind(owner, 3137, endpoint);
  await expect(registry.bind(owner, 3137, fixture("duplicate"))).rejects.toThrow("already registered");
  await old.close();
  const replacement = await registry.bind(owner, 3137, fixture("new"));
  await old.close();
  expect(closes).toBe(1);
  expect(replacement.origin).not.toBe(old.origin);
  expect(registry.originForPort(owner, 3137)).toBe(replacement.origin);
  expect(await (await fetch(replacement.origin)).text()).toBe("new:/:");
  await expect(registry.bind({}, 3138, fixture("overflow"))).rejects.toThrow("allocation limit");
  await registry.close();
  await expect(registry.bind(owner, 3137, fixture("late"))).rejects.toThrow("closed");
});

test("owner close aborts pending HTTP and disposes endpoint once", async () => {
  const registry = host();
  const owner = {};
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let closes = 0;
  const endpoint = fixture("pending");
  endpoint.fetch = async req => {
    req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await aborted.promise;
    return new Response("late result");
  };
  endpoint.close = () => { closes++; };
  const binding = await registry.bind(owner, 3137, endpoint);
  const result = fetch(binding.origin).catch(() => undefined);
  await entered.promise;
  await binding.close();
  await aborted.promise;
  await result;
  await binding.close();
  expect(closes).toBe(1);
});


test("HTTP client cancellation reaches the native endpoint", async () => {
  const registry = host();
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const endpoint = fixture("cancel");
  endpoint.fetch = async req => {
    req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await aborted.promise;
    return new Response("cancelled");
  };
  const binding = await registry.bind({}, 3137, endpoint);
  const controller = new AbortController();
  const result = fetch(binding.origin, { signal: controller.signal }).catch(() => undefined);
  await entered.promise;
  controller.abort();
  await result;
  await aborted.promise;
});

test("owner and host shutdown wait for an already closing endpoint", async () => {
  const registry = host();
  const closing = Promise.withResolvers<void>();
  const endpoint = fixture("slow-close");
  endpoint.close = () => closing.promise;
  const owner = {};
  const binding = await registry.bind(owner, 3137, endpoint);
  const pending = binding.close();
  let done = false;
  let ownerDone = false;
  const ownerShutdown = registry.closeOwner(owner).then(() => { ownerDone = true; });
  const shutdown = registry.close().then(() => { done = true; });
  await Bun.sleep(0);
  expect(done).toBe(false);
  expect(ownerDone).toBe(false);
  closing.resolve();
  await pending;
  await shutdown;
  await ownerShutdown;
  expect(done).toBe(true);
  expect(ownerDone).toBe(true);
});

test("concurrent registration and close during listen preserve owner isolation", async () => {
  const registry = host();
  const owner = {};
  const first = registry.bind(owner, 3137, fixture("first"));
  await expect(registry.bind(owner, 3137, fixture("duplicate"))).rejects.toThrow("already registered");
  await first;
  await registry.closeOwner(owner);
  let closes = 0;
  const endpoint = fixture("pending");
  endpoint.close = () => { closes++; };
  const pending = registry.bind(owner, 3137, endpoint);
  const closing = registry.closeOwner(owner);
  await expect(pending).rejects.toThrow("closed during registration");
  await closing;
  expect(closes).toBe(1);
  expect(() => registry.originForPort(owner, 3137)).toThrow("Unregistered");
});


test("HTTP response body cancellation aborts the native endpoint request", async () => {
  const registry = host();
  const aborted = Promise.withResolvers<void>();
  const endpoint = fixture("stream");
  endpoint.fetch = req => {
    req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); } }));
  };
  const binding = await registry.bind({}, 3137, endpoint);
  const response = await fetch(binding.origin);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("chunk");
  await reader.cancel();
  await aborted.promise;
});
