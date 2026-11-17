import { expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { IphoneBus } from "./iphone-bus";
import { controlResponse, observeIphoneResponse, recordServed } from "./iphone-server";
import { decodedSha256, liveSiteURL, proxyLiveRequest, type LiveServed } from "./iphone-live-proxy";

const site = "https://bun.sprockt.dev/";
const loopback = "http://127.0.0.1:4000";
type Seen = { url: string; headers: Headers; decompress: unknown };
function upstreamOf(reply: (url: string) => Response, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit & { decompress?: boolean }) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), decompress: init?.decompress });
    return reply(String(input));
  }) as typeof fetch;
}
function recorder(): { rows: LiveServed[]; record(row: LiveServed): void; next: Promise<LiveServed> } {
  const rows: LiveServed[] = [];
  const { promise, resolve } = Promise.withResolvers<LiveServed>();
  return { rows, next: promise, record: row => { rows.push(row); resolve(row); } };
}

test("assets reach Safari with the origin's own encoding, length and bytes", async () => {
  const text = "export const deployed = 1;\n".repeat(200);
  const encoded = brotliCompressSync(Buffer.from(text));
  const seen: Seen[] = [], recorded = recorder();
  const upstream = upstreamOf(() => new Response(encoded, { headers: { "content-type": "text/javascript", "content-encoding": "br", "content-length": String(encoded.byteLength), "cache-control": "public, max-age=0, must-revalidate" } }), seen);
  const request = new Request(loopback + "/playground/main.js?x=1", { headers: { "accept-encoding": "gzip, deflate, br", "user-agent": "iPhone Safari", origin: loopback, "sec-fetch-mode": "cors" } });
  const response = await proxyLiveRequest(request, site, upstream, recorded.record);
  expect(seen[0]).toMatchObject({ url: site + "playground/main.js?x=1", decompress: false });
  expect(seen[0]?.headers.get("accept-encoding")).toBe("gzip, deflate, br");
  expect(seen[0]?.headers.has("origin")).toBe(false);
  expect(response.headers.get("content-encoding")).toBe("br");
  expect(response.headers.get("content-length")).toBe(String(encoded.byteLength));
  expect(Buffer.from(await response.bytes()).equals(encoded)).toBe(true);
  expect(await recorded.next).toEqual({ url: "/playground/main.js?x=1", status: 200,
    request: { "accept-encoding": "gzip, deflate, br", "user-agent": "iPhone Safari", "sec-fetch-mode": "cors" },
    headers: { "content-type": "text/javascript", "content-encoding": "br", "cache-control": "public, max-age=0, must-revalidate" },
    sha256: decodedSha256(new TextEncoder().encode(text), null) });
});

test("navigations ask the origin for identity, and the observer injects without adding isolation", async () => {
  const seen: Seen[] = [], recorded = recorder();
  const upstream = upstreamOf(() => new Response("<!doctype html><html><body>deployed</body></html>", { headers: { "content-type": "text/html", "cross-origin-opener-policy": "same-origin", "cache-control": "no-store" } }), seen);
  const bus = new IphoneBus("/__goals_iphone/" + "a".repeat(64));
  const url = loopback + "/playground/?template=vite-react";
  bus.configure("host", url);
  const request = new Request(url, { headers: { "accept-encoding": "gzip, deflate, br", "sec-fetch-mode": "navigate" } });
  const response = await observeIphoneResponse(await proxyLiveRequest(request, site, upstream, recorded.record), request, bus, "http://127.0.0.1:4001", { addIsolation: false });
  expect(seen[0]?.headers.get("accept-encoding")).toBe("identity");
  expect(await response.text()).toContain("installIphoneObserver");
  expect(response.headers.has("cross-origin-embedder-policy")).toBe(false);
  expect(response.headers.has("cross-origin-resource-policy")).toBe(false);
  expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect((await recorded.next).headers).toEqual({ "content-type": "text/html", "cross-origin-opener-policy": "same-origin", "cache-control": "no-store" });
});

test("local mode still fills in missing isolation headers on injected pages", async () => {
  const bus = new IphoneBus("/__goals_iphone/" + "a".repeat(64));
  const url = loopback + "/?template=vite-react";
  bus.configure("host", url);
  const request = new Request(url, { headers: { "sec-fetch-mode": "navigate" } });
  const response = await observeIphoneResponse(new Response("<html><body>local</body></html>", { headers: { "content-type": "text/html" } }), request, bus, "http://127.0.0.1:4001");
  expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
});

test("service workers ask for identity; conditional and ranged requests pass through unrecorded", async () => {
  const seen: Seen[] = [], recorded = recorder();
  const upstream = upstreamOf(url => url.endsWith("sw.js") ? new Response("self.addEventListener('fetch', () => {});", { headers: { "content-type": "text/javascript", "service-worker-allowed": "/playground/__bunwasm/" } })
    : new Response(null, { status: 304, headers: { etag: "\"tag\"" } }), seen);
  await (await proxyLiveRequest(new Request(loopback + "/playground/sw.js", { headers: { "accept-encoding": "br" } }), site, upstream, recorded.record)).text();
  expect(seen[0]?.headers.get("accept-encoding")).toBe("identity");
  expect((await recorded.next).headers["service-worker-allowed"]).toBe("/playground/__bunwasm/");
  const cached = await proxyLiveRequest(new Request(loopback + "/playground/main.js", { headers: { "if-none-match": "\"tag\"" } }), site, upstream, recorded.record);
  expect(cached.status).toBe(304);
  expect(seen[1]?.headers.get("if-none-match")).toBe("\"tag\"");
  await proxyLiveRequest(new Request(loopback + "/playground/a.wasm", { headers: { range: "bytes=0-9" } }), site, upstream, recorded.record);
  expect(recorded.rows.map(row => row.url)).toEqual(["/playground/sw.js"]);
});

test("redirects stay on loopback and the base URL is a bare https site root", async () => {
  const upstream = upstreamOf(() => new Response(null, { status: 307, headers: { location: "/playground/?a=1" } }), []);
  const moved = await proxyLiveRequest(new Request(loopback + "/playground"), site, upstream);
  expect(moved.status).toBe(307);
  expect(moved.headers.get("location")).toBe(loopback + "/playground/?a=1");
  expect(() => liveSiteURL("https://bun.sprockt.dev/playground/")).toThrow();
  expect(liveSiteURL(site)).toBe(site);
});

test("the control port lists served responses only to the controller, once per URL and encoding", async () => {
  const bus = new IphoneBus("/__goals_iphone/" + "a".repeat(64));
  const served: LiveServed[] = [];
  const record = recordServed(served);
  const row: LiveServed = { url: "/playground/", request: { "accept-encoding": "identity" }, status: 200, headers: {}, sha256: "0".repeat(64) };
  record(row); record({ ...row, sha256: "1".repeat(64) }); record({ ...row, request: { "accept-encoding": "br" } });
  expect(served.map(value => value.request["accept-encoding"])).toEqual(["identity", "br"]);
  const path = "http://127.0.0.1:4001" + bus.path + "/live/served";
  expect(await (await controlResponse(new Request(path), bus, loopback, served)).json()).toEqual(served);
  expect((await controlResponse(new Request(path, { headers: { origin: loopback } }), bus, loopback, served)).status).toBe(403);
  expect((await controlResponse(new Request(path), bus, loopback)).status).not.toBe(200);
});
