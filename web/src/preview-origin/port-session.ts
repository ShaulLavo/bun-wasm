// The IDE-page end of one attached MessagePort. The preview origin is untrusted: this handler
// holds exactly one Waffle grant and supplies it itself, so nothing the other end sends can
// select another server, port or owner. Malformed messages are dropped before they reach Waffle.
import type { PreviewHostExchange, PreviewHostOutput, PreviewHostRelay } from "waffle/browser/preview-host";
import type { CookieJar } from "./cookie-jar.js";
import { MAX_EXCHANGES, sessionRequest, socketRequest, type SessionReply, type SessionRequest } from "./protocol.js";

export interface SessionBinding {
  /** The one grant this port reaches. */
  relay: Pick<PreviewHostRelay, "authorization" | "origin" | "dispatch">;
  /** The origin's cookies of record. HttpOnly values never leave this page. */
  jar: CookieJar;
  cookiesChanged?(): void;
  /** The service worker confirmed it holds the port. */
  attached?(): void;
  /**
   * The listener's open sockets. A socket's port runs from the page to this page directly, so it
   * outlives the service worker's port: the owner of this set closes them when the listener ends.
   * Without it a session owns its sockets and closes them with itself.
   */
  sockets?: Set<{ close(): void }>;
}

const MAX_SOCKETS = 64;
const MAX_SOCKET_HEAD = 64 * 1024;
const HEAD_END = [13, 10, 13, 10];
const supplied = (name: string) => /^(?:cookie|host)$/i.test(name);

function headEnd(bytes: Uint8Array): number {
  return bytes.findIndex((_, at) => HEAD_END.every((byte, offset) => bytes[at + offset] === byte));
}

function join(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

/** The request URL when it stays on the bound origin, or null. */
function ownUrl(input: string, origin: string): URL | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin === origin && !url.username && !url.password ? url : null;
}

/** One WebSocket of a preview page. Its port runs page to IDE directly, so it outlives the service worker. */
class SocketChannel {
  private exchange: PreviewHostExchange | null = null;
  private pendingHead: Uint8Array | null = new Uint8Array();
  private path = "/";
  private closed = false;

  constructor(private readonly port: MessagePort, private readonly binding: SessionBinding, private readonly released: () => void) {
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  private receive(data: unknown): void {
    const request = socketRequest(data);
    if (!request || this.closed) return;
    if (request.type === "open") { this.open(request); return; }
    // The page gave up before it opened anything: answer, so it may close its end, and let go.
    if (request.type === "end" && !this.exchange) { this.send({ type: "end" }); this.close(); return; }
    this.exchange?.onmessage?.(request);
  }

  private open(request: Extract<ReturnType<typeof socketRequest>, { type: "open" }>): void {
    const { relay, jar } = this.binding;
    const url = ownUrl(request.url, relay.origin);
    if (this.exchange || !url) { this.send({ type: "error", message: "Invalid preview socket request" }); this.close(); return; }
    this.path = url.pathname;
    const headers = request.headers.filter(([name]) => !supplied(name) && name.toLowerCase() !== "origin");
    // Waffle translates exactly this origin to the guest's own.
    headers.push(["Origin", relay.origin]);
    const cookie = jar.header(url.pathname);
    if (cookie) headers.push(["Cookie", cookie]);
    const exchange: PreviewHostExchange = {
      onmessage: null,
      postMessage: output => this.output(output),
      close: () => this.close(),
    };
    this.exchange = exchange;
    relay.dispatch({ type: "socket", authorization: relay.authorization, url: url.href, method: request.method, headers }, exchange)
      .catch(() => this.close());
  }

  private output(output: PreviewHostOutput): void {
    if (output.type !== "data" || this.pendingHead === null) { this.send(output); return; }
    const bytes = join(this.pendingHead, output.chunk);
    const end = headEnd(bytes);
    if (end < 0 && bytes.length < MAX_SOCKET_HEAD) { this.pendingHead = bytes; return; }
    this.pendingHead = null;
    this.send({ type: "data", chunk: end < 0 ? bytes : this.withoutSetCookie(bytes, end + HEAD_END.length) });
  }

  /** The 101 response head may set cookies; they go into the jar, never to the page. */
  private withoutSetCookie(bytes: Uint8Array<ArrayBuffer>, headLength: number): Uint8Array<ArrayBuffer> {
    const lines = new TextDecoder("latin1").decode(bytes.subarray(0, headLength - HEAD_END.length)).split("\r\n");
    const kept = lines.filter(line => !/^set-cookie\s*:/i.test(line));
    if (kept.length === lines.length) return bytes;
    let changed = false;
    for (const line of lines) {
      const value = /^set-cookie\s*:(.*)$/i.exec(line)?.[1];
      if (value !== undefined) changed = this.binding.jar.setFromHeader(value.trim(), this.path) || changed;
    }
    if (changed) this.binding.cookiesChanged?.();
    const head = Uint8Array.from(`${kept.join("\r\n")}\r\n\r\n`, character => character.charCodeAt(0));
    return join(head, bytes.subarray(headLength));
  }

  private send(output: PreviewHostOutput): void {
    if (this.closed) return;
    try { this.port.postMessage(output, output.type === "data" ? [output.chunk.buffer] : []); } catch { this.close(); }
  }

  /** Ends the guest connection, then lets go of the port. */
  close(): void {
    if (this.closed) return;
    const exchange = this.exchange;
    this.exchange = null;
    try { exchange?.onmessage?.({ type: "end" }); } catch {}
    this.closed = true;
    this.port.onmessage = null;
    this.port.close();
    this.released();
  }
}

export class PortSession {
  private readonly exchanges = new Map<number, PreviewHostExchange>();
  private readonly sockets: Set<{ close(): void }>;
  private sentCookies = -1;
  private closed = false;
  /** The service worker holds the other end. Until then it is still travelling there. */
  private confirmed = false;

  constructor(private readonly port: MessagePort, private readonly binding: SessionBinding) {
    this.sockets = binding.sockets ?? new Set();
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data, event.ports);
  }

  /** Revokes the port with every request in flight on it. */
  close(): void {
    if (this.closed) return;
    for (const exchange of Array.from(this.exchanges.values())) {
      try { exchange.onmessage?.({ type: "end" }); } catch {}
    }
    if (!this.binding.sockets) for (const socket of Array.from(this.sockets)) socket.close();
    this.closed = true;
    this.exchanges.clear();
    // WebKit terminates the page's process when a port is closed while its other end is still in
    // transit (page, relay frame, service worker). An unconfirmed port is released on confirmation.
    if (this.confirmed) this.release();
  }

  private release(): void {
    try { this.port.postMessage({ t: "detach" } satisfies SessionReply); } catch {}
    this.port.onmessage = null;
    this.port.close();
  }

  private send(reply: SessionReply, transfer: Transferable[] = []): void {
    if (this.closed) return;
    try { this.port.postMessage(reply, transfer); } catch { this.close(); }
  }

  private scriptCookies(): SessionReply & { t: "cookies" } {
    this.sentCookies = this.binding.jar.scriptVersion;
    return { t: "cookies", cookies: this.binding.jar.scriptCookies() };
  }

  private receive(data: unknown, ports: readonly MessagePort[]): void {
    const request = sessionRequest(data);
    if (request?.t === "attached") this.confirmed = true;
    if (request && this.closed && this.confirmed) { this.release(); return; }
    if (!request || this.closed) return;
    switch (request.t) {
      case "attached":
        this.send(this.scriptCookies());
        this.binding.attached?.();
        return;
      case "ping": this.send({ t: "pong", n: request.n }); return;
      case "open": this.open(request); return;
      case "input": this.exchanges.get(request.id)?.onmessage?.(request.input); return;
      case "cookie": this.writeCookie(request); return;
      case "socket": this.socket(ports[0]); return;
    }
  }

  private socket(port: MessagePort | undefined): void {
    if (!port) return;
    if (this.sockets.size >= MAX_SOCKETS) { port.postMessage({ type: "error", message: "Preview socket limit" }); port.close(); return; }
    const channel: SocketChannel = new SocketChannel(port, this.binding, () => { this.sockets.delete(channel); });
    this.sockets.add(channel);
  }

  private writeCookie(request: SessionRequest & { t: "cookie" }): void {
    const url = ownUrl(request.url, this.binding.relay.origin);
    if (url && this.binding.jar.setFromScript(request.line, url.pathname)) this.binding.cookiesChanged?.();
    this.send({ ...this.scriptCookies(), id: request.id });
  }

  private refuse(id: number, message: string): void {
    this.send({ t: "output", id, output: { type: "error", message } });
    this.send({ t: "finish", id });
  }

  private open(request: SessionRequest & { t: "open" }): void {
    const { relay, jar } = this.binding;
    const url = ownUrl(request.url, relay.origin);
    if (!url) { this.refuse(request.id, "Preview request left its origin"); return; }
    if (this.exchanges.has(request.id) || this.exchanges.size >= MAX_EXCHANGES) { this.refuse(request.id, "Preview exchange limit"); return; }
    const credentialed = request.credentials !== "omit";
    const headers = request.headers.filter(([name]) => !supplied(name));
    const cookie = credentialed ? jar.header(url.pathname) : null;
    if (cookie) headers.push(["cookie", cookie]);
    const { id } = request;
    const exchange: PreviewHostExchange = {
      onmessage: null,
      postMessage: (output, transfer = []) => this.output(id, url.pathname, credentialed, output, transfer),
      close: () => { if (this.exchanges.delete(id)) this.send({ t: "finish", id }); },
    };
    this.exchanges.set(id, exchange);
    relay.dispatch({ type: "http", authorization: relay.authorization, url: url.href, method: request.method, headers, body: request.body }, exchange)
      .catch(() => {
        exchange.postMessage({ type: "error", message: "Preview dispatcher failed" });
        exchange.close();
      });
  }

  /** Set-Cookie stops here: the jar takes it and the head crosses to the preview origin without it. */
  private output(id: number, path: string, credentialed: boolean, output: PreviewHostOutput, transfer: ArrayBuffer[]): void {
    if (output.type !== "head") { this.send({ t: "output", id, output }, transfer); return; }
    const { jar } = this.binding;
    let changed = false;
    const headers = output.headers.filter(([name, value]) => {
      if (name.toLowerCase() !== "set-cookie") return true;
      if (credentialed) changed = jar.setFromHeader(value, path) || changed;
      return false;
    });
    if (changed) this.binding.cookiesChanged?.();
    const reply: SessionReply & { t: "output" } = { t: "output", id, output: { ...output, headers } };
    if (jar.scriptVersion !== this.sentCookies) reply.cookies = this.scriptCookies().cookies;
    this.send(reply);
  }
}
