import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { PreviewHostAuthorization, PreviewHostInput, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { NativeHTTPExchange, NativeSocketExchange, type NativeExchangeTransport } from "./preview-exchanges";
import { PreviewAliasLimitError, PreviewPortSockets, type SocketAliasOwner } from "./preview-port-sockets";
import { LoopbackPreviewOrigins, type PreviewOriginBinding } from "../preview-origin-host";
import { encode, hostFrame, MAX_BODY, MAX_EXCHANGES, MAX_FRAME, OWNER_PATH, type HostFrame, type OwnerFrame } from "../src/preview-owner-protocol";

const MAX_LIVE_ROUTES = 16;
const MAX_TOTAL_ROUTES = 32;
const MAX_PENDING_PER_PORT = 2;
const MAX_RETIRED_RESERVED = 256;

interface Route {
  id: string;
  port: number;
  aliasOwner: SocketAliasOwner;
  binding: Promise<void>;
  resolvedBinding?: PreviewOriginBinding;
  cleanup?: Promise<void>;
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
  private readonly cleanupErrors: unknown[] = [];
  private closed = false;
  private readonly budget = { active: 0 };
  readonly websocket: WebSocketHandler<OwnerSession> = {
    maxPayloadLength: MAX_FRAME,
    idleTimeout: 30,
    open: socket => socket.data.attach(socket),
    message: (socket, message) => { void socket.data.message(message).catch(() => { void socket.data.close().catch(() => {}); }); },
    close: socket => { void socket.data.close().catch(() => {}); },
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
    const owner = new OwnerSession(
      this.origins,
      this.aliases,
      this.budget,
      () => this.owners.delete(owner),
      error => this.cleanupErrors.push(error),
    );
    if (!server.upgrade(request, { data: owner, headers: { "sec-websocket-protocol": "bun-preview-owner" } })) return new Response(null, { status: 400 });
    this.owners.add(owner);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.tickets.clear();
    const ownerResults = await Promise.allSettled(Array.from(this.owners, owner => owner.close()));
    const originResults = await Promise.allSettled([this.origins.close()]);
    const errors: unknown[] = [...this.cleanupErrors];
    this.cleanupErrors.length = 0;
    for (const result of ownerResults) if (result.status === "rejected") errors.push(result.reason);
    for (const result of originResults) if (result.status === "rejected") errors.push(result.reason);
    const unique = Array.from(new Set(errors));
    if (unique.length > 0) {
      throw unique.length === 1 ? unique[0] : new AggregateError(unique, "Preview owner host close failed");
    }
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

export class OwnerSession {
  private socket: ServerWebSocket<OwnerSession> | undefined;
  private readonly routes = new Map<string, Route>();
  private readonly routeAliasOwners = new Map<SocketAliasOwner, number>();
  private readonly portCleanups = new Map<number, Promise<void>>();
  private readonly portPendingCount = new Map<number, number>();
  private readonly activeCleanups = new Set<Promise<void>>();
  private readonly retiredReservedRoutes = new Map<string, { port: number; origin: string }>();
  private readonly routeCleanupErrors: unknown[] = [];
  private readonly exchanges = new Map<string, Exchange>();
  private readonly retired = new Set<string>();
  private owner: string | undefined;
  private closing: Promise<void> | undefined;
  private inbox: Promise<void> = Promise.resolve();

  constructor(
    private readonly origins: LoopbackPreviewOrigins,
    private readonly aliases: PreviewPortSockets,
    private readonly budget: { active: number },
    private readonly released: () => void,
    private readonly onCleanupError: (error: unknown) => void = () => {},
  ) {}

  attach(socket: ServerWebSocket<OwnerSession>): void { this.socket = socket; }
  message(source: string | Buffer): Promise<void> {
    this.inbox = this.inbox.then(() => this.receive(source));
    return this.inbox;
  }

  private isRouteLive(route: Route): boolean {
    return !this.closing && !route.lifetime.signal.aborted && this.routes.get(route.id) === route;
  }

  private closeDetached(): void {
    void this.close().catch(() => {});
  }

  private recordRetiredReserved(id: string, port: number, origin: string): void {
    this.retiredReservedRoutes.delete(id);
    this.retiredReservedRoutes.set(id, { port, origin });
    if (this.retiredReservedRoutes.size > MAX_RETIRED_RESERVED) {
      const oldest = this.retiredReservedRoutes.keys().next().value;
      if (oldest !== undefined) this.retiredReservedRoutes.delete(oldest);
    }
  }

  private async receive(source: string | Buffer): Promise<void> {
    if (this.closing) return;
    if (typeof source !== "string") throw new Error("Binary preview control envelope");
    const frame = hostFrame(source);
    if (frame.type === "register") { this.register(frame.id, frame.port); return; }
    if (frame.type === "grant") { this.grant(frame); return; }
    if (frame.type === "unregister") { this.unregister(frame.id); return; }
    const item = this.exchanges.get(frame.id);
    if (!item && this.retired.has(frame.id)) return;
    if (!item) throw new Error("Unknown preview exchange");
    if (frame.type === "finish") { item.fail(); return; }
    item.output(frame.output);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.socket?.terminate();
    const liveRoutes = Array.from(this.routes.values());
    this.routes.clear();
    for (const route of liveRoutes) {
      clearTimeout(route.timer);
      route.lifetime.abort();
      void this.startRouteCleanup(route);
    }
    for (const exchange of Array.from(this.exchanges.values())) exchange.fail();
    this.closing = Promise.resolve().then(async () => {
      while (this.activeCleanups.size > 0) {
        await Promise.allSettled(Array.from(this.activeCleanups));
      }
      if (this.routeAliasOwners.size > 0) {
        const remaining = Array.from(this.routeAliasOwners.entries());
        this.routeAliasOwners.clear();
        const aliasResults = await Promise.allSettled(remaining.map(([aliasOwner, port]) => this.aliases.release(port, aliasOwner)));
        for (const result of aliasResults) if (result.status === "rejected") this.routeCleanupErrors.push(result.reason);
      }
      try {
        await this.origins.closeOwner(this);
      } catch (error) {
        this.routeCleanupErrors.push(error);
      }
      const uniqueErrors = Array.from(new Set(this.routeCleanupErrors));
      if (uniqueErrors.length > 0) {
        const error = uniqueErrors.length === 1
          ? uniqueErrors[0]
          : new AggregateError(uniqueErrors, "Preview owner session cleanup failed");
        this.onCleanupError(error);
        this.released();
        throw error;
      }
      this.released();
    });
    return this.closing;
  }

  private send(frame: OwnerFrame): void {
    if (!this.socket || this.closing) throw new Error("Preview owner disconnected");
    if (this.socket.getBufferedAmount() > MAX_FRAME) throw new Error("Preview owner queue limit");
    this.socket.send(encode(frame));
  }

  private sendIfConnected(frame: OwnerFrame): void {
    if (!this.socket || this.closing) return;
    try { this.send(frame); } catch { this.closeDetached(); }
  }

  private register(id: string, port: number): void {
    if (this.routes.has(id) || Array.from(this.routes.values()).some(route => route.port === port)) {
      throw new Error("Preview route duplicate");
    }
    if (
      this.routes.size >= MAX_LIVE_ROUTES ||
      this.routes.size + this.activeCleanups.size >= MAX_TOTAL_ROUTES ||
      (this.portPendingCount.get(port) ?? 0) >= MAX_PENDING_PER_PORT
    ) {
      this.sendIfConnected({ type: "busy", id, port });
      return;
    }
    const lifetime = new AbortController();
    const ready = Promise.withResolvers<boolean>();
    lifetime.signal.addEventListener("abort", () => ready.resolve(false), { once: true });
    let route!: Route;
    const aliasOwner: SocketAliasOwner = {
      ownsOrigin: origin => !route.lifetime.signal.aborted && this.routes.get(route.id) === route && this.ownsOrigin(origin),
      fetchPort: (reqPort, request) => this.fetchPortForRoute(route, reqPort, request),
      upgradePort: (reqPort, request, socket, head) => this.upgradePortForRoute(route, reqPort, request, socket, head),
    };
    route = {
      id,
      port,
      aliasOwner,
      binding: Promise.resolve(),
      lifetime,
      ready,
      stage: { kind: "pending" },
      timer: setTimeout(() => { this.expireRoute(id); }, 30_000),
    };
    this.routes.set(id, route);
    this.routeAliasOwners.set(aliasOwner, port);
    route.binding = this.runRouteBinding(route);
  }

  private async runRouteBinding(route: Route): Promise<void> {
    try {
      const prev = this.portCleanups.get(route.port);
      if (prev) await prev;
      if (!this.isRouteLive(route)) { void this.startRouteCleanup(route); return; }
      await this.aliases.reserve(route.port, route.aliasOwner);
      if (!this.isRouteLive(route)) { void this.startRouteCleanup(route); return; }
      const binding = await this.origins.bind(this, route.port, {
        fetch: request => this.http(route, request),
        upgrade: (request, socket, head) => this.upgrade(route, request, socket, head),
        close: () => {
          route.lifetime.abort();
          for (const item of Array.from(this.exchanges.values())) if (item.route === route) item.fail();
        },
      });
      route.resolvedBinding = binding;

      // Single synchronous continuation with zero awaits for alias reconciliation and publication.
      if (!this.isRouteLive(route)) { void this.startRouteCleanup(route); return; }
      const selfUrl = new URL(binding.origin);
      const entries: { port: number; owner: SocketAliasOwner; hostname: string }[] = [];
      if (selfUrl.port !== String(route.port)) {
        entries.push({ port: route.port, owner: route.aliasOwner, hostname: selfUrl.hostname });
      }
      for (const other of this.routes.values()) {
        if (other === route || !this.isRouteLive(other)) continue;
        if (other.stage.kind !== "reserved" && other.stage.kind !== "ready") continue;
        const otherOrigin = other.stage.kind === "reserved" ? other.stage.origin : other.stage.authorization.origin;
        const otherHostname = new URL(otherOrigin).hostname;
        entries.push({ port: other.port, owner: other.aliasOwner, hostname: selfUrl.hostname });
        entries.push({ port: route.port, owner: route.aliasOwner, hostname: otherHostname });
      }
      const batch = this.aliases.reserveHostBatch(entries);
      if (!batch.ok) {
        this.routes.delete(route.id);
        clearTimeout(route.timer);
        route.lifetime.abort();
        void this.startRouteCleanup(route);
        this.sendIfConnected({ type: batch.reason === "limit" ? "busy" : "expired", id: route.id, port: route.port });
        return;
      }
      route.stage = { kind: "reserved", origin: binding.origin };
      this.sendIfConnected({ type: "reserved", id: route.id, port: route.port, origin: binding.origin });
    } catch (error) {
      if (this.closing || route.lifetime.signal.aborted || this.routes.get(route.id) !== route) {
        void this.startRouteCleanup(route);
        return;
      }
      this.routes.delete(route.id);
      clearTimeout(route.timer);
      route.lifetime.abort();
      void this.startRouteCleanup(route);
      this.sendIfConnected({
        type: error instanceof PreviewAliasLimitError ? "busy" : "expired",
        id: route.id,
        port: route.port,
      });
    }
  }

  private startRouteCleanup(route: Route): Promise<void> {
    if (route.cleanup) return route.cleanup;
    const earlySiblingReleases: Promise<void>[] = [];
    if (route.resolvedBinding) {
      const hostname = new URL(route.resolvedBinding.origin).hostname;
      for (const [otherOwner, otherPort] of Array.from(this.routeAliasOwners)) {
        if (otherOwner === route.aliasOwner) continue;
        earlySiblingReleases.push(this.aliases.releaseHostOnPort(otherPort, hostname, otherOwner));
      }
    }
    this.portPendingCount.set(route.port, (this.portPendingCount.get(route.port) ?? 0) + 1);
    const prevPortCleanup = this.portCleanups.get(route.port);
    let cleanup!: Promise<void>;
    cleanup = (async () => {
      try {
        await route.binding.catch(() => undefined);
        const binding = route.resolvedBinding;
        const tasks: Promise<unknown>[] = [...earlySiblingReleases];
        if (binding) tasks.push(Promise.resolve().then(() => binding.close()));
        tasks.push(
          this.aliases.release(route.port, route.aliasOwner).finally(() => {
            this.routeAliasOwners.delete(route.aliasOwner);
          }),
        );
        if (binding) {
          const hostname = new URL(binding.origin).hostname;
          const siblingReleases = Array.from(this.routeAliasOwners)
            .filter(([otherOwner]) => otherOwner !== route.aliasOwner)
            .map(([otherOwner, otherPort]) => this.aliases.releaseHostOnPort(otherPort, hostname, otherOwner));
          tasks.push(...siblingReleases);
        }
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === "rejected") this.routeCleanupErrors.push(result.reason);
        }
      } finally {
        this.activeCleanups.delete(cleanup);
        const count = (this.portPendingCount.get(route.port) ?? 1) - 1;
        if (count <= 0) this.portPendingCount.delete(route.port);
        else this.portPendingCount.set(route.port, count);
      }
    })();
    route.cleanup = cleanup;
    this.activeCleanups.add(cleanup);
    const portChain = prevPortCleanup
      ? Promise.allSettled([prevPortCleanup, cleanup]).then(() => {})
      : cleanup;
    this.portCleanups.set(route.port, portChain);
    void portChain.finally(() => {
      if (this.portCleanups.get(route.port) === portChain) this.portCleanups.delete(route.port);
    });
    return cleanup;
  }

  private expireRoute(id: string): void {
    const route = this.routes.get(id);
    if (this.closing || !route || route.stage.kind === "ready") return;
    if (route.stage.kind === "reserved") this.recordRetiredReserved(id, route.port, route.stage.origin);
    this.routes.delete(id);
    clearTimeout(route.timer);
    route.lifetime.abort();
    void this.startRouteCleanup(route);
    this.sendIfConnected({ type: "expired", id, port: route.port });
  }

  private grant(frame: Extract<HostFrame, { type: "grant" }>): void {
    const route = this.routes.get(frame.id);
    if (!route) {
      if (this.owner !== undefined && frame.authorization.owner !== this.owner) throw new Error("Wrong preview owner");
      const retired = this.retiredReservedRoutes.get(frame.id);
      if (!retired || retired.port !== frame.authorization.port || retired.origin !== frame.authorization.origin) {
        throw new Error("Unknown preview grant");
      }
      return;
    }
    if (route.stage.kind !== "reserved") throw new Error("Unknown preview grant");
    const grant = frame.authorization;
    if (grant.port !== route.port || grant.origin !== route.stage.origin || (this.owner && grant.owner !== this.owner)) {
      throw new Error("Wrong preview owner/port/origin");
    }
    this.owner ??= grant.owner;
    route.stage = { kind: "ready", authorization: Object.freeze(grant) };
    clearTimeout(route.timer);
    route.ready.resolve(true);
    this.send({ type: "bound", id: frame.id });
  }

  private unregister(id: string): void {
    const route = this.routes.get(id);
    if (!route) return;
    if (route.stage.kind === "reserved") this.recordRetiredReserved(id, route.port, route.stage.origin);
    this.routes.delete(id);
    clearTimeout(route.timer);
    route.lifetime.abort();
    void this.startRouteCleanup(route);
    this.sendIfConnected({ type: "unregistered", id, port: route.port });
  }

  ownsOrigin(origin: string): boolean {
    return !this.closing && Array.from(this.routes.values()).some(
      route => route.stage.kind === "ready" && route.stage.authorization.origin === origin && !route.lifetime.signal.aborted,
    );
  }

  private async fetchPortForRoute(route: Route, port: number, request: Request): Promise<Response> {
    if (request.signal.aborted) return new Response(null, { status: 410 });
    const ready = await this.readyRoute(route, port);
    if (!ready || request.signal.aborted || ready.stage.kind !== "ready") return new Response(null, { status: 403 });
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ready.stage.authorization.origin);
    return this.http(ready, new Request(target, { method: request.method, headers: request.headers, body: request.body, signal: request.signal }));
  }

  private async upgradePortForRoute(route: Route, port: number, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    if (socket.destroyed) return false;
    const ready = await this.readyRoute(route, port);
    if (!ready || socket.destroyed || !this.ownsOrigin(request.headers.origin ?? "")) return false;
    this.upgrade(ready, request, socket, head);
    return true;
  }

  private async readyRoute(route: Route, port: number): Promise<Route | undefined> {
    if (this.closing || route.port !== port || route.lifetime.signal.aborted || this.routes.get(route.id) !== route) return;
    if (route.stage.kind === "ready") return route;
    if (this.budget.active >= MAX_EXCHANGES) return;
    this.budget.active++;
    try {
      return await route.ready.promise && !route.lifetime.signal.aborted && this.routes.get(route.id) === route ? route : undefined;
    } finally {
      this.budget.active--;
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
    const method = request.method;
    if (method === undefined) { socket.destroy(); return; }
    const grant = route.stage.authorization;
    const headers: [string, string][] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name === undefined || value === undefined) { socket.destroy(); return; }
      headers.push([name, value]);
    }
    new NativeSocketExchange(socket, head, this.transport(route)).start({
      type: "socket",
      authorization: grant,
      url: new URL(request.url ?? "/", grant.origin).href,
      method,
      headers,
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
