(function (internal: BunWasm.Internal & {
  require(name: "dev_html_client"): { source: string };
  require(name: "html_rewriter"): { HTMLRewriter: new() => {
    on(selector: string, handlers: { element(token: { tagName: string; getAttribute(name: string): string | null | undefined; prepend(text: string, options: { html: boolean }): unknown }): void }): unknown;
    transform(text: string): string;
  } };
}) {
  "use strict";
  type Stamp = BunWasm.HotCommittedStamp;
  type Server = Pick<BunWasm.HotServer, "port"> & { upgrade(request: Request, options: { data: unknown }): boolean };
  type Socket = BunWasm.WebSocketServerSocket;
  type Pair = [string, string];
  const limit = 256 * 1024;
  const marker = "data-bun-wasm-dev";
  const rawHeader = "x-bun-wasm-dev-raw";
  const stampHeader = "x-bun-wasm-dev-stamp";
  const policyHeader = "x-bun-wasm-dev-policy";
  const policies = ["cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "origin-agent-cluster", "referrer-policy", "permissions-policy"];
  const stale = new Set(["content-length", "transfer-encoding", "etag", "last-modified", "content-md5", "digest"]);
  const encoder = new TextEncoder();
  const owned = Symbol("development HTML socket");

  function bytes(response: Response): Uint8Array<ArrayBuffer> | null {
    const body: unknown = Reflect.get(response, "_body");
    if (response.bodyUsed || !(body instanceof Uint8Array) || !(body.buffer instanceof ArrayBuffer)) return null;
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  function htmlType(value: string | null): boolean {
    if (!value || value.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") return false;
    const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(value);
    const declared = (charset?.[1] ?? charset?.[2] ?? charset?.[3])?.toLowerCase();
    return declared === undefined || ["utf-8", "utf8", "us-ascii"].includes(declared);
  }

  function eligible(request: Request, response: Response): boolean {
    const headers = response.headers;
    return request.method === "GET" && response.status === 200 && !request.signal.aborted && htmlType(headers.get("content-type"))
      && !request.headers.has("range") && !headers.has("content-range")
      && (!headers.has("content-encoding") || headers.get("content-encoding")?.trim().toLowerCase() === "identity")
      && !/\battachment\b/i.test(headers.get("content-disposition") ?? "")
      && !headers.has("content-security-policy") && !headers.has("content-security-policy-report-only");
  }

  function json(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }

  function responsePairs(response: Response, values: Record<string, string>, transformed: boolean): Pair[] {
    const skip = new Set(Object.keys(values));
    const pairs: Pair[] = [];
    // Guest Headers iterates cookies separately. Its Headers-copy constructor duplicates them.
    for (const [name, value] of response.headers) {
      if (skip.has(name) || transformed && stale.has(name)) continue;
      pairs.push([name, value]);
    }
    for (const [name, value] of Object.entries(values)) pairs.push([name, value]);
    return pairs;
  }

  async function transform(html: string, injection: string): Promise<string | null> {
    let heads = 0;
    let roots = 0;
    let unsupported = false;
    const rewriter = new (internal.require("html_rewriter").HTMLRewriter)();
    rewriter.on("*", { element(token) {
      const name = token.tagName.toLowerCase();
      if (token.getAttribute(marker) != null || token.getAttribute("data-bun-wasm-socket") != null || name === "base") unsupported = true;
      if (name === "html") roots++;
      if (name === "meta" && /^(?:content-security-policy|refresh)$/i.test(token.getAttribute("http-equiv") ?? "")) unsupported = true;
      if (name === "meta" && token.getAttribute("charset") != null && !/^(?:utf-?8|us-ascii)$/i.test(token.getAttribute("charset") ?? "")) unsupported = true;
      if (name === "meta" && /^content-type$/i.test(token.getAttribute("http-equiv") ?? "") && !htmlType(token.getAttribute("content") ?? null)) unsupported = true;
      if (name === "head") { heads++; token.prepend(injection, { html: true }); }
    } });
    const result = await rewriter.transform(html);
    return !unsupported && heads === 1 && roots === 1 ? result : null;
  }

  function attach({ server, revisions }: { server: Server; revisions: BunWasm.HotCommittedRevisions }) {
    const clients = new Map<Socket, { dispose(): void }>();
    let current: Stamp | null = null;
    let closed = false;
    let unsubscribe = () => {};
    let warnedRevision = 0;
    const warnedRoutes = new Set<string>();
    const stopObserving = revisions.subscribe(notice => {
      if (notice.kind === "closed") { dispose(); return; }
      current = notice.stamp;
    });
    unsubscribe = stopObserving;
    if (closed) unsubscribe();

    function warn(request: Request, stamp: Stamp): void {
      if (stamp.revision < warnedRevision) return;
      if (stamp.revision > warnedRevision) { warnedRoutes.clear(); warnedRevision = stamp.revision; }
      const url = new URL(request.url);
      const route = url.pathname + url.search;
      if (warnedRoutes.has(route) || warnedRoutes.size >= 64) return;
      warnedRoutes.add(route);
      internal.printError(new Error("Development HTML update skipped for unsupported document policy or runtime markers"));
    }

    function paths(stamp: Stamp) {
      const root = `/_bun/wasm-dev/${encodeURIComponent(stamp.server)}`;
      return { client: `${root}/client.js`, events: `${root}/events` };
    }

    function route(request: Request): "client" | "events" | null {
      if (closed || !current) return null;
      const path = new URL(request.url).pathname;
      const expected = paths(current);
      if (path === expected.client) return "client";
      return path === expected.events ? "events" : null;
    }

    function validOrigin(request: Request): boolean {
      const origin = request.headers.get("origin");
      if (!origin) return false;
      return origin === new URL(request.url).origin || origin === `http://localhost:${server.port}`;
    }

    function respond(request: Request): Response | null {
      const kind = route(request);
      if (!kind) return null;
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (kind === "events") return validOrigin(request) ? null : new Response("Forbidden", { status: 403 });
      return new Response(internal.require("dev_html_client").source, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    }

    function upgrade(request: Request, actual = server): boolean {
      if (route(request) !== "events" || !validOrigin(request)) return false;
      return actual.upgrade(request, { data: owned });
    }

    function release(socket: Socket): void {
      const subscription = clients.get(socket);
      clients.delete(socket);
      subscription?.dispose();
    }

    function terminate(socket: Socket): void { release(socket); socket.terminate(); }

    function open(socket: Socket): void {
      if (closed || clients.size >= 64) { socket.terminate(); return; }
      let disposed = false;
      let stop = () => {};
      clients.set(socket, { dispose() { if (disposed) return; disposed = true; stop(); } });
      const observed = revisions.subscribe(notice => {
        if (disposed) return;
        if (notice.kind === "closed") { terminate(socket); return; }
        const payload = JSON.stringify(notice);
        if (socket.bufferedAmount + encoder.encode(payload).length > 4096) { terminate(socket); return; }
        try { socket.send(payload); }
        catch { terminate(socket); }
      });
      stop = observed;
      if (disposed) observed();
    }

    function websocket(handlers: BunWasm.WebSocketHandlers | undefined): BunWasm.WebSocketHandlers {
      return Object.assign(handlers ? {} : { maxPayloadLength: 1024 }, handlers, {
        open(socket: Socket) { if (socket.data === owned) return open(socket); return handlers?.open?.(socket); },
        message(socket: Socket, data: BunWasm.WebSocketMessage) { if (socket.data === owned) return terminate(socket); return handlers?.message?.(socket, data); },
        close(socket: Socket, code: number, reason: string) { if (socket.data === owned) return release(socket); return handlers?.close?.(socket, code, reason); },
        error(socket: Socket, error: unknown) { if (socket.data === owned) return terminate(socket); return handlers?.error?.(socket, error); },
        drain(socket: Socket) { if (socket.data !== owned) return handlers?.drain?.(socket); },
        ping(socket: Socket, data: BunWasm.WebSocketHandlerArgs["ping"][0]) { if (socket.data !== owned) return handlers?.ping?.(socket, data); },
        pong(socket: Socket, data: BunWasm.WebSocketHandlerArgs["pong"][0]) { if (socket.data !== owned) return handlers?.pong?.(socket, data); },
      });
    }

    async function decorate(request: Request, response: Response, stamp: Stamp): Promise<Response> {
      if (closed) return response;
      if (request.method === "GET" && response.status === 200 && (response.headers.has("content-security-policy") || response.headers.has("content-security-policy-report-only"))) warn(request, stamp);
      if (!eligible(request, response)) return response;
      const body = bytes(response);
      if (!body || body.length > limit) return response;
      let html: string;
      try { html = new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { return response; }
      if (/charset\s*=\s*["']?us-ascii/i.test(response.headers.get("content-type") ?? "") && body.some(byte => byte > 127)) return response;
      const policy = policies.map(name => response.headers.get(name));
      const config = { stamp, paths: paths(stamp), html, policy };
      const injection = `<script type="application/json" ${marker}="config">${json(config)}</script><script defer ${marker}="client" src="${paths(stamp).client}"></script>`;
      const transformed = await transform(html, request.headers.get(rawHeader) === "1" ? "" : injection);
      if (transformed === null) { warn(request, stamp); return response; }
      if (request.signal.aborted) return response;
      const raw = request.headers.get(rawHeader) === "1";
      const headers = responsePairs(response, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", [stampHeader]: JSON.stringify(stamp), [policyHeader]: JSON.stringify(policy) }, !raw);
      return new Response(raw ? body : transformed, { status: response.status, statusText: response.statusText, headers });
    }

    function dispose(): void {
      if (closed) return;
      closed = true;
      current = null;
      warnedRoutes.clear();
      unsubscribe();
      for (const socket of Array.from(clients.keys())) terminate(socket);
    }

    return { respond, upgrade, websocket, decorate, dispose };
  }
  return { attach };
})
