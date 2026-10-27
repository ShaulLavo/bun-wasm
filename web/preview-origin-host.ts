import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The relay owns authentication and transport. This adapter owns only its listener. */
export interface PreviewOriginEndpoint {
  fetch(request: Request): Promise<Response> | Response;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>;
  close(): void | Promise<void>;
}

interface PreviewOriginBinding {
  readonly origin: string;
  close(): Promise<void>;
}
interface OwnedBinding { owner: object; port: number; binding: PreviewOriginBinding }
interface Reservation { owner: object; port: number; lifetime: AbortController; done: PromiseWithResolvers<void> }

/** Server-side capability registry. No browser request can choose its owner or target. */
export class LoopbackPreviewOrigins {
  private readonly bindings = new Set<OwnedBinding>();
  private readonly sockets = new Set<Socket>();
  private readonly reservations = new Set<Reservation>();
  private readonly usedOrigins = new Set<string>();
  private readonly closing = new Set<{ owner: object; promise: Promise<void> }>();
  private closed = false;
  private readonly subnet = crypto.getRandomValues(new Uint8Array(2));
  private nextAddress = 1;

  constructor(private readonly limit = 128) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid preview origin limit");
  }

  originForPort(owner: object, port: number): string {
    const route = this.find(owner, port);
    if (!route) throw new Error("Unregistered preview owner/port");
    return route.binding.origin;
  }

  async bind(owner: object, port: number, endpoint: PreviewOriginEndpoint): Promise<PreviewOriginBinding> {
    if (this.closed) throw new Error("Preview origin host is closed");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid virtual port");
    if (this.find(owner, port) || Array.from(this.reservations).some(route => route.owner === owner && route.port === port)) throw new Error("Preview owner/port is already registered");
    if (this.usedOrigins.size + this.reservations.size >= this.limit) throw new Error("Preview origin allocation limit reached");
    const reservation = { owner, port, lifetime: new AbortController(), done: Promise.withResolvers<void>() };
    this.reservations.add(reservation);
    try {
      const route = await this.listen(owner, port, endpoint, reservation.lifetime);
      if (reservation.lifetime.signal.aborted) {
        await route.binding.close();
        throw new Error("Preview owner closed during registration");
      }
      this.bindings.add(route);
      return route.binding;
    } finally {
      this.reservations.delete(reservation);
      reservation.done.resolve();
    }
  }

  async closeOwner(owner: object): Promise<void> {
    const starting = Array.from(this.reservations).filter(route => route.owner === owner);
    for (const route of starting) route.lifetime.abort();
    const pending = Array.from(this.bindings).filter(route => route.owner === owner).map(route => route.binding.close());
    await Promise.all(pending.concat(starting.map(route => route.done.promise), Array.from(this.closing).filter(route => route.owner === owner).map(route => route.promise)));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const route of this.reservations) route.lifetime.abort();
    await Promise.all(Array.from(this.bindings, route => route.binding.close()).concat(
      Array.from(this.reservations, route => route.done.promise), Array.from(this.closing, route => route.promise)));
  }

  private find(owner: object, port: number): OwnedBinding | undefined {
    return Array.from(this.bindings).find(route => route.owner === owner && route.port === port);
  }

  private async listen(owner: object, port: number, endpoint: PreviewOriginEndpoint, lifetime: AbortController): Promise<OwnedBinding> {
    const sockets = new Set<Socket>();
    let origin = "";
    const server = createServer((request, response) => { void dispatch(request, response, origin, endpoint, lifetime.signal); });
    server.on("connection", socket => {
      if (this.sockets.size >= 256 || sockets.size >= 64) { socket.destroy(); return; }
      sockets.add(socket); this.sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); this.sockets.delete(socket); });
    });
    server.on("upgrade", (request, socket, head) => { void upgrade(request, socket, head, origin, endpoint, lifetime.signal); });
    const addressHost = `127.${1 + this.subnet[0]! % 254}.${this.subnet[1]!}.${this.nextAddress++}`;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, addressHost, resolve); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Missing loopback listener"); }
    origin = `http://${addressHost}:${address.port}`;
    if (this.usedOrigins.has(origin)) { server.close(); throw new Error("Retired preview origin was allocated again"); }
    this.usedOrigins.add(origin);
    let closing: Promise<void> | undefined;
    const route: OwnedBinding = { owner, port, binding: { origin, close: () => {
      if (closing) return closing;
      this.bindings.delete(route);
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      closing = Promise.all([stopped, Promise.resolve().then(() => endpoint.close())]).then(() => {});
      const pending = { owner, promise: closing };
      this.closing.add(pending);
      void closing.then(() => this.closing.delete(pending), () => {});
      return closing;
    } } };
    return route;
  }
}

function rejected(request: IncomingMessage, origin: string, signal: AbortSignal): number | undefined {
  if (signal.aborted) return 410;
  let url: URL;
  try { url = new URL(request.url ?? "/", origin); } catch { return 400; }
  if (url.origin !== origin || request.headers.host !== new URL(origin).host) return 421;
  if (request.headers.origin && request.headers.origin !== origin) return 403;
  if (request.headers["sec-fetch-site"] === "cross-site" && request.headers["sec-fetch-mode"] !== "navigate") return 403;
}

async function dispatch(incoming: IncomingMessage, outgoing: ServerResponse, origin: string, endpoint: PreviewOriginEndpoint, lifetime: AbortSignal): Promise<void> {
  const cancelled = new AbortController();
  const abort = () => cancelled.abort();
  outgoing.once("close", abort);
  try {
    const status = rejected(incoming, origin, lifetime);
    if (status) { outgoing.writeHead(status); outgoing.end(); return; }
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method: incoming.method, headers, signal: AbortSignal.any([lifetime, cancelled.signal]),
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : requestBody(incoming),
    });
    const response = await endpoint.fetch(request);
    if (request.signal.aborted) { await response.body?.cancel(); outgoing.destroy(); return; }
    const responseHeaders = Array.from(response.headers).filter(([key]) => key !== "set-cookie").flat();
    for (const cookie of response.headers.getSetCookie()) responseHeaders.push("set-cookie", cookie);
    outgoing.writeHead(response.status, response.statusText, responseHeaders);
    if (!response.body) { outgoing.end(); return; }
    await pipeline(Readable.from(response.body), outgoing);
  } catch {
    if (outgoing.headersSent) outgoing.destroy();
    else { outgoing.writeHead(502); outgoing.end("Preview endpoint failed"); }
  } finally { outgoing.removeListener("close", abort); }
}


function requestBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  const reader = Readable.toWeb(incoming).getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      if (!(value instanceof Uint8Array)) throw new TypeError("Non-byte HTTP body");
      controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, origin: string, endpoint: PreviewOriginEndpoint, signal: AbortSignal): Promise<void> {
  try {
    const status = rejected(request, origin, signal);
    if (status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    await endpoint.upgrade(request, socket, head);
  } catch { socket.destroy(); }
}
