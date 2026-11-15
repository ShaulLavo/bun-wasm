import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextRegistry, type RegistryEntry } from "../../web/tests/next-framework-registry";
import { request, type Route } from "playwright";
import { registry } from "./registry.mjs";
import { browserRegistryRoute, registryBrokerResponse } from "./registry-request";
import { advisoryBodyLimit, advisoryResponseLimit, boundedRegistryBody, registryIdentity } from "./registry-identity";

const path = "/-/npm/v1/security/advisories/bulk";
const body = '{"next":["16.4.3"]}';
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const close of cleanups) await close();
});

async function disposeAll(disposers: (() => void | Promise<unknown>)[]) {
  const failures: unknown[] = [];
  for (const dispose of disposers.reverse()) {
    try { await dispose(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Replay fixture cleanup failed");
}

function replayFixture(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const controller = new AbortController();
  const disposers: (() => void | Promise<unknown>)[] = [];
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const dispose = async () => {
    controller.abort();
    await Promise.allSettled(pending);
    try { await disposeAll(disposers); } finally {
      rmSync(directory, { recursive: true, force: true });
      cleanups.delete(close);
    }
  };
  const close = () => closing ??= dispose();
  cleanups.add(close);
  const response = async (target: string, options?: RequestInit) => {
    controller.signal.throwIfAborted();
    const task = fetch(target, { ...options, signal: controller.signal }).then(async response => ({ status: response.status, body: await response.text() }));
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  };
  return { directory, close, response, signal: controller.signal, defer: (dispose: () => void | Promise<unknown>) => disposers.push(dispose) };
}

function stageRegistry(directory: string, entries: Record<string, { body: string; type: string }>) {
  mkdirSync(join(directory, "objects"), { recursive: true });
  const index: Record<string, RegistryEntry> = {};
  for (const [key, { body, type }] of Object.entries(entries)) {
    const digest = sha256(body);
    writeFileSync(join(directory, "objects", digest), body);
    index[key] = { status: 200, type, sha256: digest };
  }
  writeFileSync(join(directory, "index.json"), JSON.stringify(index));
}

function ownedRegistry(directory: string, originalIndexes?: readonly string[]) {
  const exists = fs.existsSync;
  const checked: string[] = [];
  const guard = spyOn(fs, "existsSync").mockImplementation(filename => {
    const path = String(filename);
    if (!path.startsWith(`${directory}/`)) throw new Error(`Unowned registry read ${path}`);
    checked.push(path);
    return exists(filename);
  });
  try {
    const mirror = nextRegistry(join(directory, "extra"), 0, join(directory, "overlay"), originalIndexes, join(directory, "shared"));
    expect(checked).toContain(join(directory, "shared", "index.json"));
    return mirror;
  } finally { guard.mockRestore(); }
}

test("composed registry replays only the exact advisory POST and preserves GET integrity", async () => {
  const fixture = replayFixture("advisory-replay-");
  const { directory } = fixture;
  try {
    const extra = join(directory, "extra");
    const overlay = join(directory, "overlay");
    const advisory = '{"next":[{"id":123,"severity":"high","title":"Fixture advisory"}]}';
    const tarball = "checksum-verified tarball";
    stageRegistry(join(directory, "shared"), { "/borrowed.tgz": { body: "borrowed tarball", type: "application/octet-stream" }, "/pkg/-/pkg.tgz": { body: "shadowed tarball", type: "application/octet-stream" } });
    stageRegistry(extra, { "/pkg/-/pkg.tgz": { body: tarball, type: "application/octet-stream" } });
    stageRegistry(overlay, { [`POST ${path} ${sha256(body)}`]: { body: advisory, type: "application/json" } });
    const mirror = ownedRegistry(directory);
    fixture.defer(() => mirror.close());
    const base = mirror.base;
    const post = (target: string, payload: string, method = "POST") => fixture.response(`${base}${target}`, { method, body: payload, headers: { "content-type": "application/json" } });
    const response = await post(path, body);
    expect(response.status).toBe(200);
    expect(response.body).toBe(advisory);
    const mismatches: [string, string, string][] = [[path, `${body} `, "POST"], [path, body, "PUT"], [`${path}/`, body, "POST"], [`${path}?x=1`, body, "POST"]];
    for (const [target, payload, method] of mismatches) {
      expect((await post(target, payload, method)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fixture.response(`${base}${path}`)).status).toBeGreaterThanOrEqual(400);
    expect((await fixture.response(`${base}/pkg/-/pkg.tgz`)).body).toBe(tarball);
    expect((await fixture.response(`${base}/borrowed.tgz`)).body).toBe("borrowed tarball");
    expect((await post("/pkg/-/pkg.tgz", body)).status).toBeGreaterThanOrEqual(400);
    writeFileSync(join(extra, "objects", sha256(tarball)), "corrupt");
    expect((await fixture.response(`${base}/pkg/-/pkg.tgz`)).status).toBe(502);
    writeFileSync(join(overlay, "objects", sha256(advisory)), "corrupt");
    expect((await post(path, body)).status).toBe(502);
  } finally { await fixture.close(); }
});

const fixture = fileURLToPath(new URL("./fixtures/next-advisory/", import.meta.url));

test("owned registry inputs still verify every original index and object before serving", async () => {
  const scope = replayFixture("advisory-integrity-");
  try {
    const roots = ["shared", "extra", "overlay"].map(name => join(scope.directory, name));
    for (const root of roots) stageRegistry(root, { "/pkg": { body: "object", type: "application/json" } });
    const originals = roots.map(root => sha256(readFileSync(join(root, "index.json"), "utf8")));
    const mirror = ownedRegistry(scope.directory, originals);
    scope.defer(() => mirror.close());
    for (const root of roots) {
      const index = join(root, "index.json");
      const text = readFileSync(index, "utf8");
      writeFileSync(index, `${text}\n`);
      expect(() => ownedRegistry(scope.directory, originals)).toThrow("Original replay index mismatch");
      writeFileSync(index, text);
      const object = join(root, "objects", sha256("object"));
      writeFileSync(object, "corrupt");
      expect(() => ownedRegistry(scope.directory, originals)).toThrow("Replay digest mismatch");
      rmSync(object);
      expect(() => ownedRegistry(scope.directory, originals)).toThrow("Missing replay object");
      writeFileSync(object, "object");
      writeFileSync(index, '{"/pkg":{"sha256":"invalid","status":200,"type":"application/json"}}');
      expect(() => ownedRegistry(scope.directory)).toThrow("Invalid registry entry");
      writeFileSync(index, text);
    }
    expect(() => ownedRegistry(scope.directory, originals.slice(1))).toThrow("Original replay index selection mismatch");
  } finally { await scope.close(); }
});

test("fixture teardown aborts and drains pending bodies before the next fetch mock", async () => {
  const scope = replayFixture("advisory-teardown-");
  const started = Promise.withResolvers<void>();
  const mirror = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("unfinished body"));
    started.resolve();
  } })) });
  scope.defer(() => mirror.stop(true));
  try {
    const result = scope.response(`http://127.0.0.1:${mirror.port}`).then(() => "finished", () => "aborted");
    await started.promise;
    await scope.close();
    expect(await result).toBe("aborted");
    expect(mirror.pendingRequests).toBe(0);
    const network = spyOn(globalThis, "fetch");
    try {
      await expect(scope.response("http://127.0.0.1:1")).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  } finally { await scope.close(); }
});

async function browserPost(scope: ReturnType<typeof replayFixture>, mirror: string, payload: string, target = `https://registry.npmjs.org${path}`, method = "POST") {
  scope.signal.throwIfAborted();
  const client = await request.newContext();
  scope.defer(() => client.dispose());
  const external: string[] = [];
  let fulfilled: { status: number; body: string } | undefined;
  let aborted = false;
  const requests: string[] = [];
  try {
    scope.signal.throwIfAborted();
    await browserRegistryRoute({
      request: () => ({ url: () => target, method: () => method, headers: () => ({ "content-type": "application/json", authorization: "must-not-forward", cookie: "must-not-forward" }), postDataBuffer: () => Buffer.from(payload) }),
      fetch: async (options: Parameters<Route["fetch"]>[0] = {}) => {
        scope.signal.throwIfAborted();
        if (!options.url?.startsWith(`${mirror}/`)) throw new Error("Replay escaped loopback");
        expect(options.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
        requests.push(options.url);
        return client.fetch(options.url, { ...options, data: options.postData });
      },
      fulfill: async options => {
        if (!options?.response) throw new Error("Missing replay response");
        fulfilled = { status: options.response.status(), body: await options.response.text() };
      },
      abort: async () => { aborted = true; },
      continue: async () => { throw new Error("External request continued"); },
    }, mirror, external);
    return { external, fulfilled, aborted, requests };
  } finally { await client.dispose(); }
}

test("browser replay is offline, preserves captured bytes, and fails closed on every mismatch", async () => {
  const scope = replayFixture("advisory-offline-");
  try {
    for (const root of ["shared", "extra"]) stageRegistry(join(scope.directory, root), {});
    cpSync(fixture, join(scope.directory, "overlay"), { recursive: true });
    const mirror = ownedRegistry(scope.directory);
    const offline = Object.assign(() => { throw new Error("Replay attempted live fetch"); }, { preconnect: globalThis.fetch.preconnect });
    const network = spyOn(globalThis, "fetch").mockImplementation(offline);
    scope.defer(() => { network.mockRestore(); });
    scope.defer(() => mirror.close());
    const replay = await browserPost(scope, mirror.base, body);
    expect(replay).toMatchObject({ fulfilled: { status: 200, body: "{}" }, aborted: false, external: [] });
    const mismatches: [string, string, string][] = [
      [`https://registry.npmjs.org${path}`, `${body} `, "POST"],
      [`https://registry.npmjs.org${path}`, body, "GET"],
      [`https://registry.npmjs.org${path}`, body, "PUT"],
      [`https://registry.npmjs.org${path}?query=1`, body, "POST"],
      [`https://registry.npmjs.org${path}/`, body, "POST"],
      [`https://registry.npmjs.org.evil.invalid${path}`, body, "POST"],
    ];
    for (const [target, payload, method] of mismatches) {
      const rejected = await browserPost(scope, mirror.base, payload, target, method);
      expect(rejected.aborted).toBe(true);
      expect(rejected.fulfilled).toBeUndefined();
      expect(rejected.external).toEqual([target]);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { await scope.close(); }
});

test("recording forwards exact advisory bytes through the Unix broker and replays without it", async () => {
  const scope = replayFixture("advisory-record-");
  const { directory } = scope;
  const previous = process.env.MATRIX_RECORDER_SOCKET;
  const socket = join(directory, "broker.sock");
  const received: { method: string; path: string; body: string }[] = [];
  const broker = Bun.serve({ unix: socket, async fetch(request) {
    received.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
    return new Response('{"error":"authoritative non-success"}', { status: 429, headers: { "content-type": "application/json" } });
  } });
  let mirror: Awaited<ReturnType<typeof registry>> | undefined;
  scope.defer(() => {
    if (previous === undefined) delete process.env.MATRIX_RECORDER_SOCKET;
    else process.env.MATRIX_RECORDER_SOCKET = previous;
  });
  scope.defer(() => broker.stop(true));
  scope.defer(() => mirror?.close());
  try {
    process.env.MATRIX_RECORDER_SOCKET = socket;
    mirror = await registry({ directory, record: true });
    const recorded = await browserPost(scope, mirror.base, body);
    expect(recorded.fulfilled).toEqual({ status: 429, body: '{"error":"authoritative non-success"}' });
    expect(received).toEqual([{ method: "POST", path, body }]);
    await mirror.close();
    await broker.stop(true);
    delete process.env.MATRIX_RECORDER_SOCKET;
    mirror = await registry({ directory, record: false });
    expect((await browserPost(scope, mirror.base, body)).fulfilled).toEqual(recorded.fulfilled);
    expect((await browserPost(scope, mirror.base, `${body} `)).aborted).toBe(true);
    expect(received).toHaveLength(1);
    const entries = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
    expect(Object.keys(entries)).toEqual([`POST ${path} ${sha256(body)}`]);
  } finally { await scope.close(); }
});

test("the public broker preserves POST identity and never forwards supplied credentials", async () => {
  const calls: { url: string; method: string | undefined; body: string; headers: Headers }[] = [];
  const upstream = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), method: options?.method, body: Buffer.from(options?.body instanceof Uint8Array ? options.body : []).toString(), headers: new Headers(options?.headers) });
    return Response.json({ next: [{ id: 1 }] }, { status: 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  const network = spyOn(globalThis, "fetch").mockImplementation(upstream);
  try {
    const response = await registryBrokerResponse(new Request(`http://recorder${path}`, { method: "POST", body, headers: { "content-type": "application/json", authorization: "secret", cookie: "secret" } }));
    expect(await response.json()).toEqual({ next: [{ id: 1 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://registry.npmjs.org${path}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(body);
    const call = calls[0];
    if (!call) throw new Error("Missing public request");
    expect(Array.from(call.headers)).toEqual([["accept", "application/json"], ["content-type", "application/json"]]);
    for (const [target, method] of [[path, "PUT"], [path, "GET"], [`${path}?x=1`, "POST"], ["/other", "POST"]]) {
      const response = await registryBrokerResponse(new Request(`http://recorder${target}`, { method, ...(method === "GET" ? {} : { body }), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(502);
    }
    expect(calls).toHaveLength(1);
  } finally { network.mockRestore(); }
});

test("advisory request and response bodies are bounded before recording or replay", async () => {
  const incoming = (body: string, headers = { "content-type": "application/json" }) => new Request(`http://recorder${path}`, { method: "POST", body, headers });
  await expect(registryIdentity(incoming("x".repeat(advisoryBodyLimit + 1)))).rejects.toThrow("exceeds limit");
  await expect(registryIdentity(incoming("{}"))).rejects.toThrow("Invalid advisory packages");
  await expect(registryIdentity(incoming('{"next":[1]}'))).rejects.toThrow("Invalid advisory versions");
  await expect(boundedRegistryBody(new Response("x".repeat(advisoryResponseLimit + 1)), advisoryResponseLimit)).rejects.toThrow("exceeds limit");
  await expect(boundedRegistryBody(new Response("small", { headers: { "content-length": String(advisoryResponseLimit + 1) } }), advisoryResponseLimit)).rejects.toThrow("exceeds limit");
});
