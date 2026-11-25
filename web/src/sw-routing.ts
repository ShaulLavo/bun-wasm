import { createPreviewServiceWorker, type PreviewClient } from "waffle/browser/service-worker";
import type { PreviewMessage, PreviewReply } from "waffle/browser/preview-protocol";

export const UNROUTED_KEY = "__unrouted__";
const ROUTE_ID_PATTERN = /^(?:ws|mem|pg)-[a-zA-Z0-9._-]+$/;

export interface RoutedPreviewClient extends PreviewClient {
  readonly id?: string;
}

export interface RoutedPreviewSWOptions {
  scope: string;
  clients: {
    get(id: string): Promise<RoutedPreviewClient | undefined>;
    matchAll(options: { type: "window"; includeUncontrolled: true }): Promise<readonly RoutedPreviewClient[]>;
  };
  fetch(request: Request): Promise<Response>;
  socketScriptPath: string;
  headTimeoutMs?: number;
  hydrateTimeoutMs?: number;
  claimTimeoutMs?: number;
  createChannel?(): MessageChannel;
  unavailableResponse?(port: number): Response;
  serverErrorResponse?(message: string): Response;
  unusableResponse?(status: number, error: unknown): Response;
}

export interface ParsedPreviewPath {
  readonly route: string | undefined;
  readonly routeKey: string;
  readonly port: number;
  readonly target: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeKeyOf(route: string | undefined): string {
  return route ?? UNROUTED_KEY;
}

function textResponse(status: number, body: string, transient = false): Response {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
  };
  if (transient) headers["x-bun-preview-transient"] = "1";
  return new Response(body, { status, headers });
}

function injectSocket(
  stream: ReadableStream<Uint8Array>,
  socketScriptPath: string,
  port: number,
  routePrefix: string,
  route: string | undefined,
): ReadableStream<Uint8Array> {
  const routeAttr = route ? ` data-bun-route="${route}"` : "";
  const script = `<script src="${socketScriptPath}" data-bun-wasm-socket="shim" data-bun-port="${port}" data-bun-prefix="${routePrefix}"${routeAttr}></script>`;
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 1024) {
        const { value, done } = await reader.read();
        if (value) { chunks.push(value); length += value.length; }
        if (done || value?.includes(62)) break;
      }
      const initial = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { initial.set(chunk, at); at += chunk.length; }
      const decoded = new TextDecoder().decode(initial);
      const doctype = /^\s*<!doctype[^>]*>/i.exec(decoded)?.[0] ?? "";
      const offset = new TextEncoder().encode(doctype).length;
      controller.enqueue(initial.subarray(0, offset));
      controller.enqueue(new TextEncoder().encode(script));
      controller.enqueue(initial.subarray(offset));
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function clientIdentity(client: RoutedPreviewClient): string | undefined {
  return client.id;
}

export function createRoutedPreviewServiceWorker(options: RoutedPreviewSWOptions) {
  const scope = new URL(options.scope);
  const prefix = scope.pathname;
  const escaped = escapeRegex(prefix);
  const routedPath = new RegExp(`^${escaped}(?:r/((?:ws|mem|pg)-[a-zA-Z0-9._-]+)/)?(\\d{1,5})(/.*)?$`);
  const headTimeoutMs = options.headTimeoutMs ?? 15_000;
  const hydrateTimeoutMs = options.hydrateTimeoutMs ?? 150;
  const baseCreateChannel = options.createChannel ?? (() => new MessageChannel());
  const unavailableResponse = options.unavailableResponse ?? ((port: number) =>
    textResponse(502, `No bun.wasm server is listening on port ${port}.\nStart one in the playground (Bun.serve), then reload this page.\n`, true));
  const serverErrorResponse = options.serverErrorResponse ?? ((message: string) =>
    textResponse(502, `bun.wasm server error: ${message}\n`, true));
  const unusableResponse = options.unusableResponse ?? ((status: number, error: unknown) =>
    textResponse(502, `bun.wasm server sent an unusable response (status ${status}): ${String(error)}\n`));

  // Registry: clientId -> routeKey -> Set<port>
  const registry = new Map<string, Map<string, Set<number>>>();
  let hydrationInFlight: Promise<void> | null = null;

  function isPreviewURL(urlString: string): boolean {
    try {
      const parsed = new URL(urlString);
      return parsed.origin === scope.origin && parsed.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  }

  function parsePreviewPathname(pathname: string, search: string): ParsedPreviewPath | null {
    const match = routedPath.exec(pathname);
    if (!match) return null;
    const route = match[1];
    if (route !== undefined && !ROUTE_ID_PATTERN.test(route)) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const target = (match[3] ?? "/") + search;
    return { route, routeKey: routeKeyOf(route), port, target };
  }

  function registerPort(clientId: string, routeKey: string, port: number): void {
    let byRoute = registry.get(clientId);
    if (!byRoute) {
      byRoute = new Map();
      registry.set(clientId, byRoute);
    }
    let ports = byRoute.get(routeKey);
    if (!ports) {
      ports = new Set();
      byRoute.set(routeKey, ports);
    }
    ports.add(port);
  }

  function registerAllPorts(clientId: string, routeKey: string, ports: readonly number[]): void {
    let byRoute = registry.get(clientId);
    if (!byRoute) {
      byRoute = new Map();
      registry.set(clientId, byRoute);
    }
    byRoute.set(routeKey, new Set(ports));
  }

  function unregisterPort(clientId: string, routeKey: string, port: number): void {
    const byRoute = registry.get(clientId);
    const ports = byRoute?.get(routeKey);
    if (!ports) return;
    ports.delete(port);
    if (ports.size === 0) byRoute?.delete(routeKey);
    if (byRoute?.size === 0) registry.delete(clientId);
  }

  function matchesRoutePort(client: RoutedPreviewClient, routeKey: string, port: number): boolean {
    const id = clientIdentity(client);
    if (!id) return false;
    return Boolean(registry.get(id)?.get(routeKey)?.has(port));
  }

  function hasRegisteredOwner(windows: readonly RoutedPreviewClient[], routeKey: string, port: number): boolean {
    return windows.some((client) => !isPreviewURL(client.url) && matchesRoutePort(client, routeKey, port));
  }

  async function hydrateFromWindows(): Promise<void> {
    const windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appWindows = windows.filter((w) => !isPreviewURL(w.url) && Boolean(clientIdentity(w)));
    await Promise.all(
      appWindows.map((client) => new Promise<void>((resolve) => {
        const id = clientIdentity(client)!;
        const channel = baseCreateChannel();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          channel.port1.onmessage = null;
          try { channel.port1.close(); } catch {}
          try { channel.port2.close(); } catch {}
          resolve();
        };
        const timer = setTimeout(finish, hydrateTimeoutMs);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: unknown; route?: unknown; ports?: unknown } | null;
          if (data && data.type === "preview-sync-reply" && typeof data.route === "string" && Array.isArray(data.ports)) {
            const validPorts = data.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535);
            registerAllPorts(id, data.route, validPorts);
          }
          finish();
        };
        try {
          client.postMessage({ type: "preview-sync" } as unknown as PreviewMessage, [channel.port2]);
        } catch {
          finish();
        }
      })),
    );
  }

  async function ensureHydrated(routeKey: string, port: number, signal?: AbortSignal): Promise<readonly RoutedPreviewClient[]> {
    if (signal?.aborted) return [];
    let windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (signal?.aborted) return [];
    if (!hasRegisteredOwner(windows, routeKey, port)) {
      hydrationInFlight ??= hydrateFromWindows().finally(() => {
        hydrationInFlight = null;
      });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        void hydrationInFlight!.finally(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      if (signal?.aborted) return [];
      windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (signal?.aborted) return [];
    }
    return windows.filter((client) => !isPreviewURL(client.url) && matchesRoutePort(client, routeKey, port));
  }

  function createGuardedChannel(signal?: AbortSignal): MessageChannel {
    const raw = baseCreateChannel();
    const realPort1 = raw.port1;
    let userOnMessage: ((event: MessageEvent<PreviewReply>) => void) | null = null;
    let headReceived = false;
    let exchangeCompleted = false;
    let headTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (headTimer !== undefined) {
        clearTimeout(headTimer);
        headTimer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const failExchange = (message: string) => {
      if (exchangeCompleted) return;
      exchangeCompleted = true;
      cleanup();
      try { realPort1.postMessage({ type: "cancel" }); } catch {}
      const handler = userOnMessage;
      userOnMessage = null;
      if (handler) {
        handler({ data: { type: "error", message } } as MessageEvent<PreviewReply>);
      }
      try { realPort1.close(); } catch {}
    };

    const onAbort = () => {
      failExchange("Preview request aborted");
    };

    if (signal) {
      if (signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    realPort1.onmessage = (event: MessageEvent<PreviewReply>) => {
      if (exchangeCompleted) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      switch (msg.type) {
        case "accepted":
          if (!headReceived && !exchangeCompleted && headTimer === undefined) {
            headTimer = setTimeout(() => failExchange("Preview server timed out waiting for response headers"), headTimeoutMs);
          }
          userOnMessage?.(event);
          return;
        case "head":
          headReceived = true;
          if (headTimer !== undefined) {
            clearTimeout(headTimer);
            headTimer = undefined;
          }
          userOnMessage?.(event);
          return;
        case "none":
        case "error":
          exchangeCompleted = true;
          cleanup();
          userOnMessage?.(event);
          return;
        case "end":
          if (!headReceived) {
            exchangeCompleted = true;
            cleanup();
            const handler = userOnMessage;
            userOnMessage = null;
            handler?.({
              data: { type: "error", message: "Preview server closed connection before response headers" },
            } as MessageEvent<PreviewReply>);
            try { realPort1.close(); } catch {}
            return;
          }
          exchangeCompleted = true;
          cleanup();
          userOnMessage?.(event);
          return;
        default:
          userOnMessage?.(event);
          return;
      }
    };

    const wrappedPort1 = {
      get onmessage() { return userOnMessage; },
      set onmessage(fn: ((event: MessageEvent<PreviewReply>) => void) | null) { userOnMessage = fn; },
      postMessage(message: unknown, transfer?: Transferable[]) {
        if (transfer) realPort1.postMessage(message, transfer);
        else realPort1.postMessage(message);
      },
      close() {
        if (!exchangeCompleted) {
          exchangeCompleted = true;
          cleanup();
          try { realPort1.postMessage({ type: "cancel" }); } catch {}
        } else {
          cleanup();
        }
        realPort1.close();
      },
      start() { realPort1.start(); },
      addEventListener: realPort1.addEventListener.bind(realPort1),
      removeEventListener: realPort1.removeEventListener.bind(realPort1),
      dispatchEvent: realPort1.dispatchEvent.bind(realPort1),
    } as unknown as MessagePort;

    return { port1: wrappedPort1, port2: raw.port2 } as MessageChannel;
  }

  function makeScopedAdapter(route: string | undefined, routeKey: string, port: number, signal?: AbortSignal) {
    const routePrefix = route ? `${prefix}r/${route}/` : prefix;
    return createPreviewServiceWorker({
      scope: options.scope,
      claimTimeoutMs: options.claimTimeoutMs,
      fetch: options.fetch,
      createChannel: () => createGuardedChannel(signal),
      clients: {
        get: (id) => options.clients.get(id),
        matchAll: async () => {
          const matched = await ensureHydrated(routeKey, port, signal);
          if (signal?.aborted) return [];
          return matched.map((client): RoutedPreviewClient => ({
            id: client.id,
            url: client.url,
            postMessage(message, transfer) {
              if (signal?.aborted) {
                for (const p of transfer) {
                  try { p.close(); } catch {}
                }
                throw new DOMException("Preview request aborted", "AbortError");
              }
              client.postMessage({ ...message, route: routeKey } as unknown as PreviewMessage, transfer);
            },
          }));
        },
      },
      transformResponse(response, responsePort) {
        const html = response.headers.get("content-type")?.toLowerCase().includes("text/html") && !response.headers.get("content-encoding");
        if (!html || !response.body) return response;
        const headers = new Headers(response.headers);
        headers.set("cross-origin-embedder-policy", "require-corp");
        headers.set("cross-origin-opener-policy", "same-origin");
        return new Response(
          injectSocket(response.body, options.socketScriptPath, responsePort, routePrefix, route),
          { status: response.status, statusText: response.statusText, headers },
        );
      },
      unavailableResponse,
      serverErrorResponse,
      unusableResponse,
    });
  }

  async function forwardRequest(request: Request, parsed: ParsedPreviewPath, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) {
      return textResponse(502, "Preview request aborted\n", false);
    }
    const rewrittenUrl = new URL(`${prefix}${parsed.port}${parsed.target}`, scope.origin).href;
    const forwardedRequest = new Request(rewrittenUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      ...(request.method !== "GET" && request.method !== "HEAD" ? { duplex: "half" as const } : {}),
    } as RequestInit);
    const adapter = makeScopedAdapter(parsed.route, parsed.routeKey, parsed.port, signal);
    return (await adapter.fetch(forwardedRequest, "")) ?? unavailableResponse(parsed.port);
  }

  async function fetchFromClient(request: Request, clientId: string, originalTarget: string, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) return textResponse(502, "Preview request aborted\n", false);
    const client = await options.clients.get(clientId);
    if (signal?.aborted) return textResponse(502, "Preview request aborted\n", false);
    if (!client || !isPreviewURL(client.url)) return options.fetch(request);
    const clientUrl = new URL(client.url);
    const parsedClient = parsePreviewPathname(clientUrl.pathname, "");
    if (!parsedClient) return options.fetch(request);
    return forwardRequest(
      request,
      { route: parsedClient.route, routeKey: parsedClient.routeKey, port: parsedClient.port, target: originalTarget },
      signal,
    );
  }

  function handleFetch(request: Request, clientId: string, signal?: AbortSignal): Promise<Response> | undefined {
    const url = new URL(request.url);
    if (url.origin !== scope.origin) return;
    const parsed = parsePreviewPathname(url.pathname, url.search);
    if (parsed) return forwardRequest(request, parsed, signal);
    if (clientId) return fetchFromClient(request, clientId, url.pathname + url.search, signal);
  }

  function ackRegister(reply: MessagePort | undefined): void {
    if (!reply) return;
    try { reply.postMessage({ type: "preview-register-ack" }); } finally { try { reply.close(); } catch {} }
  }

  function handleMessage(event: {
    data: unknown;
    ports: readonly MessagePort[];
    source: { readonly id?: string; readonly url?: string } | null;
  }): Promise<void> | undefined {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    const type = data.type;
    const clientId = event.source?.id;

    if (type === "preview-register" && clientId && typeof data.route === "string" && typeof data.port === "number") {
      registerPort(clientId, data.route, data.port);
      ackRegister(event.ports[0]);
      return;
    }
    if (type === "preview-register-all" && clientId && typeof data.route === "string" && Array.isArray(data.ports)) {
      const validPorts = data.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535);
      registerAllPorts(clientId, data.route, validPorts);
      ackRegister(event.ports[0]);
      return;
    }
    if (type === "preview-unregister" && clientId && typeof data.route === "string" && typeof data.port === "number") {
      unregisterPort(clientId, data.route, data.port);
      return;
    }
    if (type === "preview-socket" && event.ports[0]) {
      const sourceUrl = event.source?.url;
      if (!sourceUrl || !isPreviewURL(sourceUrl)) {
        try { event.ports[0].postMessage({ type: "error" }); } catch {}
        try { event.ports[0].close(); } catch {}
        return;
      }
      const parsed = parsePreviewPathname(new URL(sourceUrl).pathname, "");
      if (!parsed || typeof data.port !== "number" || parsed.port !== data.port) {
        try { event.ports[0].postMessage({ type: "error" }); } catch {}
        try { event.ports[0].close(); } catch {}
        return;
      }
      const adapter = makeScopedAdapter(parsed.route, parsed.routeKey, parsed.port);
      const numericClientUrl = new URL(`${prefix}${parsed.port}/`, scope.origin).href;
      return adapter.socket(parsed.port, numericClientUrl, event.ports[0]);
    }
  }

  return {
    fetch: handleFetch,
    message: handleMessage,
    parsePreviewPathname,
    registry,
  };
}
