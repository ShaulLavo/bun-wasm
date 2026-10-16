// The preview runs the runtime's existing WebSocket implementation over a MessagePort TCP stream.
import websocketFactory from "../../crates/bunwasm-runtime/src/js/websocket.js";

const nativeWebSocket = globalThis.WebSocket;
const script = document.currentScript;
const previewPort = Number(script?.getAttribute("data-bun-port"));
const previewPrefix = script?.getAttribute("data-bun-prefix") ?? "/__preview/";
const encoder = new TextEncoder();
const accepts = new Map<string, string>();
const connections = new Set<Connection>();
const streams = new Map<number, MessagePort>();
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
  private sending = Promise.resolve();
  private timer: ReturnType<typeof setTimeout>;
  private acceptInput: string | null = null;
  private upgrading = true;

  constructor(handle: number) {
    const port = streams.get(handle);
    if (!port) throw new Error("Missing preview stream");
    streams.delete(handle);
    this.port = port;
    connections.add(this);
    this.timer = setTimeout(() => this.fail("Preview WebSocket connection timed out"), 10000);
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
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
    if (this.upgrading) bytes = await this.upgradeRequest(bytes);
    this.queue.shift();
    if (!this.closed) this.port.postMessage({ type: "data", chunk: bytes }, [bytes.buffer]);
  }

  private async upgradeRequest(bytes: Uint8Array): Promise<Uint8Array> {
    this.upgrading = false;
    const request = new TextDecoder().decode(bytes);
    const key = /^sec-websocket-key:\s*(\S+)\r?$/im.exec(request)?.[1];
    if (!key) throw new Error("WebSocket request has no handshake key");
    // The runtime validates synchronously, so prepare SHA-1 before sending the upgrade.
    const input = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    this.acceptInput = input;
    const digest = await crypto.subtle.digest("SHA-1", encoder.encode(input));
    if (!this.closed) accepts.set(input, btoa(String.fromCharCode(...new Uint8Array(digest))));
    const forwarded = request.replace(/^host:[^\r\n]*/im, `host: ${location.host}`);
    return encoder.encode(forwarded.replace(/\r\n\r\n$/, `\r\norigin: ${location.origin}\r\n\r\n`));
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
    this.port.close();
    this.onClose?.();
  }
}

function connect(): number {
  const channel = new MessageChannel();
  const handle = nextStream++;
  streams.set(handle, channel.port1);
  const controller = navigator.serviceWorker.controller;
  if (!controller) { channel.port2.close(); return handle; }
  controller.postMessage({ type: "preview-socket", port: previewPort }, [channel.port2]);
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

function tunnelUrl(input: string | URL): URL | null {
  const url = new URL(String(input), location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  const sameHost = url.host === location.host;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && Number(url.port || 80) === previewPort;
  if (!sameHost && !loopback) return null;
  if (!["ws:", "wss:"].includes(url.protocol)) return null;
  const marker = `${previewPrefix}${previewPort}`;
  if (url.pathname.startsWith(marker + "/")) url.pathname = url.pathname.slice(marker.length);
  url.protocol = "ws:";
  url.host = `localhost:${previewPort}`;
  return url;
}

class PreviewWebSocket extends RuntimeWebSocket {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof nativeWebSocket || value instanceof RuntimeWebSocket;
  }

  constructor(input: string | URL, protocols: string | string[] = []) {
    const target = tunnelUrl(input);
    if (!target) return new nativeWebSocket(input, protocols);
    super(target.href, protocols);
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
