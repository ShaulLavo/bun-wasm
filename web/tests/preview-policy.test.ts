import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildClassicWorker } from "../../scripts/browser-build";

let directory: string;
let source: string;
beforeAll(async () => {
  directory = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? process.env.TMPDIR ?? tmpdir(), "bun-wasm-preview-policy-"));
  const result = await buildClassicWorker(join(import.meta.dir, "../src/sw.ts"), directory, { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify("socket adapter") });
  expect(result.outputs).toHaveLength(1);
  source = await result.outputs[0]!.text();
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function worker(base: string, mount: string, contentType = "text/html", encoding?: string, upstream: Record<string, string> = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const cached = new Map<string, Response>();
  const requests: string[] = [];
  const cacheWrites: string[] = [];
  const scope = `${base}${mount}/`;
  const page = {
    id: "page-1",
    url: `${base}index.html`,
    postMessage(_ask: unknown, ports: MessagePort[]) {
      const port = ports[0]!;
      const headers = [["content-type", contentType]];
      if (encoding) headers.push(["content-encoding", encoding]);
      port.postMessage({ type: "head", status: 200, statusText: "OK", headers });
      port.postMessage({ type: "data", chunk: new TextEncoder().encode("<!doctype html><html>preview</html>") });
      port.postMessage({ type: "end" });
      port.close();
    },
  };
  const clients = { async matchAll() { return [page]; }, async get(id: string) { return id === page.id ? page : undefined; }, async claim() {} };
  runInNewContext(source, {
    self: { registration: { scope }, clients, async skipWaiting() {}, addEventListener(type: string, handler: (event: any) => void) { handlers.set(type, handler); } },
    location: { origin: new URL(base).origin },
    caches: {
      async match(request: Request) { return cached.get(request.url); },
      async open() { return {
        async match() { return undefined; },
        async put(request: Request | string) { cacheWrites.push(typeof request === "string" ? request : request.url); },
        async keys() { return []; },
      }; },
    },
    async fetch(request: Request | string) { requests.push(typeof request === "string" ? request : request.url); return new Response("app chunk", { headers: upstream }); },
    URL, Response, Request, Headers, ReadableStream, TextEncoder, TextDecoder, MessageChannel, Uint8Array, setTimeout, clearTimeout,
  });
  if (mount === "__preview") {
    handlers.get("message")?.({
      data: { type: "preview-register", route: "__unrouted__", port: 8123 },
      source: page,
      ports: [],
      waitUntil() {},
    });
  }
  return {
    cached, requests, cacheWrites,
    install() { handlers.get("install")!({}); },
    fetch(path: string, clientId = ""): Promise<Response> | undefined {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({ request: new Request(`${base}${path}`), clientId, respondWith(value: Response | Promise<Response>) { response = Promise.resolve(value); } });
      return response;
    },
  };
}

test("Bun service worker still builds as one standalone classic script", () => {
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).not.toMatch(/\bexport\s/);
});

for (const base of ["https://example.test/", "https://example.test/nested/app/"]) {
  test(`Bun module scope serves app files, never stored guest modules, at ${base}`, async () => {
    const sw = worker(base, "__bunwasm");
    sw.cached.set(`${base}__bunwasm/m/run/key`, new Response("cached module"));
    expect(await (await sw.fetch("__bunwasm/m/run/key"))?.text()).toBe("app chunk");
    const chunk = await sw.fetch("__bunwasm/chunks/shared.js");
    expect(await chunk?.text()).toBe("app chunk");
    expect(chunk?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(chunk?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(sw.requests).toEqual([`${base}m/run/key`, `${base}chunks/shared.js`]);
    expect(sw.fetch("unrelated.js")).toBeUndefined();
  });

  test(`Bun preview script injection and isolation headers stay consumer policy at ${base}`, async () => {
    const sw = worker(base, "__preview");
    const response = await sw.fetch("__preview/8123/page");
    expect(response?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response?.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const prefix = new URL(`${base}__preview/`).pathname;
    expect(await response?.text()).toBe(`<!doctype html><script src="${new URL(base).pathname}preview-websocket.js" data-bun-wasm-socket="shim" data-bun-port="8123" data-bun-prefix="${prefix}"></script><html>preview</html>`);
    const script = await sw.fetch("preview-websocket.js");
    expect(script?.headers.get("content-type")).toBe("text/javascript");
    expect(await script?.text()).toBe("socket adapter");
  });
}

test("Bun websocket script policy does not rewrite encoded or non-HTML responses", async () => {
  for (const [contentType, encoding] of [["application/json", undefined], ["text/html", "gzip"]]) {
    const sw = worker("https://example.test/", "__preview", contentType, encoding);
    const response = await sw.fetch("__preview/8123/");
    expect(await response?.text()).toBe("<!doctype html><html>preview</html>");
    expect(response?.headers.get("cross-origin-embedder-policy")).toBeNull();
  }
});


test("tools stay out of service-worker precaching and retain their fingerprint query", async () => {
  const sw = worker("https://example.test/nested/app/", "__bunwasm");
  sw.install();
  expect(sw.requests).toEqual([]);
  const response = await sw.fetch("__bunwasm/bun-tools.wasm.gz?v=expected-fingerprint");
  expect(response?.status).toBe(200);
  expect(sw.requests).toEqual(["https://example.test/nested/app/bun-tools.wasm.gz?v=expected-fingerprint"]);
  expect(sw.cacheWrites).toEqual([]);
});

test("module scope drops the native encoding headers of an upstream body fetch already decoded", async () => {
  const sw = worker("https://example.test/", "__bunwasm", undefined, undefined, { "content-type": "application/wasm", "content-encoding": "br", "content-length": "3", etag: "\"twin\"" });
  const response = await sw.fetch("__bunwasm/bun-tools.wasm?v=expected-fingerprint");
  expect(sw.requests).toEqual(["https://example.test/bun-tools.wasm?v=expected-fingerprint"]);
  expect(response?.headers.get("content-encoding")).toBeNull();
  expect(response?.headers.get("content-length")).toBeNull();
  expect(response?.headers.get("content-type")).toBe("application/wasm");
  expect(response?.headers.get("etag")).toBe("\"twin\"");
  expect(response?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(await response?.text()).toBe("app chunk");
});

test("mounted preview WebSocket closes when its peer MessagePort closes after upgrade", async () => {
  const { previewWebsocketScript } = await import("../preview-build.ts");
  const bundle = await previewWebsocketScript();
  const { runInNewContext } = await import("node:vm");
  const serverPorts: MessagePort[] = [];
  const fakeScript = {
    getAttribute(name: string) {
      if (name === "data-bun-port") return "8123";
      if (name === "data-bun-prefix") return "/__preview/";
      return null;
    },
  };
  const sandbox: Record<string, unknown> = {
    location: new URL("https://example.test/__preview/8123/"),
    document: { currentScript: fakeScript },
    navigator: {
      serviceWorker: {
        controller: {
          postMessage(_msg: unknown, transfer?: Transferable[]) {
            if (transfer?.[0]) serverPorts.push(transfer[0] as MessagePort);
          },
        },
      },
    },
    WebSocket: class NativeWs {},
    MessageChannel,
    TextEncoder,
    TextDecoder,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Headers,
    Blob,
    CloseEvent,
    MessageEvent,
    ErrorEvent,
    Event,
    EventTarget,
    DOMException,
    crypto,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    addEventListener() {},
    removeEventListener() {},
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  runInNewContext(bundle, sandbox);
  const PreviewWs = sandbox.WebSocket as new (url: string) => EventTarget & {
    readonly readyState: number;
    close(): void;
  };
  const ws = new PreviewWs("ws://example.test/__preview/8123/ws");
  const serverPort = serverPorts[0];
  expect(serverPort).toBeDefined();

  const upgradeKey = Promise.withResolvers<string>();
  const onRouterMessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "object" || event.data === null) return;
    if (Reflect.get(event.data, "type") !== "data") return;
    const chunk = Reflect.get(event.data, "chunk");
    if (!(chunk instanceof Uint8Array)) return;
    const match = /^sec-websocket-key:\s*(\S+)\r?$/im.exec(new TextDecoder().decode(chunk));
    if (match?.[1]) upgradeKey.resolve(match[1]);
  };
  serverPort!.onmessage = onRouterMessage;
  try {
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    serverPort!.postMessage({ type: "accepted" });
    const key = await upgradeKey.promise;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
    const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const response = new TextEncoder().encode(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    serverPort!.postMessage({ type: "data", chunk: response }, [response.buffer]);
    await opened.promise;
    expect(ws.readyState).toBe(1);

    const closed = Promise.withResolvers<void>();
    ws.addEventListener("close", () => closed.resolve(), { once: true });
    serverPort!.close();
    await closed.promise;
    expect(ws.readyState).toBe(3);
  } finally {
    ws.close();
    serverPort!.close();
  }
});
