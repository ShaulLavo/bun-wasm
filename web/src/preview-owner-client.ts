import type { PreviewHostAuthorization, PreviewHostDispatcher, PreviewHostExchange, PreviewHostInput } from "waffle/browser/preview-host";
import { encode, MAX_EXCHANGES, MAX_FRAME, OWNER_PATH, ownerFrame, type HostFrame, type OwnerFrame } from "./preview-owner-protocol";

export interface OwnerBinding {
  authorization: PreviewHostAuthorization;
  dispatcher: PreviewHostDispatcher;
  close(): void;
}
type BindPreviewOwner = (options: { origin: string; port: number; signal: AbortSignal }) => Promise<OwnerBinding>;
interface Route {
  port: number;
  lifetime: AbortController;
  ready: ReturnType<typeof Promise.withResolvers<string>>;
  stage: { kind: "pending" } | { kind: "binding" } | { kind: "grant" | "ready"; binding: OwnerBinding };
}
interface Exchange { route: Route; exchange: PreviewHostExchange }
interface ClosingRoute { port: number; expected: "reserved" | "binding" | "bound"; timer: ReturnType<typeof setTimeout> }
const MAX_ROUTES = 128;

/** Private page-owner connection. Keep this object outside the application preview. */
export class PreviewOwnerClient {
  private readonly routes = new Map<string, Route>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly closingRoutes = new Map<string, ClosingRoute>();
  private readonly retired = new Map<string, PreviewHostAuthorization>();
  private closed = false;
  private readonly stopped = Promise.withResolvers<void>();
  private constructor(private readonly socket: WebSocket, private readonly bind: BindPreviewOwner) {
    socket.onmessage = event => { void this.receive(event.data).catch(() => this.close()); };
    socket.onclose = () => { this.close(); this.stopped.resolve(); };
    socket.onerror = () => this.close();
  }

  static async connect(options: { baseURL: string; bind: BindPreviewOwner; signal: AbortSignal; fetch?: (input: URL, options: RequestInit) => Promise<Response>; webSocket?: (url: URL, protocols: string[]) => WebSocket }): Promise<PreviewOwnerClient> {
    options.signal.throwIfAborted();
    const bootstrap = new URL(`${OWNER_PATH}/bootstrap`, options.baseURL);
    const response = await (options.fetch ?? fetch)(bootstrap, { method: "POST", signal: options.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`Preview owner bootstrap HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("ticket" in value) || typeof value.ticket !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.ticket)) throw new TypeError("Invalid preview owner bootstrap");
    options.signal.throwIfAborted();
    const url = new URL(OWNER_PATH, bootstrap);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = options.webSocket ? options.webSocket(url, ["bun-preview-owner", value.ticket]) : new WebSocket(url, ["bun-preview-owner", value.ticket]);
    const client = new PreviewOwnerClient(socket, options.bind);
    const abort = () => client.close();
    options.signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("close", () => options.signal.removeEventListener("abort", abort), { once: true });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("close", () => reject(new Error("Preview owner connection closed")), { once: true });
    });
    return client;
  }

  register(port: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Preview owner connection closed"));
    if (this.routes.size + this.closingRoutes.size >= MAX_ROUTES) return Promise.reject(new Error("Preview route limit"));
    if (Array.from(this.routes.values()).some(route => route.port === port)) return Promise.reject(new Error("Preview port already registered"));
    const route: Route = { port, lifetime: new AbortController(), ready: Promise.withResolvers<string>(), stage: { kind: "pending" } };
    const id = crypto.randomUUID();
    this.routes.set(id, route);
    this.send({ type: "register", id, port });
    return route.ready.promise;
  }

  unregister(port: number): void {
    const found = Array.from(this.routes).find(([, route]) => route.port === port);
    if (!found) return;
    const [id, route] = found;
    this.routes.delete(id);
    this.retainClosing(id, route);
    this.release(route);
    this.send({ type: "unregister", id });
  }

  shutdown(): Promise<void> { this.close(); return this.stopped.promise; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const route of this.routes.values()) this.release(route);
    this.routes.clear();
    for (const route of this.closingRoutes.values()) clearTimeout(route.timer);
    this.closingRoutes.clear();
    this.exchanges.clear();
    this.retired.clear();
    this.socket.close();
  }

  private release(route: Route): void {
    route.lifetime.abort();
    if (route.stage.kind === "grant" || route.stage.kind === "ready") {
      const grant = route.stage.binding.authorization;
      this.retired.set(grant.capability, grant);
      const oldest = this.retired.keys().next().value;
      if (this.retired.size > 256 && oldest) this.retired.delete(oldest);
      route.stage.binding.close();
    }
    route.ready.reject(new Error("Preview binding closed"));
    for (const [id, item] of this.exchanges) if (item.route === route) this.exchanges.delete(id);
  }
  private retainClosing(id: string, route: Route): void {
    if (route.stage.kind === "ready") return;
    const expected = route.stage.kind === "pending" ? "reserved" : route.stage.kind === "grant" ? "bound" : "binding";
    this.closingRoutes.set(id, { port: route.port, expected, timer: setTimeout(() => this.close(), 30_000) });
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
    if (this.socket.bufferedAmount > MAX_FRAME) { this.close(); return; }
    this.socket.send(encode(frame));
  }
  private async receive(source: unknown): Promise<void> {
    if (typeof source !== "string") throw new TypeError("Binary preview owner envelope");
    const frame = ownerFrame(source);
    if (frame.type === "reserved") { await this.reserved(frame); return; }
    if (frame.type === "bound") { this.bound(frame.id); return; }
    if (frame.type === "input") { this.input(frame.id, frame.input); return; }
    await this.open(frame);
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
    route.stage = { kind: "binding" };
    let binding: OwnerBinding;
    try { binding = await this.bind({ origin: frame.origin, port: frame.port, signal: route.lifetime.signal }); }
    catch (error) { if (route.lifetime.signal.aborted) { this.finishClosing(frame.id, "binding"); return; } throw error; }
    if (this.closed || route.lifetime.signal.aborted) { binding.close(); this.finishClosing(frame.id, "binding"); return; }
    const grant = binding.authorization;
    if (grant.origin !== frame.origin || grant.port !== frame.port) { binding.close(); throw new Error("Preview binding does not match reservation"); }
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
    const route = Array.from(this.routes.values()).find(route => route.stage.kind === "ready" && sameGrant(route.stage.binding.authorization, frame.open.authorization));
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
