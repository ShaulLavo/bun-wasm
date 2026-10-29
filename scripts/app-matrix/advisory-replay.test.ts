import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextRegistry } from "../../web/tests/next-framework-registry";
import { request, type Route } from "playwright";
import { registry } from "./registry.mjs";
import { browserRegistryRoute, registryBrokerResponse } from "./registry-request";
import { advisoryBodyLimit, advisoryResponseLimit, boundedRegistryBody, registryIdentity } from "./registry-identity";

const path = "/-/npm/v1/security/advisories/bulk";
const body = '{"next":["16.4.3"]}';
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

test("composed registry replays only the exact advisory POST and preserves GET integrity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "advisory-replay-"));
  let mirror: ReturnType<typeof nextRegistry> | undefined;
  try {
    const extra = join(directory, "extra");
    const overlay = join(directory, "overlay");
    for (const root of [extra, overlay]) mkdirSync(join(root, "objects"), { recursive: true });
    const advisory = '{"next":[{"id":123,"severity":"high","title":"Fixture advisory"}]}';
    const tarball = "checksum-verified tarball";
    writeFileSync(join(extra, "objects", sha256(tarball)), tarball);
    writeFileSync(join(extra, "index.json"), JSON.stringify({ "/pkg/-/pkg.tgz": { status: 200, type: "application/octet-stream", sha256: sha256(tarball) } }));
    writeFileSync(join(overlay, "objects", sha256(advisory)), advisory);
    writeFileSync(join(overlay, "index.json"), JSON.stringify({ [`POST ${path} ${sha256(body)}`]: { status: 200, type: "application/json", sha256: sha256(advisory) } }));
    mirror = nextRegistry(extra, 0, overlay);
    const base = mirror.base;
    const post = (target: string, payload: string, method = "POST") => fetch(`${base}${target}`, { method, body: payload, headers: { "content-type": "application/json" } });
    const response = await post(path, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(advisory);
    const mismatches: [string, string, string][] = [[path, `${body} `, "POST"], [path, body, "PUT"], [`${path}/`, body, "POST"], [`${path}?x=1`, body, "POST"]];
    for (const [target, payload, method] of mismatches) {
      expect((await post(target, payload, method)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fetch(`${mirror.base}${path}`)).status).toBeGreaterThanOrEqual(400);
    expect(await (await fetch(`${mirror.base}/pkg/-/pkg.tgz`)).text()).toBe(tarball);
    expect((await post("/pkg/-/pkg.tgz", body)).status).toBeGreaterThanOrEqual(400);
    writeFileSync(join(extra, "objects", sha256(tarball)), "corrupt");
    expect((await fetch(`${mirror.base}/pkg/-/pkg.tgz`)).status).toBe(502);
    writeFileSync(join(overlay, "objects", sha256(advisory)), "corrupt");
    expect((await post(path, body)).status).toBe(502);
  } finally { await mirror?.close(); rmSync(directory, { recursive: true, force: true }); }
});

const fixture = fileURLToPath(new URL("./fixtures/next-advisory/", import.meta.url));

async function browserPost(mirror: string, payload: string, target = `https://registry.npmjs.org${path}`, method = "POST") {
  const client = await request.newContext();
  const external: string[] = [];
  let fulfilled: { status: number; body: string } | undefined;
  let aborted = false;
  const requests: string[] = [];
  try {
    await browserRegistryRoute({
      request: () => ({ url: () => target, method: () => method, headers: () => ({ "content-type": "application/json", authorization: "must-not-forward", cookie: "must-not-forward" }), postDataBuffer: () => Buffer.from(payload) }),
      fetch: async (options: Parameters<Route["fetch"]>[0] = {}) => {
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
  const directory = mkdtempSync(join(tmpdir(), "advisory-offline-"));
  const mirror = nextRegistry(directory, 0, fixture);
  const offline = Object.assign(() => { throw new Error("Replay attempted live fetch"); }, { preconnect: globalThis.fetch.preconnect });
  const network = spyOn(globalThis, "fetch").mockImplementation(offline);
  try {
    const replay = await browserPost(mirror.base, body);
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
      const rejected = await browserPost(mirror.base, payload, target, method);
      expect(rejected.aborted).toBe(true);
      expect(rejected.fulfilled).toBeUndefined();
      expect(rejected.external).toEqual([target]);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); await mirror.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("recording forwards exact advisory bytes through the Unix broker and replays without it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "advisory-record-"));
  const previous = process.env.MATRIX_RECORDER_SOCKET;
  const socket = join(directory, "broker.sock");
  const received: { method: string; path: string; body: string }[] = [];
  const broker = Bun.serve({ unix: socket, async fetch(request) {
    received.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
    return new Response('{"error":"authoritative non-success"}', { status: 429, headers: { "content-type": "application/json" } });
  } });
  let mirror: Awaited<ReturnType<typeof registry>> | undefined;
  try {
    process.env.MATRIX_RECORDER_SOCKET = socket;
    mirror = await registry({ directory, record: true });
    const recorded = await browserPost(mirror.base, body);
    expect(recorded.fulfilled).toEqual({ status: 429, body: '{"error":"authoritative non-success"}' });
    expect(received).toEqual([{ method: "POST", path, body }]);
    await mirror.close();
    await broker.stop(true);
    delete process.env.MATRIX_RECORDER_SOCKET;
    mirror = await registry({ directory, record: false });
    expect((await browserPost(mirror.base, body)).fulfilled).toEqual(recorded.fulfilled);
    expect((await browserPost(mirror.base, `${body} `)).aborted).toBe(true);
    expect(received).toHaveLength(1);
    const entries = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
    expect(Object.keys(entries)).toEqual([`POST ${path} ${sha256(body)}`]);
  } finally {
    if (previous === undefined) delete process.env.MATRIX_RECORDER_SOCKET;
    else process.env.MATRIX_RECORDER_SOCKET = previous;
    await mirror?.close(); await broker.stop(true); rmSync(directory, { recursive: true, force: true });
  }
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
