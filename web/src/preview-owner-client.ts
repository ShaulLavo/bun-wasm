import type { PreviewHostAuthorization, PreviewHostDispatcher, PreviewHostExchange, PreviewHostInput } from "waffle/browser/preview-host";
import { encode, MAX_EXCHANGES, MAX_FRAME, OWNER_PATH, ownerFrame, type HostFrame, type OwnerFrame } from "./preview-owner-protocol";

export class PreviewCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], message = "Preview owner physical cleanup failed") {
    super(errors, message);
    this.name = "PreviewCleanupError";
  }
}

export interface OwnerBinding {
  authorization: PreviewHostAuthorization;
  dispatcher: PreviewHostDispatcher;
  close(): void;
}
export type BindPreviewOwner = (options: { origin: string; port: number; signal: AbortSignal }) => Promise<OwnerBinding | null>;
interface Route {
  port: number;
  lifetime: AbortController;
  ready: ReturnType<typeof Promise.withResolvers<string>>;
  stage:
    | { kind: "pending" }
    | { kind: "binding"; bindOnly: AbortController }
    | { kind: "grant" | "ready"; binding: OwnerBinding };
}
interface Exchange { route: Route; exchange: PreviewHostExchange }
interface ClosingRoute { port: number; expected: "reserved" | "binding" | "bound"; timer: ReturnType<typeof setTimeout> }
const MAX_ROUTES = 128;

/** Private page-owner connection. Keep this object outside the application preview. */
export class PreviewOwnerClient {
  private readonly routes = new Map<string, Route>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly closingRoutes = new Map<string, ClosingRoute>();
  private readonly awaitingUnregisterAck = new Map<string, number>();
  private readonly retired = new Map<string, PreviewHostAuthorization>();
  private readonly pendingBinds = new Set<Promise<void>>();
  private readonly deferredBindings = new Set<OwnerBinding>();
  private readonly deferredBindControllers = new Set<AbortController>();
  private readonly cleanupErrors: unknown[] = [];
  private closed = false;
  private physicalShutdownStarted = false;
  private readonly stopped = Promise.withResolvers<void>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly bind: BindPreviewOwner,
    private readonly onClose?: () => void,
    private readonly shouldDeferBindingCleanup?: () => boolean,
  ) {
    socket.onmessage = event => { void this.receive(event.data).catch(() => this.close({ fromSocketClose: false })); };
    socket.onclose = () => { this.close({ fromSocketClose: true }); };
    socket.onerror = () => { this.close({ fromSocketClose: false }); };
  }

  static async connect(options: {
    baseURL: string;
    bind: BindPreviewOwner;
    signal: AbortSignal;
    onClose?: () => void;
    shouldDeferBindingCleanup?: () => boolean;
    fetch?: (input: URL, options: RequestInit) => Promise<Response>;
    webSocket?: (url: URL, protocols: string[]) => WebSocket;
  }): Promise<PreviewOwnerClient> {
    options.signal.throwIfAborted();
    const bootstrap = new URL(`${OWNER_PATH}/bootstrap`, options.baseURL);
    const response = await (options.fetch ?? fetch)(bootstrap, { method: "POST", signal: options.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`Preview owner bootstrap HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("ticket" in value) || typeof value.ticket !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.ticket)) {
      throw new TypeError("Invalid preview owner bootstrap");
    }
    options.signal.throwIfAborted();
    const url = new URL(OWNER_PATH, bootstrap);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = options.webSocket
      ? options.webSocket(url, ["bun-preview-owner", value.ticket])
      : new WebSocket(url, ["bun-preview-owner", value.ticket]);
    const client = new PreviewOwnerClient(socket, options.bind, options.onClose, options.shouldDeferBindingCleanup);
    const abort = () => client.close({ fromSocketClose: false });
    options.signal.addEventListener("abort", abort, { once: true });
    void client.stopped.promise.finally(() => options.signal.removeEventListener("abort", abort));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err !== undefined) reject(err);
        else resolve();
      };
      socket.addEventListener("open", () => finish(), { once: true });
      socket.addEventListener("close", () => finish(client.cleanupError() ?? new Error("Preview owner connection closed")), { once: true });
      void client.stopped.promise.then(() => finish(client.cleanupError() ?? new Error("Preview owner connection closed")));
    });
    return client;
  }

  private cleanupError(): PreviewCleanupError | null {
    return this.cleanupErrors.length > 0 ? new PreviewCleanupError([...this.cleanupErrors]) : null;
  }

  private closeBinding(binding: OwnerBinding): void {
    try {
      binding.close();
    } catch (error) {
      this.cleanupErrors.push(error);
    }
  }

  private isDeferring(): boolean {
    return Boolean(this.shouldDeferBindingCleanup?.()) && !this.physicalShutdownStarted;
  }

  register(port: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Preview owner connection closed"));
    if (this.routes.size + this.awaitingUnregisterAck.size >= MAX_ROUTES) return Promise.reject(new Error("Preview route limit"));
    if (Array.from(this.routes.values()).some(route => route.port === port)) return Promise.reject(new Error("Preview port already registered"));
    const route: Route = { port, lifetime: new AbortController(), ready: Promise.withResolvers<string>(), stage: { kind: "pending" } };
    const id = crypto.randomUUID();
    this.routes.set(id, route);
    try {
      this.send({ type: "register", id, port });
    } catch (error) {
      this.routes.delete(id);
      route.lifetime.abort();
      this.close({ fromSocketClose: false });
      return Promise.reject(error);
    }
    return route.ready.promise;
  }

  unregister(port: number): void {
    const found = Array.from(this.routes).find(([, route]) => route.port === port);
    if (!found) return;
    const [id, route] = found;
    this.routes.delete(id);
    this.awaitingUnregisterAck.set(id, route.port);
    this.retainClosing(id, route);
    this.release(route);
    try {
      this.send({ type: "unregister", id });
    } catch {
      this.close({ fromSocketClose: false });
    }
  }

  async shutdown(): Promise<void> {
    this.physicalShutdownStarted = true;
    this.close({ fromSocketClose: false });
    for (const controller of this.deferredBindControllers) controller.abort();
    this.deferredBindControllers.clear();
    for (const binding of Array.from(this.deferredBindings)) {
      this.deferredBindings.delete(binding);
      this.closeBinding(binding);
    }
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.stopped.resolve();
    } else {
      try {
        this.socket.close();
      } catch (error) {
        this.cleanupErrors.push(error);
        this.stopped.resolve();
      }
    }
    await Promise.allSettled([this.stopped.promise, ...Array.from(this.pendingBinds)]);
    for (const binding of Array.from(this.deferredBindings)) {
      this.deferredBindings.delete(binding);
      this.closeBinding(binding);
    }
    const err = this.cleanupError();
    if (err) throw err;
  }

  close(options: { fromSocketClose?: boolean } = {}): void {
    const fromSocketClose = options.fromSocketClose ?? false;
    if (this.closed) {
      if (fromSocketClose || this.socket.readyState === WebSocket.CLOSED) this.stopped.resolve();
      return;
    }
    this.closed = true;
    this.socket.onmessage = null;
    const routes = Array.from(this.routes.values());
    this.routes.clear();
    for (const route of this.closingRoutes.values()) clearTimeout(route.timer);
    this.closingRoutes.clear();
    this.awaitingUnregisterAck.clear();
    this.exchanges.clear();
    this.retired.clear();
    try { this.onClose?.(); } catch {}
    const defer = this.isDeferring();
    for (const route of routes) {
      if (defer) {
        route.lifetime.abort();
        route.ready.reject(new Error("Preview binding closed"));
        if (route.stage.kind === "binding") {
          this.deferredBindControllers.add(route.stage.bindOnly);
        } else if (route.stage.kind === "grant" || route.stage.kind === "ready") {
          this.deferredBindings.add(route.stage.binding);
        }
      } else {
        this.release(route);
      }
    }
    if (fromSocketClose || this.socket.readyState === WebSocket.CLOSED) {
      this.stopped.resolve();
    } else if (!defer) {
      try {
        this.socket.close();
      } catch (error) {
        this.cleanupErrors.push(error);
        this.stopped.resolve();
      }
    }
  }

  private release(route: Route): void {
    route.lifetime.abort();
    if (route.stage.kind === "binding") {
      route.stage.bindOnly.abort();
    } else if (route.stage.kind === "grant" || route.stage.kind === "ready") {
      const grant = route.stage.binding.authorization;
      this.retired.set(grant.capability, grant);
      const oldest = this.retired.keys().next().value;
      if (this.retired.size > 256 && oldest) this.retired.delete(oldest);
      this.closeBinding(route.stage.binding);
    }
    route.ready.reject(new Error("Preview binding closed"));
    for (const [id, item] of this.exchanges) if (item.route === route) this.exchanges.delete(id);
  }

  private retainClosing(id: string, route: Route): void {
    if (route.stage.kind === "ready") return;
    const expected = route.stage.kind === "pending" ? "reserved" : route.stage.kind === "grant" ? "bound" : "binding";
    this.closingRoutes.set(id, { port: route.port, expected, timer: setTimeout(() => this.close({ fromSocketClose: false }), 30_000) });
  }

  private finishClosing(id: string, expected: ClosingRoute["expected"]): void {
    const route = this.closingRoutes.get(id);
    if (!route) return;
    if (route.expected !== expected) throw new Error("Unexpected closing preview reply");
    clearTimeout(route.timer);
    this.closingRoutes.delete(id);
  }

  private send(frame: HostFrame): void {
    if (this.closed) return;
    if (this.socket.bufferedAmount > MAX_FRAME) {
      this.close({ fromSocketClose: false });
      return;
    }
    this.socket.send(encode(frame));
  }

  private async receive(source: unknown): Promise<void> {
    if (typeof source !== "string") throw new TypeError("Binary preview owner envelope");
    const frame = ownerFrame(source);
    if (frame.type === "reserved") { await this.reserved(frame); return; }
    if (frame.type === "bound") { this.bound(frame.id); return; }
    if (frame.type === "unregistered") { this.unregistered(frame); return; }
    if (frame.type === "expired" || frame.type === "busy") { this.routeTerminated(frame); return; }
    if (frame.type === "input") { this.input(frame.id, frame.input); return; }
    await this.open(frame);
  }

  private unregistered(frame: Extract<OwnerFrame, { type: "unregistered" }>): void {
    const closing = this.closingRoutes.get(frame.id);
    const ackedPort = this.awaitingUnregisterAck.get(frame.id);
    if (!closing && ackedPort === undefined) throw new Error("Unknown preview unregister");
    if ((closing && closing.port !== frame.port) || (ackedPort !== undefined && ackedPort !== frame.port)) {
      throw new Error("Wrong closing preview unregister");
    }
    if (closing) {
      clearTimeout(closing.timer);
      this.closingRoutes.delete(frame.id);
    }
    this.awaitingUnregisterAck.delete(frame.id);
  }

  private routeTerminated(frame: Extract<OwnerFrame, { type: "expired" | "busy" }>): void {
    const closing = this.closingRoutes.get(frame.id);
    const ackedPort = this.awaitingUnregisterAck.get(frame.id);
    if (closing || ackedPort !== undefined) {
      if ((closing && closing.port !== frame.port) || (ackedPort !== undefined && ackedPort !== frame.port)) {
        throw new Error(`Wrong closing preview ${frame.type}`);
      }
      if (closing) {
        clearTimeout(closing.timer);
        this.closingRoutes.delete(frame.id);
      }
      this.awaitingUnregisterAck.delete(frame.id);
      return;
    }
    const route = this.routes.get(frame.id);
    if (!route || route.port !== frame.port || (frame.type === "busy" ? route.stage.kind !== "pending" : route.stage.kind === "ready")) {
      throw new Error(`Unknown preview ${frame.type}`);
    }
    this.routes.delete(frame.id);
    const defer = this.isDeferring();
    if (defer) {
      route.lifetime.abort();
      if (route.stage.kind === "binding") this.deferredBindControllers.add(route.stage.bindOnly);
      else if (route.stage.kind === "grant") this.deferredBindings.add(route.stage.binding);
      route.ready.reject(new Error(frame.type === "busy" ? "Preview route busy" : "Preview reservation expired"));
      for (const [id, item] of this.exchanges) if (item.route === route) this.exchanges.delete(id);
    } else {
      route.lifetime.abort();
      if (route.stage.kind === "binding") {
        route.stage.bindOnly.abort();
      } else if (route.stage.kind === "grant") {
        const grant = route.stage.binding.authorization;
        this.retired.set(grant.capability, grant);
        const oldest = this.retired.keys().next().value;
        if (this.retired.size > 256 && oldest) this.retired.delete(oldest);
        this.closeBinding(route.stage.binding);
      }
      route.ready.reject(new Error(frame.type === "busy" ? "Preview route busy" : "Preview reservation expired"));
      for (const [id, item] of this.exchanges) if (item.route === route) this.exchanges.delete(id);
    }
  }

  private async reserved(frame: Extract<OwnerFrame, { type: "reserved" }>): Promise<void> {
    const closing = this.closingRoutes.get(frame.id);
    if (closing) {
      if (closing.expected !== "reserved" || closing.port !== frame.port) throw new Error("Wrong closing preview reservation");
      this.finishClosing(frame.id, "reserved");
      return;
    }
    const route = this.routes.get(frame.id);
    if (!route || route.port !== frame.port || route.stage.kind !== "pending") throw new Error("Unknown preview reservation");
    const deferred = Promise.withResolvers<void>();
    this.pendingBinds.add(deferred.promise);
    try {
      await this.runReservedBind(frame, route);
    } finally {
      this.pendingBinds.delete(deferred.promise);
      deferred.resolve();
    }
  }

  private revokeOrFinishBinding(id: string, route: Route): void {
    if (this.routes.get(id) === route) {
      this.routes.delete(id);
      this.awaitingUnregisterAck.set(id, route.port);
      route.ready.reject(new Error("Preview binding revoked"));
      try { this.send({ type: "unregister", id }); } catch {}
    } else {
      this.finishClosing(id, "binding");
    }
  }

  private async runReservedBind(frame: Extract<OwnerFrame, { type: "reserved" }>, route: Route): Promise<void> {
    const bindOnly = new AbortController();
    route.stage = { kind: "binding", bindOnly };
    if (this.closed || route.lifetime.signal.aborted) {
      this.finishClosing(frame.id, "binding");
      return;
    }
    let binding: OwnerBinding | null;
    try {
      binding = await this.bind({ origin: frame.origin, port: frame.port, signal: bindOnly.signal });
    } catch (error) {
      if (this.closed || route.lifetime.signal.aborted || bindOnly.signal.aborted) {
        this.finishClosing(frame.id, "binding");
        return;
      }
      throw error;
    }
    if (binding === null) {
      this.revokeOrFinishBinding(frame.id, route);
      return;
    }
    if (this.closed || route.lifetime.signal.aborted || this.routes.get(frame.id) !== route || this.isDeferring()) {
      if (this.isDeferring()) {
        this.deferredBindings.add(binding);
        this.revokeOrFinishBinding(frame.id, route);
        return;
      }
      this.closeBinding(binding);
      this.finishClosing(frame.id, "binding");
      return;
    }
    const grant = binding.authorization;
    if (grant.origin !== frame.origin || grant.port !== frame.port) {
      this.closeBinding(binding);
      throw new Error("Preview binding does not match reservation");
    }
    route.stage = { kind: "grant", binding };
    this.send({ type: "grant", id: frame.id, authorization: grant });
  }

  private bound(id: string): void {
    if (this.closingRoutes.has(id)) { this.finishClosing(id, "bound"); return; }
    const route = this.routes.get(id);
    if (!route || route.stage.kind !== "grant") throw new Error("Unknown preview grant");
    route.stage = { kind: "ready", binding: route.stage.binding };
    route.ready.resolve(route.stage.binding.authorization.origin);
  }

  private input(id: string, input: PreviewHostInput): void {
    const item = this.exchanges.get(id);
    if (!item) return;
    item.exchange.onmessage?.(input);
  }

  private async open(frame: Extract<OwnerFrame, { type: "open" }>): Promise<void> {
    if (this.exchanges.size >= MAX_EXCHANGES || this.exchanges.has(frame.id)) throw new Error("Preview exchange limit");
    const route = Array.from(this.routes.values()).find(r => r.stage.kind === "ready" && sameGrant(r.stage.binding.authorization, frame.open.authorization));
    if (!route || route.stage.kind !== "ready") {
      const retired = this.retired.get(frame.open.authorization.capability);
      if (!retired || !sameGrant(retired, frame.open.authorization)) throw new Error("Wrong preview owner/port grant");
      this.send({ type: "output", id: frame.id, output: { type: "error", message: "Preview binding closed" } });
      this.send({ type: "finish", id: frame.id });
      return;
    }
    const exchange: PreviewHostExchange = {
      onmessage: null,
      postMessage: output => this.send({ type: "output", id: frame.id, output }),
      close: () => { this.exchanges.delete(frame.id); this.send({ type: "finish", id: frame.id }); },
    };
    this.exchanges.set(frame.id, { route, exchange });
    try { await route.stage.binding.dispatcher.dispatch(frame.open, exchange); }
    catch { exchange.postMessage({ type: "error", message: "Preview dispatcher failed" }); exchange.close(); }
  }
}

function sameGrant(first: PreviewHostAuthorization, second: PreviewHostAuthorization): boolean {
  return first.owner === second.owner && first.port === second.port && first.origin === second.origin && first.capability === second.capability;
}
