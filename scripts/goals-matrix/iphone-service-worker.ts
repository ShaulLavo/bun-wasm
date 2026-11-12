// Runs before the unchanged product service worker in the test delivery.
export function observeIphoneServiceWorker(endpoint: string): void {
  const original = FetchEvent.prototype.respondWith;
  Object.defineProperty(FetchEvent.prototype, "respondWith", { value(this: FetchEvent, response: Response | PromiseLike<Response>) {
    return original.call(this, transform(Promise.resolve(response), this.request));
  } });
  async function transform(pending: Promise<Response>, request: Request): Promise<Response> {
    const response = await pending;
    if (request.mode !== "navigate" || response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response;
    const observer = await fetch(endpoint + "/preview/script?url=" + encodeURIComponent(request.url), { cache: "no-store" });
    if (observer.status === 204) return response;
    if (!observer.ok || response.headers.has("content-encoding")) throw new Error("Cannot instrument iPhone service-worker preview");
    const source = await observer.text();
    const html = await response.text();
    if (html.length > 2 * 1024 * 1024 || !/<\/body\s*>/i.test(html)) throw new Error("Unusable iPhone service-worker preview HTML");
    const headers = new Headers(response.headers);
    for (const key of ["content-length", "etag", "last-modified"]) headers.delete(key);
    headers.set("cache-control", "no-store");
    if (!headers.has("cross-origin-resource-policy")) headers.set("cross-origin-resource-policy", "cross-origin");
    const closing = Array.from(html.matchAll(/<\/body\s*>/gi)).at(-1)?.index;
    if (closing === undefined) throw new Error("Missing service-worker preview closing body");
    const body = html.slice(0, closing) + `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>` + html.slice(closing);
    return new Response(body, { status: response.status, headers });
  }
}
