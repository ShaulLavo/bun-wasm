import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { previewWebsocketScript } from "../preview-build";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let script: string;

beforeAll(async () => { script = await previewWebsocketScript(); });

interface PreviewSocket {
  readonly url: string;
  readonly protocol: string;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  close(code?: number, reason?: string): void;
}

type SocketConstructor = new(input: string | URL, protocols?: string | string[]) => PreviewSocket;
type RootOpen = { type: "open"; url: string; method: string; headers: [string, string][] };

class Tunnel {
  private readonly handshake = Promise.withResolvers<string>();
  private readonly opening = Promise.withResolvers<RootOpen>();
  private readonly ended = Promise.withResolvers<void>();
  private readonly pinged = new Set<() => void>();
  /** Pings received on a preview origin's socket, where this end plays the IDE tab. */
  pings = 0;
  answersPings = true;

  constructor(readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  get request(): Promise<string> { return this.handshake.promise; }
  get rootOpen(): Promise<RootOpen> { return this.opening.promise; }
  get end(): Promise<void> { return this.ended.promise; }

  /** Accepts the upgrade as the IDE tab does on a preview origin: from fields, not from raw bytes. */
  async acceptRoot(): Promise<void> {
    const open = await this.rootOpen;
    const key = open.headers.find(([name]) => name.toLowerCase() === "sec-websocket-key")?.[1];
    if (!key) throw new Error("Missing fixture handshake key");
    const accept = createHash("sha1").update(key + websocketGuid).digest("base64");
    this.port.postMessage({ type: "accepted" });
    this.port.postMessage({ type: "data", chunk: encoder.encode(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`) });
  }

  /** One unmasked text frame from the server. */
  sendText(text: string): void {
    this.port.postMessage({ type: "data", chunk: new Uint8Array([0x81, text.length].concat(Array.from(encoder.encode(text)))) });
  }

  async pingCount(count: number): Promise<void> {
    while (this.pings < count) await new Promise<void>(resolve => { const wake = () => { this.pinged.delete(wake); resolve(); }; this.pinged.add(wake); });
  }

  private ping(): void {
    this.pings++;
    if (this.answersPings) this.port.postMessage({ type: "pong" });
    for (const wake of Array.from(this.pinged)) wake();
  }

  async accept(protocol?: string): Promise<void> {
    const request = await this.request;
    const key = /^sec-websocket-key:\s*(\S+)\r?$/im.exec(request)?.[1];
    if (!key) throw new Error("Missing fixture handshake key");
    const accept = createHash("sha1").update(key + websocketGuid).digest("base64");
    const selected = protocol ? `sec-websocket-protocol: ${protocol}\r\n` : "";
    const response = `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n${selected}\r\n`;
    this.port.postMessage({ type: "data", chunk: encoder.encode(response) });
  }

  reject(): void { this.port.postMessage({ type: "error" }); }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "data" && "chunk" in message && message.chunk instanceof Uint8Array) {
      this.handshake.resolve(decoder.decode(message.chunk));
    }
    if (message.type === "open") this.opening.resolve(message as RootOpen);
    if (message.type === "ping") this.ping();
    if (message.type !== "end") return;
    this.ended.resolve();
    this.port.close();
  }
}

class PreviewFixture {
  readonly tunnels: Tunnel[] = [];
  readonly routes: unknown[] = [];
  readonly nativeCalls: { input: string; protocols: string | string[] }[] = [];
  readonly context: { WebSocket: SocketConstructor; [key: string]: unknown };
  private pagehide: (() => void) | null = null;
  /** The interval timers the script started, run by hand: `null` once cleared. */
  readonly intervals: ((() => void) | null)[] = [];

  /** `root`: the script runs as the page shim of a preview origin (preview-origin/page-shim.ts). */
  constructor(origin: string, previewPort: number, root = false) {
    const nativeCalls = this.nativeCalls;
    const attributes: Record<string, string> = root ? { "data-bunwasm-preview": "shim" } : { "data-bun-port": String(previewPort) };
    const NativeWebSocket = class extends EventTarget implements PreviewSocket {
      readonly url: string;
      readonly protocol = "";
      readyState = 0;
      onopen: ((event: Event) => unknown) | null = null;
      onmessage: ((event: MessageEvent) => unknown) | null = null;
      onerror: ((event: Event) => unknown) | null = null;
      onclose: ((event: CloseEvent) => unknown) | null = null;
      constructor(input: string | URL, protocols: string | string[] = []) {
        super();
        this.url = new URL(String(input), origin).href.replace(/^http/, "ws");
        nativeCalls.push({ input: String(input), protocols });
      }
      close(): void { this.readyState = 3; }
    };
    this.context = {
      WebSocket: NativeWebSocket,
      location: new URL(origin),
      document: { currentScript: { getAttribute: (name: string) => attributes[name] ?? null } },
      navigator: { serviceWorker: { controller: { postMessage: (message: unknown, transfer: MessagePort[]) => {
        this.routes.push(message);
        const port = transfer[0];
        if (!port) throw new Error("Missing fixture tunnel port");
        this.tunnels.push(new Tunnel(port));
      } } } },
      addEventListener: (type: string, listener: () => void) => { if (type === "pagehide") this.pagehide = listener; },
      URL, Headers, EventTarget, Event, MessageEvent, CloseEvent, ErrorEvent, DOMException, Blob,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, MessageChannel,
      crypto, btoa, setTimeout, clearTimeout, queueMicrotask,
    };
    // Only a preview origin's socket watches its peer. A mounted preview's script finds no interval timer at all.
    if (root) Object.assign(this.context, {
      setInterval: (run: () => void) => this.intervals.push(run),
      clearInterval: (id: number | undefined) => { if (id !== undefined) this.intervals[id - 1] = null; },
    });
    runInNewContext(script, this.context);
  }

  /** Lets every running interval timer fire once. */
  tick(): void {
    for (const run of this.intervals) run?.();
  }

  close(): void {
    this.pagehide?.();
    for (const tunnel of this.tunnels) tunnel.port.close();
  }
}

const fixtures: PreviewFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function fixture(origin: string, port: number, root = false): PreviewFixture {
  const value = new PreviewFixture(origin, port, root);
  fixtures.push(value);
  return value;
}

function opened(socket: PreviewSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Preview WebSocket failed to open"));
  });
}

function closed(socket: PreviewSocket): Promise<void> {
  return new Promise(resolve => { socket.onclose = () => resolve(); });
}

const authorities = [
  {
    name: "custom outer hostname",
    origin: "https://fxj6.sprockt.dev/",
    port: 5173,
    input: "wss://fxj6.sprockt.dev/?token=fixture",
    requestLine: "GET /?token=fixture HTTP/1.1",
    host: "fxj6.sprockt.dev",
  },
  {
    name: "loopback with a scoped path",
    origin: "http://localhost:3000/",
    port: 5173,
    input: "ws://127.0.0.1:5173/__preview/5173/socket?token=fixture",
    requestLine: "GET /socket?token=fixture HTTP/1.1",
    host: "127.0.0.1:5173",
  },
  {
    name: "IPv6 loopback",
    origin: "http://[::1]:3000/",
    port: 5173,
    input: "ws://[::1]:5173/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "[::1]:5173",
  },
  {
    name: "nondefault secure outer and virtual ports",
    origin: "https://fxj6.sprockt.dev:8443/",
    port: 4174,
    input: "wss://fxj6.sprockt.dev:8443/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "fxj6.sprockt.dev:8443",
  },
  {
    name: "secure outer port that is the plain transport default",
    origin: "https://fxj6.sprockt.dev:80/",
    port: 4174,
    input: "wss://fxj6.sprockt.dev:80/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "fxj6.sprockt.dev:80",
  },
  {
    name: "literal replacement characters in the visible authority",
    origin: "https://price$&.example:80/",
    port: 4174,
    input: "wss://price$&.example:80/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "price$&.example:80",
  },
  {
    name: "visible mounted preview with a different guest port",
    origin: "http://localhost:4179/__preview/3000/some/page?x=1",
    port: 3000,
    input: "ws://localhost:4179/__preview/3000/socket?token=fixture",
    requestLine: "GET /socket?token=fixture HTTP/1.1",
    host: "localhost:4179",
  },
  {
    name: "foreign document origin targeting the guest loopback",
    origin: "https://foreign.example/",
    port: 5173,
    input: "ws://localhost:5173/_bun/hmr",
    requestLine: "GET /_bun/hmr HTTP/1.1",
    host: "localhost:5173",
  },
];

for (const item of authorities) test(`preview upgrade preserves browser headers and guest routing for ${item.name}`, async () => {
  const preview = fixture(item.origin, item.port);
  const socket = new preview.context.WebSocket(item.input, ["fixture-hmr"]);
  expect(preview.tunnels).toHaveLength(1);
  expect(preview.routes).toEqual([{ type: "preview-socket", port: item.port }]);
  const tunnel = preview.tunnels[0]!;
  const request = await tunnel.request;
  expect(request).toStartWith(`${item.requestLine}\r\n`);
  expect(request.match(/^host:/gim)).toHaveLength(1);
  expect(request).toContain(`\r\nhost: ${item.host}\r\n`);
  expect(request.match(/^origin:/gim)).toHaveLength(1);
  expect(request).toContain(`\r\norigin: ${new URL(item.origin).origin}\r\n`);
  expect(request).toContain("\r\nsec-websocket-protocol: fixture-hmr\r\n");
  expect(socket.url).toBe(item.input);
  const open = opened(socket);
  await tunnel.accept("fixture-hmr");
  await open;
  expect(socket.protocol).toBe("fixture-hmr");
});

test("unrelated WebSockets retain the native constructor and never allocate a tunnel", () => {
  const preview = fixture("https://fxj6.sprockt.dev/", 5173);
  const socket = new preview.context.WebSocket("wss://example.com:8443/native", ["chat"]);
  expect(preview.nativeCalls).toEqual([{ input: "wss://example.com:8443/native", protocols: ["chat"] }]);
  expect(preview.tunnels).toHaveLength(0);
  expect(socket.url).toBe("wss://example.com:8443/native");
});

test("reentrant protocol access keeps each connection's requested authority", async () => {
  const preview = fixture("https://fxj6.sprockt.dev:80/", 5173);
  const protocols = ["fixture-hmr"];
  Object.defineProperty(protocols, "0", { get() {
    new preview.context.WebSocket("ws://127.0.0.1:5173/inner");
    return "fixture-hmr";
  } });
  new preview.context.WebSocket("wss://fxj6.sprockt.dev:80/outer", protocols);
  expect(preview.tunnels).toHaveLength(2);
  const requests = await Promise.all(preview.tunnels.map(tunnel => tunnel.request));
  expect(requests[0]).toContain("\r\nhost: 127.0.0.1:5173\r\n");
  expect(requests[1]).toContain("\r\nhost: fxj6.sprockt.dev:80\r\n");
});

test("a refused preview connection settles its socket and tunnel port", async () => {
  const preview = fixture("https://fxj6.sprockt.dev/", 5173);
  const socket = new preview.context.WebSocket("wss://fxj6.sprockt.dev/");
  const tunnel = preview.tunnels[0]!;
  await tunnel.request;
  const close = closed(socket);
  tunnel.reject();
  await close;
  await tunnel.end;
  expect(socket.readyState).toBe(3);
});

test("closing during an upgrade disposes the tunnel port", async () => {
  const preview = fixture("https://fxj6.sprockt.dev/", 5173);
  const socket = new preview.context.WebSocket("wss://fxj6.sprockt.dev/");
  const tunnel = preview.tunnels[0]!;
  await tunnel.request;
  const close = closed(socket);
  socket.close();
  await close;
  await tunnel.end;
  expect(socket.readyState).toBe(3);
});

const ROOT_ORIGIN = `https://${"a".repeat(52)}-5173-pv.shaulavo.dev/`;

async function openRootSocket(preview: PreviewFixture): Promise<{ socket: PreviewSocket; tunnel: Tunnel }> {
  const socket = new preview.context.WebSocket(`wss://${new URL(ROOT_ORIGIN).host}/hmr?token=fixture`);
  expect(preview.routes).toEqual([{ type: "bunwasm-preview-socket" }]);
  const tunnel = preview.tunnels[0]!;
  const open = opened(socket);
  await tunnel.acceptRoot();
  await open;
  return { socket, tunnel };
}

/** Resolves once the page handled everything the tunnel sent before this call. */
function delivered(socket: PreviewSocket, tunnel: Tunnel): Promise<void> {
  return new Promise((resolve) => {
    socket.onmessage = () => resolve();
    tunnel.sendText("a");
  });
}

test("on a preview origin an open socket asks its IDE tab now and then, and stays open while the tab answers", async () => {
  const preview = fixture(ROOT_ORIGIN, 5173, true);
  expect(preview.intervals).toEqual([]);
  const { socket, tunnel } = await openRootSocket(preview);
  expect((await tunnel.rootOpen).url).toBe(`${new URL(ROOT_ORIGIN).origin}/hmr?token=fixture`);
  expect(preview.intervals.length).toBe(1);
  // Far more rounds than an unanswered socket survives.
  for (let round = 1; round <= 8; round++) {
    preview.tick();
    await tunnel.pingCount(round);
    await delivered(socket, tunnel);
  }
  expect(socket.readyState).toBe(1);
  expect(tunnel.pings).toBe(8);
  // The page goes away: its sockets end, and a closed socket stops asking.
  preview.close();
  expect(preview.intervals).toEqual([null]);
});

test("a socket whose IDE tab stopped answering fails after two unanswered pings and lets go of its port", async () => {
  const preview = fixture(ROOT_ORIGIN, 5173, true);
  const { socket, tunnel } = await openRootSocket(preview);
  preview.tick();
  await tunnel.pingCount(1);
  await delivered(socket, tunnel);
  // The tab crashed: the port stays open and silent, as it does in Firefox and Safari.
  tunnel.answersPings = false;
  const close = closed(socket);
  preview.tick();
  preview.tick();
  await tunnel.pingCount(3);
  expect(socket.readyState).toBe(1);
  preview.tick();
  await close;
  await tunnel.end;
  expect(socket.readyState).toBe(3);
  expect(tunnel.pings).toBe(3);
  expect(preview.intervals).toEqual([null]);
});

test("a socket whose IDE tab closed its port fails at once where the browser reports it", async () => {
  const preview = fixture(ROOT_ORIGIN, 5173, true);
  const { socket, tunnel } = await openRootSocket(preview);
  const close = closed(socket);
  tunnel.port.close();
  await close;
  expect(socket.readyState).toBe(3);
  expect(preview.intervals).toEqual([null]);
});
