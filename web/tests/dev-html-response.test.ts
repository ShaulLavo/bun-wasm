import { expect, test } from "bun:test";
import { developmentFixture } from "./fixtures/dev-html-browser";

const html = '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body><h1>Before</h1><button disabled id="counter">Count</button><output id="value">0</output></body></html>';
async function setup() {
  const fixture = await developmentFixture();
  const source = fixture.createSource();
  const stamp = source.stamp(1);
  source.commit(stamp);
  const upgrades: unknown[] = [];
  const server = { port: 5173, upgrade(_request: Request, options: unknown) { upgrades.push(options); return true; } };
  const adapter = fixture.adapt.attach({ server, revisions: source.source });
  const request = (path = "/", init?: RequestInit) => new Request(`http://localhost:5173${path}`, init);
  const response = (body: ConstructorParameters<typeof Response>[0] = html, headers: HeadersInit = { "content-type": "text/html" }) => new fixture.GuestResponse(body, { headers });
  return { ...fixture, source, stamp, adapter, request, response, upgrades, server };
}

test("eligible buffered guest HTML enrolls once, escapes author data and states UTF-8", async () => {
  const f = await setup();
  try {
    const input = f.response(html.replace("Before", "שלום é </script> & >\u2028"));
    const decorated = await f.adapter.decorate(f.request(), input, f.stamp);
    const text = await decorated.text();
    expect(text).toContain('data-bun-wasm-dev="config"');
    expect(text).toContain('data-bun-wasm-dev="client"');
    expect(text).toContain('\\u003c/script\\u003e');
    expect(text).toContain('\\u0026');
    expect(decorated.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(decorated.headers.get("cache-control")).toBe("no-store");
    expect(input.bodyUsed).toBe(false);
    const script = f.adapter.respond(f.request(`/_bun/wasm-dev/${f.stamp.server}/client.js`));
    expect(await script.text()).toBe(f.client);
  } finally { f.adapter.dispose(); f.source.close(); }
});

test("exact guest cookie multiplicity survives decoration and serialization pairs", async () => {
  const f = await setup();
  try {
    const input = f.response(html, [["content-type", "text/html"], ["set-cookie", "a=1; HttpOnly"], ["set-cookie", "b=2; Path=/"], ["content-length", "19"], ["etag", '"old"'], ["last-modified", "yesterday"], ["cross-origin-opener-policy", "same-origin"]]);
    const output: Response = await f.adapter.decorate(f.request(), input, f.stamp);
    expect(Array.from(output.headers).filter(([name]) => name === "set-cookie")).toEqual([["set-cookie", "a=1; HttpOnly"], ["set-cookie", "b=2; Path=/"]]);
    expect(output.headers.has("content-length")).toBe(false);
    expect(output.headers.has("etag")).toBe(false);
    expect(output.headers.has("last-modified")).toBe(false);
    expect(output.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  } finally { f.adapter.dispose(); f.source.close(); }
});

const excluded: [string, string, HeadersInit, RequestInit?][] = [
  ["CSP header", html, { "content-type": "text/html", "content-security-policy": "default-src 'self'" }],
  ["CSP meta", html.replace("<title>", '<meta http-equiv="Content-Security-Policy" content="default-src none"><title>'), { "content-type": "text/html" }],
  ["refresh", html.replace("<title>", '<meta http-equiv="refresh" content="1"><title>'), { "content-type": "text/html" }],
  ["base", html.replace("<title>", '<base href="/"><title>'), { "content-type": "text/html" }],
  ["encoded", html, { "content-type": "text/html", "content-encoding": "gzip" }],
  ["legacy charset", html, { "content-type": "text/html; charset=windows-1252" }],
  ["legacy meta charset", html.replace("utf-8", "windows-1252"), { "content-type": "text/html" }],
  ["JSON", html, { "content-type": "application/json" }],
  ["attachment", html, { "content-type": "text/html", "content-disposition": "attachment" }],
  ["HEAD", html, { "content-type": "text/html" }, { method: "HEAD" }],
  ["range", html, { "content-type": "text/html" }, { headers: { range: "bytes=1-2" } }],
  ["config collision", html.replace("<title>", '<script data-bun-wasm-dev="config"></script><title>'), { "content-type": "text/html" }],
  ["shim collision", html.replace("<title>", '<script data-bun-wasm-socket="shim"></script><title>'), { "content-type": "text/html" }],
];
for (const [name, body, headers, init] of excluded) {
  test(`${name} passes through byte/header/body identity unchanged`, async () => {
    const f = await setup();
    try {
      const response = f.response(body, headers);
      expect(await f.adapter.decorate(f.request("/", init), response, f.stamp)).toBe(response);
      expect(response.bodyUsed).toBe(false);
    } finally { f.adapter.dispose(); f.source.close(); }
  });
}

test("application streams pass before locking or EOF, and the real writer cancels them", async () => {
  const f = await setup();
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>first")); }, cancel() { canceled++; } });
  try {
    const input = f.response(stream);
    expect(await f.adapter.decorate(f.request(), input, f.stamp)).toBe(input);
    expect(stream.locked).toBe(false);
    const chunks: Uint8Array[] = [];
    let first = () => {};
    const firstChunk = new Promise<void>(resolve => { first = resolve; });
    const connection: { closed: boolean; readEnded: boolean; onClose?: (() => void) | null; onEnd?: (() => void) | null; write(chunk: Uint8Array, done?: (error?: unknown) => void): void; destroy(): void } = {
      closed: false, readEnded: false, onClose: undefined, onEnd: undefined,
      write(chunk: Uint8Array, done?: (error?: unknown) => void) { chunks.push(chunk); done?.(); if (new TextDecoder().decode(chunk).includes("<html>first")) first(); },
      destroy() { this.closed = true; this.onClose?.(); },
    };
    const output = f.writer.writeResponse(connection, input, "GET", false, () => new Uint8Array(), () => {});
    try { await firstChunk; }
    finally { connection.destroy(); await output; }
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("<html>first");
    expect(stream.locked).toBe(false);
    expect(canceled).toBe(1);
  } finally { f.adapter.dispose(); f.source.close(); await stream.cancel().catch(() => {}); }
});

test("oversize, malformed UTF-8, abort and non-200 bodies are never consumed", async () => {
  const f = await setup();
  const controller = new AbortController();
  controller.abort();
  try {
    const bodies = [f.response("x".repeat(256 * 1024 + 1)), f.response(new Uint8Array([0xc0, 0xaf])), new f.GuestResponse(html, { status: 500, headers: { "content-type": "text/html" } })];
    for (const body of bodies) expect(await f.adapter.decorate(f.request(), body, f.stamp)).toBe(body);
    const aborted = f.response();
    expect(await f.adapter.decorate(f.request("/", { signal: controller.signal }), aborted, f.stamp)).toBe(aborted);
  } finally { f.adapter.dispose(); f.source.close(); }
});

test("raw GET carries its immutable request stamp, policy and cookies without recursive injection", async () => {
  const f = await setup();
  try {
    f.source.commit(f.source.stamp(3));
    const output: Response = await f.adapter.decorate(f.request("/path?q=1", { headers: { "x-bun-wasm-dev-raw": "1" } }), f.response(), f.stamp);
    expect(await output.text()).toBe(html);
    expect(JSON.parse(output.headers.get("x-bun-wasm-dev-stamp")!)).toEqual(f.stamp);
    expect(JSON.parse(output.headers.get("x-bun-wasm-dev-policy")!)).toEqual(Array(6).fill(null));
  } finally { f.adapter.dispose(); f.source.close(); }
});

test("private origins require exact scheme, host and effective port; disposed adapters have no endpoints", async () => {
  const f = await setup();
  try {
    const endpoint = `/_bun/wasm-dev/${f.stamp.server}/events`;
    for (const origin of ["http://evil.example", "http://localhost:5174", "https://localhost:5173", "null"]) {
      const request = f.request(endpoint, { headers: { origin } });
      expect(f.adapter.upgrade(request)).toBe(false);
      expect(f.adapter.respond(request).status).toBe(403);
    }
    expect(f.adapter.upgrade(f.request(endpoint, { headers: { origin: "http://localhost:5173" } }))).toBe(true);
    expect(f.upgrades).toHaveLength(1);
    f.adapter.dispose();
    f.adapter.dispose();
    expect(f.adapter.respond(f.request(endpoint))).toBe(null);
    const input = f.response();
    expect(await f.adapter.decorate(f.request(), input, f.stamp)).toBe(input);
  } finally { f.adapter.dispose(); f.source.close(); }
});

test("private sockets use atomic revision snapshots, bounded sends, no client commands and one cleanup", async () => {
  const f = await setup();
  const payloads: string[] = [];
  let terminated = 0;
  const request = f.request(`/_bun/wasm-dev/${f.stamp.server}/events`, { headers: { origin: "http://localhost:5173" } });
  try {
    f.adapter.upgrade(request);
    const upgrade = f.upgrades[0];
    if (!upgrade || typeof upgrade !== "object" || !("data" in upgrade)) throw new Error("Missing upgrade identity");
    const socket = { data: upgrade.data, bufferedAmount: 0, send(data: string) { payloads.push(data); return data.length; }, terminate() { terminated++; } };
    const handlers = f.adapter.websocket(undefined);
    expect(handlers.maxPayloadLength).toBe(1024);
    handlers.open(socket);
    expect(payloads.map(value => JSON.parse(value))).toEqual([{ kind: "committed", stamp: f.stamp }]);
    f.source.commit(f.source.stamp(4));
    expect(payloads.map(value => JSON.parse(value).stamp.revision)).toEqual([1, 4]);
    socket.bufferedAmount = 4096;
    f.source.commit(f.source.stamp(5));
    expect(terminated).toBe(1);
    handlers.close(socket, 1000, "done");
    f.source.commit(f.source.stamp(6));
    expect(payloads).toHaveLength(2);
    f.adapter.dispose();
    expect(terminated).toBe(1);
  } finally { f.adapter.dispose(); f.source.close(); }
});

test("unmarked application socket handlers and configured frame limits delegate unchanged", async () => {
  const f = await setup();
  const calls: string[] = [];
  const handlers = f.adapter.websocket({ maxPayloadLength: 9999, open() { calls.push("open"); }, message() { calls.push("message"); }, ping() { calls.push("ping"); }, pong() { calls.push("pong"); }, error() { calls.push("error"); }, close() { calls.push("close"); }, drain() { calls.push("drain"); } });
  try {
    const socket = { data: {} };
    handlers.open(socket); handlers.message(socket, "hi"); handlers.ping(socket, new Uint8Array()); handlers.pong(socket, new Uint8Array()); handlers.error(socket, new Error("test")); handlers.close(socket, 1000, ""); handlers.drain(socket);
    expect(handlers.maxPayloadLength).toBe(9999);
    expect(calls).toEqual(["open", "message", "ping", "pong", "error", "close", "drain"]);
  } finally { f.adapter.dispose(); f.source.close(); }
});
