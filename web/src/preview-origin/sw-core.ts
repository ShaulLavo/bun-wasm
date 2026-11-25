// The service worker of one preview origin. It answers every same-origin request by relaying it
// over a MessagePort to the IDE page that owns the dev server. It holds no grant and no cookie of
// record: the port reaches exactly one server, and only script-visible cookies ever come back.
//
// Globals stay out of this module so the routing can be unit-tested (sw.ts binds them).
import {
  COOKIE_PATH, FRAME_MESSAGE, RELAY_PATH, SHIM_PATH, SW_ATTACH, SW_COOKIES, SW_COOKIES_ACK, SW_NEED_PORT, SW_PATH, SW_SHIM, SW_SOCKET,
  type ScriptCookie, type SessionReply, type SessionRequest,
} from "./protocol";
import { insertAfterDoctype } from "../preview-html";
import { HttpExchange, type ResponseHead } from "./sw-exchange";

export interface OriginClient {
  readonly id: string;
  readonly url: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface OriginWorkerOptions {
  /** This worker's own origin. */
  origin: string;
  clients: {
    get(id: string): Promise<OriginClient | undefined>;
    /** Window clients of this origin, controlled or not. */
    matchAll(): Promise<readonly OriginClient[]>;
  };
  /** The page shim served at SHIM_PATH. */
  shimScript: string;
  /** Origins allowed to frame documents this worker generates or relays. */
  ideOrigins: readonly string[];
  userAgent?: string;
  /** Hang caps. None of them is a speed limit. */
  attachWaitMs?: number;
  headTimeoutMs?: number;
  idleCheckMs?: number;
  pingTimeoutMs?: number;
  cookieAckMs?: number;
  now?(): number;
}

interface OpenExchange {
  /** `carriedCookies`: this output arrived with changed script-visible cookies. */
  output(message: Extract<SessionReply, { t: "output" }>["output"], carriedCookies: boolean): void;
  fail(message: string): void;
}

interface Attachment {
  readonly clientId: string;
  readonly port: MessagePort;
  readonly exchanges: Map<number, OpenExchange>;
  readonly pings: Map<number, (alive: boolean) => void>;
  /** The IDE page answered on the port, so a live listener is behind it. */
  confirmed: boolean;
  lastSeen: number;
  verified: number;
}

interface RequestContext {
  readonly method: string;
  readonly navigation: boolean;
  /** A navigation of a frame inside the cross-origin isolated IDE page. */
  readonly framed: boolean;
  readonly clientId: string;
  readonly signal?: AbortSignal;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "set-cookie"]);
// The page cannot set these; the IDE supplies Cookie, Waffle supplies Host.
const DROP_REQUEST = new Set(["cookie", "host", "accept-encoding", "connection", "content-length"]);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Removes `frame-ancestors` from each policy of a combined Content-Security-Policy value. */
export function withoutFrameAncestors(value: string): string {
  return value.split(",")
    .map(policy => policy.split(";").filter(directive => !/^\s*frame-ancestors(\s|$)/i.test(directive)).join(";").trim())
    .filter(policy => policy !== "")
    .join(", ");
}

export function createPreviewOriginServiceWorker(options: OriginWorkerOptions) {
  const now = options.now ?? (() => Date.now());
  const attachWaitMs = options.attachWaitMs ?? 15_000;
  // Must outlast slow cold dev compiles.
  const headTimeoutMs = options.headTimeoutMs ?? 180_000;
  const idleCheckMs = options.idleCheckMs ?? 10_000;
  const pingTimeoutMs = options.pingTimeoutMs ?? 3_000;
  const cookieAckMs = options.cookieAckMs ?? 2_000;
  const frameAncestors = options.ideOrigins.length > 0 ? `frame-ancestors ${options.ideOrigins.join(" ")}` : "";

  /** Newest last. The newest live one is the elected owner's. */
  const attachments: Attachment[] = [];
  const attachWaiters = new Set<() => void>();
  const cookieWrites = new Map<number, (cookies: ScriptCookie[]) => void>();
  const cookieAcks = new Map<number, () => void>();
  const shimClients = new Set<string>();
  let cookies: ScriptCookie[] = [];
  let nextId = 1;
  let acquiring: Promise<Attachment | null> | null = null;
  // Requests and cookie writes leave in the order their events arrived.
  let order: Promise<unknown> = Promise.resolve();

  const isRelayUrl = (href: string) => {
    const url = new URL(href);
    return url.origin === options.origin && url.pathname === RELAY_PATH;
  };
  const isRelay = (client: OriginClient) => isRelayUrl(client.url);

  function post(attachment: Attachment, message: SessionRequest, transfer: Transferable[] = []): void {
    try { attachment.port.postMessage(message, transfer); } catch { retire(attachment); }
  }

  function retire(attachment: Attachment): void {
    const at = attachments.indexOf(attachment);
    if (at < 0) return;
    attachments.splice(at, 1);
    for (const exchange of Array.from(attachment.exchanges.values())) exchange.fail("The IDE tab serving this preview disconnected");
    for (const answer of Array.from(attachment.pings.values())) answer(false);
    attachment.port.onmessage = null;
    try { attachment.port.close(); } catch {}
    for (const wake of Array.from(attachWaiters)) wake();
  }

  /**
   * A port counts once the IDE page answers on it. A listener that was replaced while its port was
   * still on the way answers with `detach` only, so its port is never used, whatever order ports arrive in.
   */
  function confirm(attachment: Attachment): void {
    attachment.confirmed = true;
    // One relay frame serves one listener at a time: its earlier ports are over.
    for (const previous of attachments.filter(item => item !== attachment && item.confirmed && item.clientId === attachment.clientId)) retire(previous);
    for (const wake of Array.from(attachWaiters)) wake();
  }

  function receive(attachment: Attachment, reply: SessionReply): void {
    attachment.lastSeen = now();
    if (!attachment.confirmed && reply.t !== "detach") confirm(attachment);
    switch (reply.t) {
      case "pong": attachment.pings.get(reply.n)?.(true); return;
      case "detach": retire(attachment); return;
      case "finish": attachment.exchanges.get(reply.id)?.fail("Preview exchange closed"); return;
      case "cookies":
        cookies = reply.cookies;
        if (reply.id !== undefined) cookieWrites.get(reply.id)?.(reply.cookies);
        return;
      case "output": {
        const exchange = attachment.exchanges.get(reply.id);
        if (!exchange) return;
        if (reply.cookies) cookies = reply.cookies;
        exchange.output(reply.output, reply.cookies !== undefined);
        return;
      }
    }
  }

  function attach(clientId: string, port: MessagePort): void {
    const attachment: Attachment = { clientId, port, exchanges: new Map(), pings: new Map(), confirmed: false, lastSeen: now(), verified: now() };
    attachments.push(attachment);
    port.onmessage = (event: MessageEvent<SessionReply>) => receive(attachment, event.data);
    post(attachment, { t: "attached" });
    for (const wake of Array.from(attachWaiters)) wake();
  }

  function ping(attachment: Attachment): Promise<boolean> {
    return new Promise(resolve => {
      const n = nextId++;
      const answer = (alive: boolean) => {
        clearTimeout(timer);
        attachment.pings.delete(n);
        resolve(alive);
      };
      const timer = setTimeout(() => answer(false), pingTimeoutMs);
      attachment.pings.set(n, answer);
      post(attachment, { t: "ping", n });
    });
  }

  /** A closed tab's port stays silent forever, so an attachment proves itself before use. */
  async function usable(attachment: Attachment): Promise<boolean> {
    if (now() - attachment.verified < 250) return true;
    if (!(await options.clients.get(attachment.clientId))) return false;
    if (now() - attachment.lastSeen >= idleCheckMs && !(await ping(attachment))) return false;
    attachment.verified = now();
    return attachments.includes(attachment);
  }

  /** Resolves when the set of attachments changed, or after `ms`. */
  function attachmentsChanged(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const wake = () => {
        clearTimeout(timer);
        attachWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      attachWaiters.add(wake);
    });
  }

  /** Asks every relay frame for a port, once, unless one is already on its way to being confirmed. */
  async function askRelays(): Promise<boolean> {
    const relays = (await options.clients.matchAll()).filter(isRelay);
    for (const relay of relays) {
      try { relay.postMessage({ type: SW_NEED_PORT }); } catch {}
    }
    return relays.length > 0;
  }

  async function requestAttachment(): Promise<Attachment | null> {
    const deadline = now() + attachWaitMs;
    let asked = false;
    for (let left = attachWaitMs; left > 0; left = deadline - now()) {
      const confirmed = attachments.findLast(item => item.confirmed);
      if (confirmed) return confirmed;
      const pending = attachments.some(item => !item.confirmed);
      if (!pending && !asked && !(await askRelays())) return null;
      asked ||= !pending;
      await attachmentsChanged(left);
    }
    return attachments.findLast(item => item.confirmed) ?? null;
  }

  async function findAttachment(): Promise<Attachment | null> {
    // A port nobody confirmed within the wait belongs to a listener that is gone.
    for (const stale of attachments.filter(item => !item.confirmed && now() - item.lastSeen > attachWaitMs)) retire(stale);
    for (const attachment of attachments.filter(item => item.confirmed).reverse()) {
      if (await usable(attachment)) return attachment;
      retire(attachment);
    }
    return requestAttachment();
  }

  function acquire(): Promise<Attachment | null> {
    acquiring ??= findAttachment().catch(() => null).finally(() => { acquiring = null; });
    return acquiring;
  }

  /** Runs `send` once `ready` settled and everything queued before it was sent. */
  function inOrder<T>(ready: Promise<T>, send: (value: T) => void): void {
    order = order.then(() => ready).then(send).catch(() => {});
  }

  function documentHeaders(framed: boolean): Headers {
    const headers = new Headers({ "cache-control": "no-store" });
    if (framed) {
      headers.set("cross-origin-embedder-policy", "require-corp");
      headers.set("cross-origin-resource-policy", "cross-origin");
    }
    return headers;
  }

  /** This worker's own answer where the server gave none. Frames tell their embedder, which may retry. */
  function gateway(context: RequestContext, status: number, message: string, transient: boolean): Response {
    const headers = documentHeaders(context.framed);
    if (!context.navigation) {
      headers.set("content-type", "text/plain; charset=utf-8");
      return new Response(`${message}\n`, { status, headers });
    }
    const report = JSON.stringify({ type: FRAME_MESSAGE, event: "error", transient }).replaceAll("<", "\\u003c");
    const script = `if(parent!==window)parent.postMessage(Object.assign(${report},{href:location.href}),"*")`;
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", ["default-src 'none'", "script-src 'unsafe-inline'", "base-uri 'none'"].concat(frameAncestors || []).join("; "));
    return new Response(`<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><body><p role="status">${escapeHtml(message)}</p><script>${script}</script></body>`, { status, headers });
  }

  /**
   * A framed guest document must opt into the IDE page's cross-origin isolation or the browser
   * refuses to commit it, so an incompatible policy of the app's is overridden here.
   */
  function framePolicy(headers: Headers): void {
    const embedder = headers.get("cross-origin-embedder-policy")?.trim().toLowerCase() ?? "";
    if (!embedder.startsWith("require-corp") && !embedder.startsWith("credentialless")) headers.set("cross-origin-embedder-policy", "require-corp");
    headers.set("cross-origin-resource-policy", "cross-origin");
    headers.delete("x-frame-options");
    const policy = headers.get("content-security-policy");
    if (policy !== null) headers.delete("content-security-policy");
    const kept = policy === null ? "" : withoutFrameAncestors(policy);
    if (kept) headers.set("content-security-policy", kept);
    if (frameAncestors) headers.append("content-security-policy", frameAncestors);
  }

  function shimTag(): string {
    return `<script src="${SHIM_PATH}" data-bunwasm-preview="shim" data-cookies="${escapeHtml(JSON.stringify(cookies))}"></script>`;
  }

  function buildResponse(context: RequestContext, head: ResponseHead, stream: ReadableStream<Uint8Array>): Response {
    const headers = new Headers();
    for (const [name, value] of head.headers) {
      if (DROP_RESPONSE.has(name.toLowerCase())) continue;
      try { headers.append(name, value); } catch { /* A header the browser rejects is skipped. */ }
    }
    if (context.framed) framePolicy(headers);
    const bodyless = context.method === "HEAD" || NULL_BODY.has(head.status);
    const html = context.navigation && !bodyless
      && (headers.get("content-type")?.toLowerCase().includes("text/html") ?? false) && !headers.get("content-encoding");
    const body = bodyless ? null : html ? insertAfterDoctype(stream, shimTag()) : stream;
    try {
      return new Response(body, { status: head.status, statusText: head.statusText, headers });
    } catch (error) {
      void stream.cancel().catch(() => {});
      return gateway(context, 502, `bun.wasm server sent an unusable response (status ${head.status}): ${String(error)}`, false);
    }
  }

  /** Hands changed cookies to the requesting page before its response resolves. */
  async function deliverCookies(requester: string): Promise<void> {
    const windows = (await options.clients.matchAll()).filter(client => !isRelay(client));
    const waits: Promise<void>[] = [];
    for (const client of windows) {
      const wait = client.id === requester && shimClients.has(client.id);
      const ack = wait ? nextId++ : undefined;
      if (ack !== undefined) waits.push(new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          cookieAcks.delete(ack);
          resolve();
        };
        const timer = setTimeout(done, cookieAckMs);
        cookieAcks.set(ack, done);
      }));
      try { client.postMessage({ type: SW_COOKIES, cookies, ack }); } catch {}
    }
    await Promise.all(waits);
  }

  function requestHeaders(request: Request, url: URL): [string, string][] {
    const headers = Array.from(request.headers).filter(([name]) => !DROP_REQUEST.has(name.toLowerCase()));
    const has = (name: string) => headers.some(([key]) => key.toLowerCase() === name);
    // The browser adds these after the service worker, so the worker restores them.
    if (request.method !== "GET" && request.method !== "HEAD" && !has("origin")) headers.push(["origin", url.origin]);
    if (request.referrer && !has("referer")) headers.push(["referer", request.referrer]);
    if (options.userAgent && !has("user-agent")) headers.push(["user-agent", options.userAgent]);
    if (!has("sec-fetch-dest")) headers.push(["sec-fetch-dest", request.destination || "empty"]);
    if (!has("sec-fetch-mode")) headers.push(["sec-fetch-mode", request.mode]);
    return headers;
  }

  function relay(attachment: Attachment, context: RequestContext, request: Request, url: URL, body: ArrayBuffer | null): Promise<Response> {
    const id = nextId++;
    let carriedCookies = false;
    const exchange = new HttpExchange({
      send: input => post(attachment, { t: "input", id, input }),
      async respond(head, stream) {
        if (carriedCookies && !context.navigation) await deliverCookies(context.clientId);
        return buildResponse(context, head, stream);
      },
      failed: message => gateway(context, 502, `bun.wasm server error: ${message}`, true),
      released: () => { attachment.exchanges.delete(id); },
      signal: context.signal,
      headTimeoutMs,
    });
    attachment.exchanges.set(id, {
      fail: message => exchange.fail(message),
      output(message, carried) {
        carriedCookies ||= carried;
        exchange.output(message);
      },
    });
    post(attachment, {
      t: "open", id, url: url.href, method: request.method, headers: requestHeaders(request, url), body,
      credentials: request.credentials === "omit" ? "omit" : "include",
    }, body ? [body] : []);
    return exchange.response;
  }

  function forward(request: Request, url: URL, clientId: string): Promise<Response> {
    const navigation = request.mode === "navigate";
    const context: RequestContext = {
      method: request.method,
      navigation,
      framed: navigation && request.destination !== "document",
      clientId,
      signal: request.signal,
    };
    const bodyless = request.method === "GET" || request.method === "HEAD";
    // Both start now, so a request waits only for its own body and for what arrived before it.
    const ready = Promise.all([acquire(), bodyless ? null : request.arrayBuffer()]).catch(() => null);
    return new Promise<Response>(resolve => {
      inOrder(ready, prepared => {
        const attachment = prepared?.[0];
        if (!prepared) { resolve(gateway(context, 400, "The preview request body could not be read.", false)); return; }
        if (!attachment) { resolve(gateway(context, 503, "This preview is not connected to its IDE tab. Open it from the IDE.", true)); return; }
        resolve(relay(attachment, context, request, url, prepared[1]));
      });
    });
  }

  /** A `document.cookie` write. It arrives as a fetch so that it keeps its place among requests. */
  function cookieWrite(url: URL): Promise<Response> {
    const line = url.searchParams.get("line") ?? "";
    const page = url.searchParams.get("url") ?? `${options.origin}/`;
    const answer = (list: ScriptCookie[]) => new Response(JSON.stringify(list), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    return new Promise<Response>(resolve => {
      inOrder(acquire(), attachment => {
        if (!attachment) { resolve(answer(cookies)); return; }
        const id = nextId++;
        const done = (list: ScriptCookie[]) => {
          clearTimeout(timer);
          cookieWrites.delete(id);
          resolve(answer(list));
        };
        const timer = setTimeout(() => done(cookies), attachWaitMs);
        cookieWrites.set(id, done);
        post(attachment, { t: "cookie", id, line, url: page });
      });
    });
  }

  function socket(port: MessagePort): void {
    inOrder(acquire(), attachment => {
      if (attachment) { post(attachment, { t: "socket" }, [port]); return; }
      try { port.postMessage({ type: "error", message: "This preview is not connected to its IDE tab." }); } catch {}
      port.close();
    });
  }

  function handleFetch(request: Request, clientId: string): Promise<Response> | undefined {
    const url = new URL(request.url);
    if (url.origin !== options.origin) return;
    // The relay page and this script come from the static host.
    if (url.pathname === SW_PATH || url.pathname === RELAY_PATH) return;
    if (url.pathname === SHIM_PATH) {
      return Promise.resolve(new Response(options.shimScript, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } }));
    }
    if (url.pathname === COOKIE_PATH) return cookieWrite(url);
    return forward(request, url, clientId);
  }

  function handleMessage(event: { data: unknown; ports: readonly MessagePort[]; source: { readonly id?: string; readonly url?: string } | null }): void {
    const data = event.data as { type?: unknown; ack?: unknown } | null;
    const source = event.source;
    if (!data || typeof data !== "object" || !source?.id || !source.url) return;
    const port = event.ports[0];
    const fromRelay = isRelayUrl(source.url);
    if (data.type === SW_ATTACH && fromRelay && port) { attach(source.id, port); return; }
    if (fromRelay || new URL(source.url).origin !== options.origin) return;
    if (data.type === SW_SOCKET && port) { socket(port); return; }
    if (data.type === SW_COOKIES_ACK && typeof data.ack === "number") { cookieAcks.get(data.ack)?.(); return; }
    if (data.type !== SW_SHIM) return;
    shimClients.add(source.id);
    const oldest = shimClients.values().next().value;
    if (shimClients.size > 64 && oldest !== undefined) shimClients.delete(oldest);
  }

  return { fetch: handleFetch, message: handleMessage, attachments };
}
