import { LoopbackPreviewOrigins } from "../../web/preview-origin-host";
import { IphoneBus } from "./iphone-bus";

export async function observeIphoneResponse(response: Response, url: string, bus: IphoneBus, endpoint: string): Promise<Response> {
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response;
  if (response.headers.has("content-encoding")) throw new Error("iPhone observer requires uncompressed HTML");
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error("iPhone observer HTML exceeds 2 MiB");
  const html = bus.inject(text, url, endpoint);
  if (html === text) return new Response(text, response);
  const headers = new Headers(response.headers);
  for (const key of ["content-length", "etag", "last-modified"]) headers.delete(key);
  headers.set("cache-control", "no-store");
  if (!headers.has("cross-origin-embedder-policy")) headers.set("cross-origin-embedder-policy", "require-corp");
  if (!headers.has("cross-origin-resource-policy")) headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(html, { status: response.status, headers });
}

export function observeIphoneOrigins(bus: IphoneBus, endpoint: string): () => void {
  const original = LoopbackPreviewOrigins.prototype.bind;
  LoopbackPreviewOrigins.prototype.bind = function (owner, port, target) {
    return original.call(this, owner, port, { ...target,
      fetch: async request => observeIphoneResponse(await target.fetch(request), request.url, bus, endpoint),
    });
  };
  return () => { LoopbackPreviewOrigins.prototype.bind = original; };
}

if (import.meta.main) {
  const token = process.env.GOALS_IPHONE_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token) || process.env.HOST !== "127.0.0.1" || process.env.PREVIEW_ORIGINS !== "1") throw new Error("Require loopback host, preview origins and GOALS_IPHONE_TOKEN");
  const bus = new IphoneBus("/__goals_iphone/" + token);
  let productOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.GOALS_IPHONE_PORT ?? 0), idleTimeout: 0, maxRequestBodySize: 512 * 1024,
    fetch: request => new URL(request.url).pathname.startsWith(bus.path + "/") ? bus.handle(request, productOrigin) : new Response(null, { status: 404 }),
  });
  observeIphoneOrigins(bus, control.url.origin);
  const serve = Bun.serve;
  Object.defineProperty(Bun, "serve", { configurable: true, writable: true, value(options: unknown) {
    if (!options || typeof options !== "object" || !("fetch" in options) || typeof options.fetch !== "function") throw new Error("Expected playground server options");
    const fetch = options.fetch;
    const server = Reflect.apply(serve, Bun, [{ ...options, async fetch(request: Request, server: unknown) {
      const response: unknown = await Reflect.apply(fetch, this, [request, server]);
      return response instanceof Response ? observeIphoneResponse(response, request.url, bus, control.url.origin) : response;
    } }]);
    productOrigin = String(server.url.origin);
    return server;
  } });
  await import("../../web/serve");
  Bun.serve = serve;
  console.log(JSON.stringify({ iphoneControl: control.url.origin + bus.path, productOrigin }));
  process.once("SIGTERM", () => { bus.close(); void control.stop(true); });
}
