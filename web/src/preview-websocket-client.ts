// The preview runs the runtime's existing WebSocket implementation over a MessagePort TCP stream.
import websocketFactory from "bun-wasm:websocket";
import { SW_SOCKET } from "./preview-origin/protocol";

const nativeWebSocket = globalThis.WebSocket;
const script = document.currentScript;
const previewPort = Number(script?.getAttribute("data-bun-port"));
const previewPrefix = script?.getAttribute("data-bun-prefix") ?? "/__preview/";
const previewRoute = script?.getAttribute("data-bun-route") || undefined;
// On a preview origin the app owns `/`: the IDE page opens the socket from structured fields
// (preview-origin/port-session.ts), so this side sends them instead of raw upgrade bytes.
const rootOrigin = script?.getAttribute("data-bunwasm-preview") === "shim";
const encoder = new TextEncoder();
const accepts = new Map<string, string>();
const connections = new Set<Connection>();
const streams = new Map<number, { port: MessagePort; authority: string }>();
let constructingAuthority: string | undefined;
let nextStream = 1;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0));
  let at = 0;
  for (const bytes of chunks) { out.set(bytes, at); at += bytes.length; }
  return out;
}

function bufferFrom(input: string | ArrayBuffer | ArrayLike<number>) {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
  return Object.assign(bytes, {
    toString(encoding: string) {
      if (encoding === "base64") return btoa(String.fromCharCode(...bytes));
      return new TextDecoder(encoding === "latin1" ? "iso-8859-1" : "utf-8").decode(bytes);
    },
  });
}

class Connection {
  closed = false;
  queue: Uint8Array[] = [];
  get bufferedAmount(): number { return this.queue.reduce((size, bytes) => size + bytes.length, 0); }
  onData: ((bytes: Uint8Array) => void) | null = null;
  onEnd: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  private port: MessagePort;
  private readonly authority: string;
  private sending = Promise.resolve();
  private timer: ReturnType<typeof setTimeout>;
  private acceptInput: string | null = null;
  private upgrading = true;
  private answered = false;

  constructor(handle: number) {
    const stream = streams.get(handle);
    if (!stream) throw new Error("Missing preview stream");
    streams.delete(handle);
    const { port, authority } = stream;
    this.port = port;
    this.authority = authority;
    connections.add(this);
    this.timer = setTimeout(() => this.fail("Preview WebSocket connection timed out"), 10000);
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    this.answered = true;
    if (this.closed) { this.port.close(); return; }
    if (message.type === "accepted") { clearTimeout(this.timer); return; }
    if (message.type === "data" && "chunk" in message && message.chunk instanceof Uint8Array) { this.onData?.(message.chunk); return; }
    if (message.type === "end") { this.onEnd?.(); this.destroy(); return; }
    if (message.type === "error") this.fail("Preview server stopped or refused the connection");
  }

  private fail(message: string): void {
    this.onError?.(new Error(message));
    this.destroy();
  }

  write(bytes: Uint8Array): void {
    if (this.closed) return;
    const owned = bytes.slice();
    this.queue.push(owned);
    this.sending = this.sending.then(() => this.writeReady(owned)).catch((error) => this.fail(String(error)));
  }

  private async writeReady(bytes: Uint8Array): Promise<void> {
    const upgrade = this.upgrading ? await this.upgradeRequest(bytes) : null;
    this.queue.shift();
    if (this.closed) return;
    if (upgrade instanceof Uint8Array) bytes = upgrade;
    else if (upgrade) { this.port.postMessage(upgrade); return; }
    this.port.postMessage({ type: "data", chunk: bytes }, [bytes.buffer]);
  }

  private async upgradeRequest(bytes: Uint8Array): Promise<Uint8Array | ReturnType<typeof rootOpen>> {
    this.upgrading = false;
    const request = new TextDecoder().decode(bytes);
    const key = /^sec-websocket-key:\s*(\S+)\r?$/im.exec(request)?.[1];
    if (!key) throw new Error("WebSocket request has no handshake key");
    // The runtime validates synchronously, so prepare SHA-1 before sending the upgrade.
    const input = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    this.acceptInput = input;
    const digest = await crypto.subtle.digest("SHA-1", encoder.encode(input));
    if (!this.closed) accepts.set(input, btoa(String.fromCharCode(...new Uint8Array(digest))));
    if (rootOrigin) return rootOpen(request);
    return encoder.encode(request.replace(/^host:[^\r\n]*/im, () => `host: ${this.authority}`)
      .replace(/\r\n\r\n$/, () => `\r\norigin: ${location.origin}\r\n\r\n`));
  }

  startReading(): void {}
  end(): void { this.sending = this.sending.then(() => this.destroy()); }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    connections.delete(this);
    if (this.acceptInput) accepts.delete(this.acceptInput);
    clearTimeout(this.timer);
    this.queue.length = 0;
    this.port.postMessage({ type: "end" });
    // On a preview origin the other end travels page, service worker, IDE page. WebKit terminates the
    // process of a page that closes a port whose other end is still in transit, so wait for an answer.
    if (!rootOrigin || this.answered) this.port.close();
    this.onClose?.();
  }
}

/** The upgrade as fields. The IDE page supplies Host, Cookie and the socket's Origin itself. */
function rootOpen(request: string): { type: "open"; url: string; method: string; headers: [string, string][] } {
  const [start = "", ...lines] = request.split("\r\n");
  const [method = "GET", target = "/"] = start.split(" ");
  const headers = lines.flatMap((line): [string, string][] => {
    const at = line.indexOf(":");
    const name = line.slice(0, Math.max(at, 0)).trim();
    return name === "" || /^(?:host|origin|cookie)$/i.test(name) ? [] : [[name, line.slice(at + 1).trim()]];
  });
  return { type: "open", url: new URL(target, location.origin).href, method, headers };
}

function connect(): number {
  if (constructingAuthority === undefined) throw new Error("Missing preview request authority");
  const channel = new MessageChannel();
  const handle = nextStream++;
  streams.set(handle, { port: channel.port1, authority: constructingAuthority });
  const controller = navigator.serviceWorker.controller;
  if (!controller) { channel.port2.close(); return handle; }
  if (rootOrigin) { controller.postMessage({ type: SW_SOCKET }, [channel.port2]); return handle; }
  controller.postMessage(
    previewRoute ? { type: "preview-socket", port: previewPort, route: previewRoute } : { type: "preview-socket", port: previewPort },
    [channel.port2],
  );
  return handle;
}

function previewHash(input: string) {
  return { digest: () => { const result = accepts.get(input); accepts.delete(input); return result; } };
}

// Only the byte transport and the runtime's Buffer/crypto adapters differ in a preview page.
const runtime = websocketFactory({
  require: () => ({ Buffer: { from: bufferFrom } }),
  builtin: () => ({ createHash: () => ({ update: previewHash }) }),
  concatBytes,
  toUint8: (input: ArrayBuffer | ArrayBufferView) => input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  native: { hostConnect: connect },
});
const RuntimeWebSocket = runtime.clientClass(Connection);

function tunnelUrl(input: string | URL): { url: URL; authority: string } | null {
  const url = new URL(String(input), location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  const sameHost = url.host === location.host;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && Number(url.port || 80) === previewPort;
  if (!sameHost && (rootOrigin || !loopback)) return null;
  if (!["ws:", "wss:"].includes(url.protocol)) return null;
  if (rootOrigin) {
    url.protocol = "ws:";
    return { url, authority: url.host };
  }
  const marker = `${previewPrefix}${previewPort}`;
  if (url.pathname === marker) url.pathname = "/";
  else if (url.pathname.startsWith(marker + "/")) url.pathname = url.pathname.slice(marker.length);
  const authority = url.host;
  url.protocol = "ws:";
  // connect() selects the guest port; the handshake keeps the requested authority.
  return { url, authority };
}

class PreviewWebSocket extends RuntimeWebSocket {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof nativeWebSocket || value instanceof RuntimeWebSocket;
  }

  constructor(input: string | URL, protocols: string | string[] = []) {
    const target = tunnelUrl(input);
    if (!target) return new nativeWebSocket(input, protocols);
    const previous = constructingAuthority;
    constructingAuthority = target.authority;
    try { super(target.url.href, protocols); }
    finally { constructingAuthority = previous; }
    Object.defineProperty(this, "url", { value: new URL(String(input), location.href).href.replace(/^http/, "ws") });
  }

  dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    const handler = Reflect.get(this, `on${event.type}`);
    if (typeof handler !== "function") return result;
    try { handler.call(this, event); }
    catch (error) { queueMicrotask(() => { throw error; }); }
    return result;
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    super.close(code, reason);
  }
}

Object.defineProperty(globalThis, "WebSocket", { value: PreviewWebSocket, configurable: true, writable: true });

addEventListener("pagehide", () => { for (const connection of connections) connection.destroy(); });
