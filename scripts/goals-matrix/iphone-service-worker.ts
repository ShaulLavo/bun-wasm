// Serialized before the product service worker. Diagnostics keep scalar copies only.
export function observeIphoneServiceWorker(endpoint: string): void {
  type Fields = Record<string, string | number | null>;
  type Binding = { id: string; nonce: string; url: string };
  const original = FetchEvent.prototype.respondWith;
  Object.defineProperty(FetchEvent.prototype, "respondWith", { value(this: FetchEvent, response: Response | PromiseLike<Response>) {
    const request = this.request;
    const trace = start(request.url, request.method, request.mode);
    return original.call(this, transform(Promise.resolve(response), request, trace));
  } });
  async function binding(response: Response): Promise<Binding | null> {
    if (response.status === 204) return null;
    const row: unknown = await response.json();
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !("nonce" in row) || typeof row.nonce !== "string" || !("url" in row) || typeof row.url !== "string") throw new Error("Invalid response observation binding");
    return { id: row.id, nonce: row.nonce, url: row.url };
  }
  function send(grant: Binding | null, row: Fields): void {
    if (!grant) return;
    const body = JSON.stringify({ ...grant, ...row });
    void fetch(endpoint + "/preview/response/event", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
  function start(url: string, method: string, mode: string): (event: string, fields?: Fields) => void {
    let sequence = 0;
    const grant = mode === "navigate" ? fetch(endpoint + "/preview/response/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, method }), signal: AbortSignal.timeout(3000),
    }).then(binding).catch(() => null) : Promise.resolve(null);
    return (event, fields = {}) => {
      const row = { event, sequence: ++sequence, clientAt: Date.now(), ...fields };
      void grant.then(value => send(value, row));
    };
  }
  async function transform(pending: Promise<Response>, request: Request, trace: ReturnType<typeof start>): Promise<Response> {
    const progress = { stage: "response" };
    trace("request");
    try {
      return await respond(pending, request, trace, progress);
    } catch (error) {
      trace("failure", { stage: progress.stage, error: String(error).slice(0, 2048) });
      throw error;
    }
  }
  async function respond(pending: Promise<Response>, request: Request, trace: ReturnType<typeof start>, progress: { stage: string }): Promise<Response> {
    const response = await pending;
    trace("head", { status: response.status, contentType: response.headers.get("content-type"), contentEncoding: response.headers.get("content-encoding"), contentLength: response.headers.get("content-length"), contentSecurityPolicy: response.headers.get("content-security-policy"), frameOptions: response.headers.get("x-frame-options"), embedderPolicy: response.headers.get("cross-origin-embedder-policy"), resourcePolicy: response.headers.get("cross-origin-resource-policy") });
    if (request.mode !== "navigate" || response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response;
    progress.stage = "observer-fetch";
    trace("observer-fetch-start");
    const observer = await fetch(endpoint + "/preview/script?url=" + encodeURIComponent(request.url), { cache: "no-store" });
    trace("observer-fetch-end", { status: observer.status });
    if (observer.status === 204) return response;
    if (!observer.ok || response.headers.has("content-encoding")) throw new Error("Cannot instrument iPhone service-worker preview");
    progress.stage = "observer-body";
    const source = await observer.text();
    trace("observer-body-end", { characters: source.length });
    progress.stage = "body";
    trace("body-start");
    const html = await response.text();
    trace("body-end", { characters: html.length });
    progress.stage = "inject";
    if (html.length > 2 * 1024 * 1024 || !/<\/body\s*>/i.test(html)) throw new Error("Unusable iPhone service-worker preview HTML");
    const headers = new Headers(response.headers);
    for (const key of ["content-length", "etag", "last-modified"]) headers.delete(key);
    headers.set("cache-control", "no-store");
    if (!headers.has("cross-origin-resource-policy")) headers.set("cross-origin-resource-policy", "cross-origin");
    const closing = Array.from(html.matchAll(/<\/body\s*>/gi)).at(-1)?.index;
    if (closing === undefined) throw new Error("Missing service-worker preview closing body");
    const body = html.slice(0, closing) + `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>` + html.slice(closing);
    trace("transform-end", { characters: body.length });
    return new Response(body, { status: response.status, headers });
  }
}
