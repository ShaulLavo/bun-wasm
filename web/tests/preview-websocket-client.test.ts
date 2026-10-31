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
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  close(code?: number, reason?: string): void;
}

type SocketConstructor = new(input: string | URL, protocols?: string | string[]) => PreviewSocket;

class Tunnel {
  private readonly handshake = Promise.withResolvers<string>();
  private readonly ended = Promise.withResolvers<void>();

  constructor(readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  get request(): Promise<string> { return this.handshake.promise; }
  get end(): Promise<void> { return this.ended.promise; }

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
    if (message.type !== "end") return;
    this.ended.resolve();
    this.port.close();
  }
}

class PreviewFixture {
  readonly tunnels: Tunnel[] = [];
  readonly nativeCalls: { input: string; protocols: string | string[] }[] = [];
  readonly context: { WebSocket: SocketConstructor; [key: string]: unknown };
  private pagehide: (() => void) | null = null;

  constructor(origin: string, previewPort: number) {
    const nativeCalls = this.nativeCalls;
    const NativeWebSocket = class extends EventTarget implements PreviewSocket {
      readonly url: string;
      readonly protocol = "";
      readyState = 0;
      onopen: ((event: Event) => unknown) | null = null;
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
      document: { currentScript: { getAttribute: (name: string) => name === "data-bun-port" ? String(previewPort) : null } },
      navigator: { serviceWorker: { controller: { postMessage: (_message: unknown, transfer: MessagePort[]) => {
        const port = transfer[0];
        if (!port) throw new Error("Missing fixture tunnel port");
        this.tunnels.push(new Tunnel(port));
      } } } },
      addEventListener: (type: string, listener: () => void) => { if (type === "pagehide") this.pagehide = listener; },
      URL, Headers, EventTarget, Event, MessageEvent, CloseEvent, ErrorEvent, DOMException, Blob,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, MessageChannel,
      crypto, btoa, setTimeout, clearTimeout, queueMicrotask,
    };
    runInNewContext(script, this.context);
  }

  close(): void {
    this.pagehide?.();
    for (const tunnel of this.tunnels) tunnel.port.close();
  }
}

const fixtures: PreviewFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function fixture(origin: string, port: number): PreviewFixture {
  const value = new PreviewFixture(origin, port);
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
    host: "localhost:5173",
  },
  {
    name: "loopback with a scoped path",
    origin: "http://localhost:3000/",
    port: 5173,
    input: "ws://127.0.0.1:5173/__preview/5173/socket?token=fixture",
    requestLine: "GET /socket?token=fixture HTTP/1.1",
    host: "localhost:5173",
  },
  {
    name: "IPv6 loopback",
    origin: "http://[::1]:3000/",
    port: 5173,
    input: "ws://[::1]:5173/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "localhost:5173",
  },
  {
    name: "nondefault virtual port",
    origin: "https://fxj6.sprockt.dev/",
    port: 4174,
    input: "wss://fxj6.sprockt.dev/socket",
    requestLine: "GET /socket HTTP/1.1",
    host: "localhost:4174",
  },
];

for (const item of authorities) test(`preview upgrade preserves virtual authority for ${item.name}`, async () => {
  const preview = fixture(item.origin, item.port);
  const socket = new preview.context.WebSocket(item.input, ["fixture-hmr"]);
  expect(preview.tunnels).toHaveLength(1);
  const tunnel = preview.tunnels[0]!;
  const request = await tunnel.request;
  expect(request).toStartWith(`${item.requestLine}\r\n`);
  expect(request.match(/^host:/gim)).toHaveLength(1);
  expect(request).toContain(`\r\nhost: ${item.host}\r\n`);
  expect(request).toContain(`\r\norigin: http://localhost:${item.port}\r\n`);
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
