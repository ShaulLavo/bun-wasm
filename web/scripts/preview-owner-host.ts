import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { PreviewHostAuthorization, PreviewHostInput, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { NativeHTTPExchange, NativeSocketExchange, type NativeExchangeTransport } from "./preview-exchanges";
import { PreviewPortSockets, type SocketAliasOwner } from "./preview-port-sockets";
import { LoopbackPreviewOrigins } from "../preview-origin-host";
import { encode, hostFrame, MAX_BODY, MAX_EXCHANGES, MAX_FRAME, OWNER_PATH, type HostFrame, type OwnerFrame } from "../src/preview-owner-protocol";

interface Route {
  id: string;
  port: number;
  binding: ReturnType<LoopbackPreviewOrigins["bind"]>;
  lifetime: AbortController;
  ready: ReturnType<typeof Promise.withResolvers<boolean>>;
  timer: ReturnType<typeof setTimeout>;
  stage: { kind: "pending" } | { kind: "reserved"; origin: string } | { kind: "ready"; authorization: PreviewHostAuthorization };
}
interface Exchange { route: Route; output(message: PreviewHostOutput): void; fail(): void }

/** Loopback control endpoint. Its one-use ticket is never a cookie or preview URL. */
export class PreviewOwnerHost {
  readonly origins = new LoopbackPreviewOrigins();
  private readonly tickets = new Map<string, number>();
  private readonly aliases = new PreviewPortSockets();
  private readonly owners = new Set<OwnerSession>();
  private closed = false;
  private readonly budget = { active: 0 };
  readonly websocket: WebSocketHandler<OwnerSession> = {
    maxPayloadLength: MAX_FRAME, idleTimeout: 30,
    open: socket => socket.data.attach(socket),
    message: (socket, message) => { void socket.data.message(message).catch(() => socket.data.close()); },
    close: socket => { void socket.data.close(); },
  };
  handles(path: string): boolean { return path === OWNER_PATH || path === `${OWNER_PATH}/bootstrap`; }
  fetch(request: Request, server: Server<OwnerSession>): Response | undefined {
    const expected = server.url.origin;
    if (this.closed) return new Response(null, { status: 410 });
    if (new URL(request.url).origin !== expected || request.headers.get("host") !== server.url.host) return new Response(null, { status: 421 });
    if (request.headers.get("origin") !== expected) return new Response(null, { status: 403 });
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return new Response(null, { status: 403 });
    if (new URL(request.url).pathname.endsWith("/bootstrap")) return this.bootstrap(request);
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
    const ticket = protocols[1];
    if (protocols.length !== 2 || protocols[0] !== "bun-preview-owner" || !ticket || (this.tickets.get(ticket) ?? 0) <= Date.now()) return new Response(null, { status: 401 });
    this.tickets.delete(ticket);
    const owner = new OwnerSession(this.origins, this.aliases, this.budget, () => this.owners.delete(owner));
    if (!server.upgrade(request, { data: owner, headers: { "sec-websocket-protocol": "bun-preview-owner" } })) return new Response(null, { status: 400 });
    this.owners.add(owner);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.tickets.clear();
    await Promise.all(Array.from(this.owners, owner => owner.close()));
    await this.origins.close();
  }
  private bootstrap(request: Request): Response {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    for (const [ticket, expires] of this.tickets) if (expires <= Date.now()) this.tickets.delete(ticket);
    if (this.tickets.size + this.owners.size >= 128) return new Response(null, { status: 503 });
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, Date.now() + 30_000);
    return Response.json({ ticket }, { headers: { "cache-control": "no-store", "cross-origin-resource-policy": "same-origin" } });
  }
}

export class OwnerSession implements SocketAliasOwner {
  private socket: ServerWebSocket<OwnerSession> | undefined;
  private readonly routes = new Map<string, Route>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly retired = new Set<string>();
  private owner: string | undefined;
  private closing: Promise<void> | undefined;
  private inbox: Promise<void> = Promise.resolve();
  constructor(private readonly origins: LoopbackPreviewOrigins, private readonly aliases: PreviewPortSockets, private readonly budget: { active: number }, private readonly released: () => void) {}
  attach(socket: ServerWebSocket<OwnerSession>): void { this.socket = socket; }
  message(source: string | Buffer): Promise<void> {
    this.inbox = this.inbox.then(() => this.receive(source));
    return this.inbox;
  }
  private async receive(source: string | Buffer): Promise<void> {
    if (this.closing) return;
    if (typeof source !== "string") throw new Error("Binary preview control envelope");
    const frame = hostFrame(source);
    if (frame.type === "register") { await this.register(frame.id, frame.port); return; }
    if (frame.type === "grant") { this.grant(frame); return; }
    if (frame.type === "unregister") { await this.unregister(frame.id); return; }
    const item = this.exchanges.get(frame.id);
    if (!item && this.retired.has(frame.id)) return;
    if (!item) throw new Error("Unknown preview exchange");
    if (frame.type === "finish") { item.fail(); return; }
    item.output(frame.output);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.socket?.terminate();
      for (const route of this.routes.values()) { clearTimeout(route.timer); route.lifetime.abort(); }
      for (const exchange of Array.from(this.exchanges.values())) exchange.fail();
      await Promise.all(Array.from(this.routes.values(), route => route.binding.catch(() => undefined)));
      await this.aliases.closeOwner(this);
      await this.origins.closeOwner(this);
      this.routes.clear();
      this.released();
    });
    return this.closing;
  }
  private send(frame: OwnerFrame): void {
    if (!this.socket || this.closing) throw new Error("Preview owner disconnected");
    if (this.socket.getBufferedAmount() > MAX_FRAME) throw new Error("Preview owner queue limit");
    this.socket.send(encode(frame));
  }
  private async register(id: string, port: number): Promise<void> {
    if (this.routes.has(id) || this.routes.size >= 16 || Array.from(this.routes.values()).some(route => route.port === port)) throw new Error("Preview route limit or duplicate");
    const lifetime = new AbortController();
    const ready = Promise.withResolvers<boolean>();
    lifetime.signal.addEventListener("abort", () => ready.resolve(false), { once: true });
    const route: Route = {
      id, port, lifetime, ready, stage: { kind: "pending" }, timer: setTimeout(() => { void this.close(); }, 30_000),
      binding: this.bindRoute(port, lifetime, {
        fetch: request => this.http(route, request),
        upgrade: (request, socket, head) => this.upgrade(route, request, socket, head),
        close: () => { lifetime.abort(); for (const item of Array.from(this.exchanges.values())) if (item.route === route) item.fail(); },
      }),
    };
    this.routes.set(id, route);
    const binding = await route.binding;
    if (this.closing || lifetime.signal.aborted) { await binding.close(); return; }
    route.stage = { kind: "reserved", origin: binding.origin };
    this.send({ type: "reserved", id, port, origin: binding.origin });
  }
  private grant(frame: Extract<HostFrame, { type: "grant" }>): void {
    const route = this.routes.get(frame.id);
    if (!route || route.stage.kind !== "reserved") throw new Error("Unknown preview grant");
    const grant = frame.authorization;
    if (grant.port !== route.port || grant.origin !== route.stage.origin || this.owner && grant.owner !== this.owner) throw new Error("Wrong preview owner/port/origin");
    this.owner ??= grant.owner;
    route.stage = { kind: "ready", authorization: Object.freeze(grant) };
    clearTimeout(route.timer);
    route.ready.resolve(true);
    this.send({ type: "bound", id: frame.id });
  }
  private async unregister(id: string): Promise<void> {
    const route = this.routes.get(id);
    if (!route) throw new Error("Unknown preview route");
    this.routes.delete(id);
    clearTimeout(route.timer);
    route.lifetime.abort();
    const binding = await route.binding;
    await binding.close();
    await this.aliases.releaseHost(new URL(binding.origin).hostname, this);
    await this.aliases.release(route.port, this);
  }
  ownsOrigin(origin: string): boolean {
    return !this.closing && Array.from(this.routes.values()).some(route => route.stage.kind === "ready" && route.stage.authorization.origin === origin && !route.lifetime.signal.aborted);
  }
  async fetchPort(port: number, request: Request): Promise<Response> {
    if (request.signal.aborted) return new Response(null, { status: 410 });
    const route = await this.readyPort(port);
    if (!route || request.signal.aborted || route.stage.kind !== "ready") return new Response(null, { status: 403 });
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, route.stage.authorization.origin);
    return this.http(route, new Request(target, { method: request.method, headers: request.headers, body: request.body, signal: request.signal }));
  }
  async upgradePort(port: number, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    if (socket.destroyed) return false;
    const route = await this.readyPort(port);
    if (!route || socket.destroyed || !this.ownsOrigin(request.headers.origin ?? "")) return false;
    this.upgrade(route, request, socket, head);
    return true;
  }
  private async readyPort(port: number): Promise<Route | undefined> {
    const route = Array.from(this.routes.values()).find(route => route.port === port && !route.lifetime.signal.aborted);
    if (this.closing || !route) return;
    if (route.stage.kind === "ready") return route;
    if (this.budget.active >= MAX_EXCHANGES) return;
    this.budget.active++;
    try { return await route.ready.promise && !route.lifetime.signal.aborted ? route : undefined; }
    finally { this.budget.active--; }
  }
  private async bindRoute(port: number, lifetime: AbortController, endpoint: Parameters<LoopbackPreviewOrigins["bind"]>[2]) {
    await this.aliases.reserve(port, this);
    if (this.closing || lifetime.signal.aborted) throw new Error("Preview owner closed during socket setup");
    const binding = await this.origins.bind(this, port, endpoint);
    try {
      await this.bindAliases(port, binding.origin);
      if (this.closing || lifetime.signal.aborted) throw new Error("Preview owner closed during alias setup");
      return binding;
    } catch (error) {
      await binding.close();
      await this.aliases.releaseHost(new URL(binding.origin).hostname, this);
      await this.aliases.release(port, this);
      throw error;
    }
  }
  private async bindAliases(port: number, origin: string): Promise<void> {
    await this.bindOriginAliases(port, origin);
    for (const route of this.routes.values()) {
      if (route.stage.kind === "pending") continue;
      await this.bindOriginAliases(route.port, route.stage.kind === "reserved" ? route.stage.origin : route.stage.authorization.origin);
    }
  }
  private async bindOriginAliases(rootPort: number, origin: string): Promise<void> {
    const url = new URL(origin);
    for (const route of this.routes.values()) {
      if (route.port === rootPort && url.port === String(rootPort)) continue;
      await this.aliases.reserve(route.port, this, url.hostname);
    }
  }
  private exchange(route: Route, open: PreviewHostOpen, output: Exchange["output"], fail: () => void): string {
    if (this.exchanges.size >= MAX_EXCHANGES || this.budget.active >= MAX_EXCHANGES) throw new Error("Preview exchange limit");
    const id = crypto.randomUUID();
    this.exchanges.set(id, { route, output, fail });
    this.budget.active++;
    try { this.send({ type: "open", id, open }); } catch (error) { this.retire(id); throw error; }
    return id;
  }
  private input(id: string, input: PreviewHostInput): void { this.send({ type: "input", id, input }); }
  private retire(id: string): void {
    if (this.exchanges.delete(id)) this.budget.active--;
    this.retired.add(id);
    const oldest = this.retired.values().next().value;
    if (this.retired.size > 256 && oldest) this.retired.delete(oldest);
  }
  private async http(route: Route, request: Request): Promise<Response> {
    if (route.stage.kind !== "ready") return new Response("Preview binding is pending", { status: 503 });
    const grant = route.stage.authorization;
    const body = await requestBytes(request);
    const open: PreviewHostOpen = { type: "http", authorization: grant, url: request.url, method: request.method, headers: Array.from(request.headers), body };
    return new NativeHTTPExchange(request, this.transport(route)).start(open);
  }
  private transport(route: Route): NativeExchangeTransport {
    return {
      open: (open, output, fail) => this.exchange(route, open, output, fail),
      input: (id, message) => this.input(id, message),
      retire: id => this.retire(id),
      connected: () => !this.closing,
    };
  }
  private upgrade(route: Route, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (route.stage.kind !== "ready" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return; }
    const grant = route.stage.authorization;
    const raw = `${request.method} ${request.url} HTTP/1.1\r\n${request.rawHeaders.reduce((result, value, index) => result + (index % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`;
    new NativeSocketExchange(socket, new TextEncoder().encode(raw), head, this.transport(route)).start({
      type: "socket", authorization: grant, url: new URL(request.url ?? "/", grant.origin).href,
    });
  }
}

async function requestBytes(request: Request): Promise<ArrayBuffer | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("Preview request body limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
}
