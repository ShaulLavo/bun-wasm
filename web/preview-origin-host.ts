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

export interface PreviewOriginBinding {
  readonly origin: string;
  close(): Promise<void>;
}
interface OwnedBinding { owner: object; port: number; binding: PreviewOriginBinding }
interface Reservation { owner: object; port: number; lifetime: AbortController; done: ReturnType<typeof Promise.withResolvers<void>> }

function combineErrors(errors: readonly unknown[], message: string): unknown {
  const unique = Array.from(new Set(errors));
  if (unique.length === 1) return unique[0];
  return new AggregateError(unique, message);
}

/** Server-side capability registry. No browser request can choose its owner or target. */
export class LoopbackPreviewOrigins {
  private readonly bindings = new Set<OwnedBinding>();
  private readonly sockets = new Set<Socket>();
  private readonly reservations = new Set<Reservation>();
  private readonly closing = new Set<{ owner: object; promise: Promise<void> }>();
  private readonly cleanupErrors = new Map<object, unknown[]>();
  private closed = false;
  private readonly hostnamePrefix = crypto.randomUUID();
  private nextHostname = 0;

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
    if (this.find(owner, port) || Array.from(this.reservations).some(route => route.owner === owner && route.port === port)) {
      throw new Error("Preview owner/port is already registered");
    }
    if (this.bindings.size + this.reservations.size + this.closing.size >= this.limit) {
      throw new Error("Preview origin allocation limit reached");
    }
    const reservation: Reservation = { owner, port, lifetime: new AbortController(), done: Promise.withResolvers<void>() };
    void reservation.done.promise.catch(() => {});
    this.reservations.add(reservation);
    let rollbackError: unknown;
    let hasRollbackError = false;
    try {
      const route = await this.listen(owner, port, endpoint, reservation.lifetime);
      if (reservation.lifetime.signal.aborted) {
        try {
          await route.binding.close();
        } catch (error) {
          rollbackError = error;
          hasRollbackError = true;
        }
        throw new Error("Preview owner closed during registration");
      }
      this.bindings.add(route);
      return route.binding;
    } finally {
      this.reservations.delete(reservation);
      if (hasRollbackError) reservation.done.reject(rollbackError);
      else reservation.done.resolve();
    }
  }

  async closeOwner(owner: object): Promise<void> {
    const starting = Array.from(this.reservations).filter(route => route.owner === owner);
    for (const route of starting) route.lifetime.abort();
    const pending = Array.from(this.bindings).filter(route => route.owner === owner).map(route => route.binding.close());
    const closing = Array.from(this.closing).filter(route => route.owner === owner).map(route => route.promise);
    const settled = await Promise.allSettled(pending.concat(starting.map(route => route.done.promise), closing));
    const errors: unknown[] = [];
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    const retained = this.cleanupErrors.get(owner);
    if (retained) {
      errors.push(...retained);
      this.cleanupErrors.delete(owner);
    }
    if (errors.length > 0) throw combineErrors(errors, "Preview origin owner close failed");
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const route of this.reservations) route.lifetime.abort();
    const settled = await Promise.allSettled(
      Array.from(this.bindings, route => route.binding.close()).concat(
        Array.from(this.reservations, route => route.done.promise),
        Array.from(this.closing, route => route.promise),
      ),
    );
    const errors: unknown[] = [];
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    for (const retained of this.cleanupErrors.values()) errors.push(...retained);
    this.cleanupErrors.clear();
    if (errors.length > 0) throw combineErrors(errors, "Preview origin host close failed");
  }

  private recordCleanupError(owner: object, error: unknown): void {
    let list = this.cleanupErrors.get(owner);
    if (!list) {
      list = [];
      this.cleanupErrors.set(owner, list);
    }
    list.push(error);
  }

  private find(owner: object, port: number): OwnedBinding | undefined {
    return Array.from(this.bindings).find(route => route.owner === owner && route.port === port);
  }

  private async listen(owner: object, port: number, endpoint: PreviewOriginEndpoint, lifetime: AbortController): Promise<OwnedBinding> {
    if (!Number.isSafeInteger(this.nextHostname + 1)) throw new Error("Preview origin hostname space exhausted");
    const sockets = new Set<Socket>();
    let origin = "";
    const acceptsOrigin = (source: string) => source === origin || Array.from(this.bindings).some(route => route.owner === owner && route.binding.origin === source);
    const server = createServer((request, response) => { void dispatchPreviewHTTP(request, response, origin, endpoint, lifetime.signal, acceptsOrigin); });
    server.on("connection", socket => {
      if (this.sockets.size >= 256 || sockets.size >= 64) { socket.destroy(); return; }
      sockets.add(socket);
      this.sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); this.sockets.delete(socket); });
    });
    server.on("upgrade", (request, socket, head) => { void upgrade(request, socket, head, origin, endpoint, lifetime.signal, acceptsOrigin); });
    const addressHost = `bw-${++this.nextHostname}-${this.hostnamePrefix}.localhost`;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Missing loopback listener"); }
    origin = `http://${addressHost}:${address.port}`;
    let closing: Promise<void> | undefined;
    const route: OwnedBinding = {
      owner,
      port,
      binding: {
        origin,
        close: () => {
          if (closing) return closing;
          this.bindings.delete(route);
          lifetime.abort();
          for (const socket of sockets) socket.destroy();
          const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          const endpointClosed = Promise.resolve().then(() => endpoint.close());
          closing = Promise.allSettled([stopped, endpointClosed]).then(results => {
            const errors = results
              .filter((r): r is PromiseRejectedResult => r.status === "rejected")
              .map(r => r.reason);
            if (errors.length > 0) throw combineErrors(errors, "Preview origin binding close failed");
          });
          const pending = { owner, promise: closing };
          this.closing.add(pending);
          void closing.then(
            () => { this.closing.delete(pending); },
            (error) => {
              this.closing.delete(pending);
              this.recordCleanupError(owner, error);
            },
          );
          return closing;
        },
      },
    };
    return route;
  }
}

function rejected(request: IncomingMessage, origin: string, signal: AbortSignal, acceptsOrigin: (source: string) => boolean): number | undefined {
  if (signal.aborted) return 410;
  let url: URL;
  try { url = new URL(request.url ?? "/", origin); } catch { return 400; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== origin || request.headers.host !== new URL(origin).host) return 421;
  if (request.headers.origin && !acceptsOrigin(request.headers.origin)) return 403;
  if (request.headers["sec-fetch-site"] === "cross-site" && request.headers["sec-fetch-mode"] !== "navigate" && !request.headers.origin) return 403;
}

const FRAME_EMBEDDING = [["cross-origin-embedder-policy", "require-corp"], ["cross-origin-resource-policy", "cross-origin"]] as const;

/**
 * Safari shows previews in an iframe of the cross-origin isolated playground (COEP require-corp).
 * Browsers commit a cross-origin document there only when it opts into that embedding, so frame
 * navigations default to it. Top-level tabs and explicit app policies are left unchanged.
 */
function framedResponseHeaders(request: IncomingMessage, source: Headers): Headers {
  const destination = request.headers["sec-fetch-dest"];
  if (destination !== "iframe" && destination !== "frame") return source;
  if (source.has("cross-origin-embedder-policy") || source.has("cross-origin-resource-policy")) return source;
  const headers = new Headers(source);
  for (const [name, value] of FRAME_EMBEDDING) headers.set(name, value);
  return headers;
}

export async function dispatchPreviewHTTP(incoming: IncomingMessage, outgoing: ServerResponse, origin: string, endpoint: Pick<PreviewOriginEndpoint, "fetch">, lifetime: AbortSignal, acceptsOrigin: (source: string) => boolean): Promise<void> {
  const cancelled = new AbortController();
  const abort = () => cancelled.abort();
  outgoing.once("close", abort);
  try {
    const status = rejected(incoming, origin, lifetime, acceptsOrigin);
    if (status) { outgoing.writeHead(status); outgoing.end(); return; }
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method: incoming.method, headers, signal: AbortSignal.any([lifetime, cancelled.signal]),
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : requestBody(incoming),
    });
    const response = await endpoint.fetch(request);
    if (request.signal.aborted) { await response.body?.cancel(); outgoing.destroy(); return; }
    const sent = framedResponseHeaders(incoming, response.headers);
    const responseHeaders = Array.from(sent).filter(([key]) => key !== "set-cookie").flat();
    for (const cookie of sent.getSetCookie()) responseHeaders.push("set-cookie", cookie);
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

async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, origin: string, endpoint: PreviewOriginEndpoint, signal: AbortSignal, acceptsOrigin: (source: string) => boolean): Promise<void> {
  try {
    const status = rejected(request, origin, signal, acceptsOrigin);
    if (status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    await endpoint.upgrade(request, socket, head);
  } catch { socket.destroy(); }
}
